# pi-materia WebUI integration notes

This document records the inspection work for adding `/materia ui` without changing the current native runtime behavior.

## Pi native extension integration points read

Relevant Pi documentation/examples reviewed before implementation:

- `docs/extensions.md` completely, including `registerCommand`, lifecycle events, session events, agent/message/tool events, `ctx.sessionManager`, `ctx.waitForIdle()`, `pi.sendMessage()`, `pi.appendEntry()`, `pi.events`, and `ctx.ui.notify()/setWidget()/setStatus()`.
- `docs/session-format.md` sections covering session file location, session entries, tree/branch semantics, and `SessionManager` APIs.
- Extension examples: `commands.ts`, `file-trigger.ts`, `event-bus.ts`, and `bash-spawn-hook.ts`.
- Grep of Pi docs/examples/dist type declarations for browser/open-url helpers found OAuth URL display and terminal hyperlink references, but no general exported browser-opening or hyperlink helper for extensions.

Preferred Pi-native pieces for `/materia ui`:

- Register as a subcommand inside the existing `pi.registerCommand("materia", ...)` handler (`/materia ui`) rather than creating a conflicting top-level command.
- Use `await ctx.waitForIdle()` at command entry, as the existing command already does, so the UI launch does not interleave with a streaming turn.
- Scope server state from `ctx.sessionManager.getSessionFile()`, `ctx.sessionManager.getSessionId()` when needed, `ctx.cwd`, and the current branch from `ctx.sessionManager.getBranch()`.
- Use Pi event hooks already used by pi-materia plus additional events for monitoring: `session_start`, `session_shutdown`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`.
- Use `pi.appendEntry()` only for small session-scoped metadata such as "UI server started at URL". Do not store large WebUI state in the session file.
- Use `ctx.ui.notify()` and/or a displayed `pi.sendMessage({ customType: "pi-materia", ... })` with the raw `http://127.0.0.1:<port>/...` URL so terminals that support link detection expose it as clickable. Since no generic Pi browser-opening helper was found, browser auto-open should be implemented later as a safe Node fallback (`open` on macOS, `xdg-open` on Linux, `cmd /c start` on Windows, `termux-open-url` on Termux), gated by user config.

## Existing schema and runtime behavior to preserve

### Config loading

Current `src/config.ts` precedence is:

1. explicit `--materia-config` flag path, supplied via `getConfiguredConfigPath(pi)`;
2. `MATERIA_CONFIG` env var, also supplied through `getConfiguredConfigPath(pi)`;
3. project `.pi/pi-materia.json`;
4. bundled `config/default.json`.

`loadConfig()` merges parsed config over bundled defaults. Materia graphs are configured through named `loadouts`; `activeLoadout` selects the loadout to run. Named loadouts share top-level `materia`, `limits`, `budget`, `compaction`, and `artifactDir`. `saveActiveLoadout()` currently writes only `{ activeLoadout }` plus existing file fields to the explicit/project writable config path; it intentionally does not rewrite bundled defaults.

### Loadouts and materia slots

Important TypeScript interfaces are in `src/types.ts`:

- `PiMateriaConfig`: `artifactDir`, `budget`, `limits`, `compaction`, named `loadouts`, `activeLoadout`, and top-level `materia`.
- `MateriaPipelineConfig`: `{ entry, nodes }`.
- `MateriaPipelineNodeConfig`: agent or utility node.
- `MateriaAgentNodeConfig`: `type: "agent"`, `materia`, plus common routing fields.
- `MateriaUtilityNodeConfig`: `type: "utility"`, `utility` or `command`, optional `params` and `timeoutMs`, plus common routing fields.
- Common routing/editable graph fields: `parse`, `assign`, `next`, `edges`, `foreach`, `advance`, and `limits`.
- `MateriaEdgeConfig`: `when`, `to`, `maxTraversals`.
- `MateriaConfig`: `tools`, `prompt`, optional `model`, optional `thinking`, and optional `multiTurn`.

`src/pipeline.ts` resolves the active loadout with `getEffectivePipelineConfig()` and validates target links. `renderGrid()` is the current textual visualization and should remain a regression oracle for the WebUI graph.

### Runtime/session state

The active cast is session-scoped through custom session entries with custom type `pi-materia-cast-state` in `src/native.ts`. `loadActiveCastState(ctx)` reads only `ctx.sessionManager.getBranch()`, so it intentionally follows the current Pi session branch and does not aggregate across other Pi sessions. `/materia ui` should use that same branch-scoped source of truth.

`MateriaCastState` includes `castId`, `cwd`, `runDir`, `artifactRoot`, current node/materia/item fields, `nodeState`, `awaitingResponse`, `visits`, `cursors`, `taskAttempts`, `edgeTraversals`, `lastOutput`, `lastJson`, `runState`, and the resolved `pipeline` snapshot. The WebUI monitor can read this state through a session-scoped in-memory bridge and through artifact files.

### Artifact paths

Default artifact root is `.pi/pi-materia`, via `resolveArtifactRoot(cwd, config.artifactDir)`. Each cast creates:

```text
.pi/pi-materia/<cast-id>/
  config.resolved.json
  events.jsonl
  usage.json
  manifest.json
  nodes/<node-id>/<visit>.md
  nodes/<node-id>/<visit>.json
  nodes/<node-id>/<visit>.refinement-<n>-<entry>.md
  nodes/<node-id>/<visit>.command.stdout.txt
  nodes/<node-id>/<visit>.command.stderr.txt
  nodes/<node-id>/<visit>.command.json
  nodes/<node-id>/<visit>.input.json
  contexts/<node-id>-<visit>.md
```

`events.jsonl` receives `cast_start`, `node_start`, `materia_model_settings`, `utility_input`, `utility_command`, `node_refinement`, `context_refinement`, `node_complete`, and `cast_end`. `manifest.json` collates artifacts with node, materia, item, visit, kind, refinement/finalization flags, and timestamps.

## WebUI implementation plan constraints

- Start/reuse one background server per launching Pi session. The key should include the session file path or session id plus `ctx.cwd`, not only the project cwd, to avoid cross-session aggregation.
- Keep the server non-blocking. Starting it from `/materia ui` should return after notifying/printing the URL.
- Close or mark stale session-scoped bridges on `session_shutdown` for `quit`, `reload`, `new`, `resume`, and `fork`.
- Preserve current native cast mechanics. WebUI edits should stage JSON patches client-side and write config only through explicit user actions.
- Do not mutate `MateriaCastState.pipeline` for an already-running cast when editing config; that snapshot is the current run contract.
- For monitoring, emit live event snapshots from Pi hooks to the session-scoped server and fall back to polling `events.jsonl`, `usage.json`, and `manifest.json` in `state.runDir`.
- Use displayed URLs as clickable hyperlinks. Browser auto-open must be opt-in/configurable because no Pi-native general open-browser helper was found.

## Regression coverage required before graph/loadout editing

The existing tests already cover loadout resolution, config precedence among explicit/project/default for current behavior, materia-level `multiTurn`, utility nodes, branch edges, foreach/advance retry loops, and native cast state reconstruction. Add focused WebUI/editor tests before changing graph mutation logic:

- Inserting a node between `A -> B` preserves `A` and `B` node objects and changes only `A.next` (or the selected edge target) plus the new node.
- Inserting into an edge preserves the original `when`/`maxTraversals` on the edge moved to the new node or otherwise matches an explicitly documented rule.
- Adding satisfied/not-satisfied branches emits standard `edges` entries using canonical condition syntax: `when: "satisfied"` and `when: "not_satisfied"`. The routed handoff payload uses `satisfied` as the canonical boolean control field; legacy aliases such as `passed` must not be emitted as routing fields.
- Editing retry behavior changes only `maxTraversals` on the chosen edge or `limits.maxVisits`/`limits.maxEdgeTraversals` on the chosen node.
- Layout metadata, when introduced, must be stored separately from runtime routing fields so existing configs without layout continue to resolve and render identically.
- Loadout insert/remove/swap operations must not rewrite top-level materia definitions or unrelated loadouts and must keep current `saveActiveLoadout()` minimal-active-loadout behavior intact until explicit project/user persistence is implemented.
