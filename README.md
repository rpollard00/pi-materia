# pi-materia

pi-materia is a [Pi](https://pi.dev) extension for configurable, materia-themed agent workflows. A Materia Grid is a data-driven graph: each socket renders a reusable materia behavior, exposes a configured tool scope, optionally parses output, assigns state, and follows configured links.

The bundled default loadout is a software-development workflow, but the engine itself is generic. Materia are reusable behaviors/skills; sockets are placement adapters that decide parse mode, assignment, routing, and iteration. You can replace the grid with a single socket that says `HELLO WORLD`, or with any arbitrary sequence/loop of materia turns.

## Current status

pi-materia is early and intentionally small. The native runtime drives the active Pi session, so materia turns render with Pi's normal assistant/tool UI instead of hidden subagents. Casts persist state in the session, isolate model context per materia, write structured artifacts, stream a live status widget, track Pi-native usage where available, and expose `/materia grid`.

## Install or run

Install from npm once published:

```bash
pi install npm:@rpollard00/pi-materia
```

For local development, run the extension directly from this repo while working in a target project:

```bash
cd /path/to/target-project
pi -e /path/to/pi-materia/src/index.ts
```

## Development

This package keeps npm stability (`package-lock.json` is retained). Install dependencies with npm, and install [Bun](https://bun.sh) to run the local test suite:

```bash
npm run typecheck
npm test        # equivalent to: bun test
bun test --watch
```

Tests use a fake Pi harness and do not require provider/API access or a real Pi session.

### WebUI development scaffold

The `/materia ui` WebUI scaffold lives under `src/webui/`:

- `src/webui/client/` is a Vite + React + Tailwind app.
- `src/webui/server/` is a TypeScript Node HTTP server that serves the built client and exposes a health endpoint.

Useful commands:

```bash
npm run dev:webui          # Vite client dev server
npm run dev:webui:server   # Node server in watch mode
npm run build:webui        # build client and server into dist/webui/
npm run test:webui         # Vitest client smoke tests
npm run typecheck          # extension, client, and server type checks
```

WebUI implementation inspection notes for future `/materia ui` work live in [docs/webui-integration-notes.md](docs/webui-integration-notes.md). Manual regression coverage for the shipped UI is documented in [docs/webui-smoke-tests.md](docs/webui-smoke-tests.md). Loadout ownership, default immutability, lock/edit mode, and future guardrails are documented in [docs/loadout-ownership-locking.md](docs/loadout-ownership-locking.md). Canonical edge conditions, generator materia, loop-consumer regions, utility materia are documented in [docs/graph-semantics.md](docs/graph-semantics.md). The canonical relationship between loop exits, `consumes`, `parse`, `advance`, and ordered edges is documented in [docs/loop-semantics.md](docs/loop-semantics.md).

The shipped WebUI includes a **Quests** pane for the same project-local quest board used by `/materia quest`. Its game-like quest log sidebar lists the current active/running quest first with a star marker, then pending quests in execution order. Succeeded quests appear in a separate completed section, while failed or blocked quests stay out of the default quest log. The pane also includes a simple add form with an optional loadout override and a prompt field for appending another pending quest.

## Usage

```text
/materia grid
/materia loadout
/materia loadout Planning-Consult
/materia ui
/materia cast implement the next small feature
/materia autocast <loadout|materia:name> <prompt>
/materia link [--from <cast-id>] <target> [<target> ...] -- <prompt>
/materia quest list [pending|all|succeeded|failed] [--limit <n>]
/materia quest default-loadout [<name-or-id>|--clear]
/materia quest add [--loadout <name-or-id>] <prompt>
/materia quest move <quest-id-or-prefix> --first|--before <target>|--onto <target>
/materia quest requeue <quest-id-or-prefix>
/materia quest unblock <quest-id-or-prefix>
/materia quest unfail <quest-id-or-prefix>
/materia quest run [quest-id]
/materia quest runonce [quest-id]
/materia quest start [quest-id]
/materia quest stop
/materia recast [cast-id]
/materia revive [cast-id]
/materia casts
/materia status
/materia abort
```

pi-materia reports the config source, artifact directory, active loadout, resolved grid, live status, and end-of-run token/cost totals when available. The visible transcript stays native, but full materia prompts are hidden behind compact Materia cast messages, and each materia turn receives a curated Materia context instead of the full previous conversation.

Use `/materia autocast Full-Auto <prompt>` to start a cast with a temporary loadout selection while leaving the configured/current active loadout unchanged. Use `/materia autocast materia:Maintain <prompt>` to create an ephemeral single-materia virtual loadout for that cast only; the first non-empty token after `autocast` is the target, and the remaining text is the prompt.

Use `/materia link [--from <cast-id>] <target> [<target> ...] -- <prompt>` to immediately run an ephemeral virtual loadout composed from materia and/or loadout targets without mutating the active loadout. Previous-cast context supplied with `--from` is structured state for opt-in materia/loadouts; it is not automatic prompt injection and does not require `Chain-Context` unless you want explicit context transformation.

Illustrative linked-run examples:

```text
/materia link Planner Build -- Add a small settings page.
/materia link loadout:Planning-Consult loadout:Full-Auto -- Plan and implement the next feature.
/materia link materia:Context-Check loadout:Planning-Consult Build -- Audit, plan, then implement.
/materia link --from 2026-05-12T19-40-40-605Z Chain-Context Build -- Continue the prior cast.
/materia link --from 2026-05-12T19-40-40-605Z loadout:Full-Auto -- Continue without automatic prompt injection.
```

Unprefixed targets are allowed only when they do not collide with another materia/loadout name; use `materia:<name>` or `loadout:<name>` to disambiguate. See [link semantics](docs/link-semantics.md) for the v1 contract, detailed examples, troubleshooting, ambiguity rules, and non-goals.

Use `/materia quest` to manage a project-local quest board at `.pi/pi-materia/quest-board.json`. `quest list` shows pending quests by default (max 10) and supports `pending`, `all`, `succeeded`, and `failed` filters. `quest move` reorders pending quests with `--first`, `--before <target>`, or `--onto <target>` (`--onto` means after that target); quest references may be full IDs or unambiguous prefixes. `/materia quest requeue <quest-id-or-prefix>` sets a failed or blocked quest back to pending at the bottom of the queue so it can run again after existing pending quests; the `unblock` and `unfail` aliases do the same thing. Requeue preserves attempts and historical result/error metadata for audit history. `quest run` starts continuous back-to-back quest processing and keeps the project-local runner enabled until `quest stop`; `quest runonce` launches only one pending quest without changing the runner state, and `quest start` remains a compatibility alias for continuous `run`. Quests have a separate **quest default loadout** preference from the regular cast default: new and migrated profiles default it to `Full-Auto`, `/materia quest default-loadout --clear` explicitly clears it, and cleared or unavailable quest defaults fall back to the active loadout at launch. Per-quest `--loadout` overrides have highest precedence, apply only to the cast being launched, and do not mutate the active, regular default, or quest default loadout. See [Quest board](docs/quest-board.md) for list filters, storage, autonomy, graceful stop-after-current behavior, single-writer, and restart behavior.

Use `/materia recast [cast-id]` to resume a failed or user-aborted cast from its current socket. pi-materia also performs bounded same-socket automatic recovery for safe agent-turn failures before a socket has accepted output, applied assignments, advanced routes, or started another socket. Context-window/token-limit failures compact first, then retry the same active prompt. Other safe provider/runtime turn failures may retry by resending the same active prompt without compaction. Plain transient WebSocket transport failures preserve the awaiting state instead of immediately resending, so the current Pi turn can settle or be manually recast if needed. Utility failures and post-advance failures are not automatically retried.

Use `/materia revive [cast-id]` only when a cast failed because same-socket recovery exhausted its structured attempt allowance. Exhaustion metadata records the recovery reason (`context_window` or `turn_failure`), socket/item context, attempts, and revive allowance state for diagnostics. Revive first increases the exhausted recovery context's effective allowance by the original max-attempt value, then delegates to the normal recast path; repeated revives are additive (`original + original` each time), not exponential, and the bump is scoped to that one exhausted socket/item context. Other terminal failures are not revivable; use `/materia recast` for general failed or aborted casts.

Use `/materia ui` to explicitly start or reuse a background WebUI server scoped to the current Pi session. `/materia cast`, `/materia autocast`, `/materia link`, `/materia recast`, and `/materia revive` also start or reuse it automatically without adding WebUI messages to the LLM transcript. The current URL remains visible in the persistent `materia-webui` TUI widget, and explicit `/materia ui` also prints a clickable local URL. Browser auto-open is disabled by default and can be enabled in `~/.config/pi/pi-materia/config.json` with `{ "webui": { "autoOpenBrowser": true } }`; `preferredPort` and `host` are also supported. In the WebUI **Quests** pane, use the left quest log to inspect active and pending quests, drag pending quests by their `⋮⋮` handles to reorder them beneath any pinned active quest, review succeeded quests in the completed section, requeue selected failed/blocked quest details back to pending at the bottom of the queue, and append a new pending quest with a loadout override plus prompt. In the WebUI loadout panel, the regular default star and the quest default flag/select are separate controls.

In the WebUI loadout editor, create generator-driven loops by selecting the sockets that form a cycle with shift-click or a drag-selection box, then clicking **Create Loop**. The selected cycle must have exactly one inbound edge from a materia marked `generator: true`; generator sockets parse JSON and produce canonical `workItems`, including when one generator feeds another generator. Structured loops use normal edges for same-item flow, `advance` for cursor advancement/exhaustion detection, `loops.<id>.exits` for post-exhaustion socket routes, and terminal `end` when no exit route matches. See [Graph semantics](docs/graph-semantics.md#generator-and-loop-consumer-regions), [Loop semantics](docs/loop-semantics.md) for the configuration contract, executable loop-exit examples, and current iterator and output notes.

In the WebUI materia editor, the **Generate role prompt from brief** panel can draft prompt instructions for a prompt materia. Enter a short description of the role, choose the prompt-generation model, click **Generate**, review the generated preview, then either **Regenerate**, **Discard**, or explicitly **Apply to prompt field**. Generation calls `POST /api/generate/materia-role` from the session-scoped WebUI server and uses an isolated in-memory context, so it does not append to or mutate the active Pi chat. Existing prompt text is not overwritten until you choose Apply.

The prompt-generation model picker is separate from the materia runtime **Model** dropdown. Its default is **Active Pi Model**, which stores no `roleGeneration.model` preference and uses the current Pi session model. Choosing another available provider-qualified model persists that user preference in `~/.config/pi/pi-materia/config.json` under `roleGeneration.model` (or in `PI_MATERIA_PROFILE_DIR/config.json` when that override is set). If the saved generation model is unavailable in a later session, the WebUI shows a non-blocking warning and generation falls back to **Active Pi Model** at runtime without deleting the saved preference.

The same editor uses dropdowns for agent materia **Model** and **Thinking**. **Active Pi Model** saves no `model` override and uses the current Pi session model; **Active Pi Thinking** saves no `thinking` override and uses the current Pi thinking setting. Other model choices come from Pi's configured and credentialed model registry for the launching session. Thinking choices are derived from the selected model, or from the active Pi model when **Active Pi Model** is selected. When editing an existing materia whose saved model is no longer available, the dropdown includes only that saved value with an unavailable label so it can be preserved by saving unchanged; unavailable models are not offered as general choices for new selections. Existing saved thinking values that are not supported by the selected model can likewise be preserved only while editing that unchanged saved value.

Use `/materia loadout` to list configured graph loadouts and mark the active one. Use `/materia loadout <name>` to switch the active graph for future casts, for example `/materia loadout Planning-Consult`. Loadout names may contain hyphens.

In the WebUI, shipped default loadouts are read-only and must be duplicated before editing. User-owned duplicates can be locked/unlocked as an edit-mode toggle; locked loadouts remain useful for inspection and monitoring. Deleting a duplicate of a default removes only the user copy and falls back to the matching shipped default when available. The full ownership, locking and developer guardrail contract is documented in [docs/loadout-ownership-locking.md](docs/loadout-ownership-locking.md).

### Metrics semantics

Usage costs are reported in USD from Pi assistant-message usage metadata. When Pi provides a total cost, Materia preserves that total; otherwise it sums the available input/output/cache cost components.

Attempt counts are per exact Materia work-item identity: the socket id plus the current `foreach` item key, or a singleton key for non-`foreach` sockets. A retry/self-loop of the same socket/item increments the attempt; moving to a different `foreach` item or another socket starts at attempt 1. Socket visit counts are used for visit limits, and cast artifacts are written under `sockets/` paths.

## Configuration

pi-materia layers config from lowest to highest precedence:

1. bundled default config at `config/default.json`
2. user assets at `~/.config/pi/pi-materia/materia.json`
3. target project `.pi/pi-materia.json`
4. `MATERIA_CONFIG=/path/to/config.json`
5. `--materia-config /path/to/config.json`

The user profile directory and `~/.config/pi/pi-materia/config.json` are created on demand for WebUI/profile preferences such as `webui.autoOpenBrowser`, `webui.preferredPort`, `defaultSaveTarget`, and the prompt-generation model picker. Set `PI_MATERIA_PROFILE_DIR` to override the profile directory. Optional `roleGeneration` preferences are normalized safely before use: `enabled` (default `true`), `model`, `thinking`, `extraInstructions`, and `useReadOnlyProjectContext` (default `false`). Invalid role-generation fields are ignored with a warning. Omit `roleGeneration.model` to use **Active Pi Model** for isolated Materia role prompt generation. When present, `roleGeneration.model` should be a provider-qualified model string such as `openai-codex/gpt-5.5`; it is obsolete-safe, so unavailable saved values fall back to **Active Pi Model** at runtime and produce a warning instead of being deleted automatically.

Example profile config (`~/.config/pi/pi-materia/config.json`):

```json
{
  "webui": { "autoOpenBrowser": false, "preferredPort": 4317 },
  "defaultSaveTarget": "user",
  "roleGeneration": {
    "enabled": true,
    "model": "openai-codex/gpt-5.5",
    "thinking": "medium",
    "extraInstructions": "Prefer concise operational instructions for generated Materia roles.",
    "useReadOnlyProjectContext": false
  }
}
```

Leave `roleGeneration.model` unset to keep the **Active Pi Model** default; the WebUI model picker writes or clears only that optional profile preference and preserves other `roleGeneration` settings.

CLI config example:

```bash
pi -e /path/to/pi-materia/src/index.ts --materia-config ./my-loadout.json
```

### Tool scopes

Agent materia configure Pi tool availability with `tools`. Presets remain available:

```json
{
  "materia": {
    "Build": { "tools": "coding", "prompt": "Implement changes." },
    "Research": { "tools": "readOnly", "prompt": "Inspect files and report findings." },
    "Narrate": { "tools": "none", "prompt": "Summarize without using tools." }
  }
}
```

Use a custom allowlist for granular availability. Canonical tool names include `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`:

```json
{
  "materia": {
    "Auto-Eval": {
      "tools": { "type": "custom", "tools": ["read", "grep", "find", "ls", "bash"] },
      "prompt": "Run evaluation commands such as tests, but do not modify project files."
    }
  }
}
```

Custom allowlists are portable configuration, not a snapshot of one Pi session's registered tools. pi-materia validates the shape and tool-name syntax (`{ "type": "custom", "tools": string[] }` with non-blank names), then at runtime enables only the configured names that are currently registered by Pi. Configured names that are unavailable in the current session are preserved and reported as warnings so extension tools can be saved before or after they are installed; they are skipped until registered and never cause a fallback to broader access. An empty custom allowlist (`{ "type": "custom", "tools": [] }`) intentionally enables no tools, equivalent to the `none` preset.

New granular configs should use the custom object shape when they need a non-preset set.

`bash`/command execution is powerful: commands can write files, update lockfiles, generate caches, or otherwise mutate the project. Tool scopes are role guidance and runtime tool selection, not a hard security sandbox; prompts should explicitly tell evaluation materia not to modify files when mutation is not desired.

Minimal hello-world loadout:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Hello",
  "loadouts": {
    "Hello": {
      "entry": "hello",
      "sockets": {
        "hello": {
          "materia": "echoer",
          "edges": [{ "when": "always", "to": "end" }]
        }
      }
    }
  },
  "materia": {
    "echoer": {
      "tools": "none",
      "prompt": "Follow the prompt exactly. Say exactly: HELLO WORLD"
    }
  }
}
```

Configs can also define named `loadouts` that share the top-level `materia`, `limits`, `budget`, `compaction`, and `artifactDir`. Set `activeLoadout` to choose which graph `/materia cast` runs:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Full-Auto",
  "loadouts": {
    "Full-Auto": {
      "entry": "Socket-1",
      "sockets": {
        "Socket-1": { "materia": "Auto-Plan", "edges": [{ "when": "always", "to": "Build" }] },
        "Build": { "materia": "Build", "edges": [{ "when": "always", "to": "end" }] }
      }
    },
    "Planning-Consult": {
      "entry": "Socket-1",
      "sockets": {
        "Socket-1": { "materia": "Interactive-Plan", "edges": [{ "when": "always", "to": "Build" }] },
        "Build": { "materia": "Build", "edges": [{ "when": "always", "to": "end" }] }
      }
    }
  },
  "materia": {
    "Auto-Plan": { "tools": "readOnly", "prompt": "Plan automatically." },
    "Interactive-Plan": { "tools": "readOnly", "multiTurn": true, "prompt": "Collaborate, then finalize only after /materia continue." },
    "Build": { "tools": "coding", "prompt": "Implement exactly the adapter-provided current workItem." }
  }
}
```

When switching with `/materia loadout <name>`, pi-materia persists only the `activeLoadout` override to the active writable config path: the explicit `--materia-config`/`MATERIA_CONFIG` file when one is used, otherwise the target project's `.pi/pi-materia.json`. If you are using the bundled defaults, switching creates or updates `.pi/pi-materia.json`; it does not modify `config/default.json`. WebUI saves default to the user asset store at `~/.config/pi/pi-materia/materia.json` and only write `.pi/pi-materia.json` when the UI explicitly requests project scope.

### Proactive compaction thresholds

By default, pi-materia proactively compacts at 75% for context windows below 128k tokens, 65% for 128k through 199,999 tokens, and 55% for 200k tokens and above. Threshold resolution uses the active/effective Pi model context window; if model/context-window metadata is missing or invalid, pi-materia falls back to the conservative 55% threshold to compact earlier and reduce provider-side context-window failures. You can override this with a backward-compatible single percentage:

```json
{ "compaction": { "proactiveThresholdPercent": 60 } }
```

If `proactiveThresholdPercent` is present, it takes precedence even if tiered thresholds are also present (useful for layered config overrides). Or configure ordered min-inclusive/max-exclusive tiers. Tiers must start at `0`, have no gaps or overlaps, and the final tier must omit `maxContextWindow`:

```json
{
  "compaction": {
    "proactiveThresholdTiers": [
      { "id": "small", "minContextWindow": 0, "maxContextWindow": 128000, "thresholdPercent": 70 },
      { "id": "medium", "minContextWindow": 128000, "maxContextWindow": 200000, "thresholdPercent": 60 },
      { "id": "large", "minContextWindow": 200000, "thresholdPercent": 50 }
    ]
  }
}
```

### Per-materia model and thinking settings

Materia configs may optionally set `model` and `thinking` alongside `tools` and `prompt`. If a materia omits `model`, pi-materia does not switch models for that turn; it preserves Pi's currently active model as the default behavior. If a materia omits `thinking`, pi-materia likewise preserves Pi's active thinking level. In the WebUI editor these defaults are the **Active Pi Model** and **Active Pi Thinking** dropdown entries, and selecting them leaves the corresponding config field unset rather than saving the display label.

Use `provider/model-id` (or an unambiguous model id from Pi's configured and credentialed model registry) for `model`. Supported `thinking` strings are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh` when the active Pi runtime/provider and selected model support thinking controls.

Example loadout excerpt where planning and evaluator materia use a cheaper model, while Build uses a stronger coding model:

```json
{
  "materia": {
    "Auto-Plan": {
      "tools": "readOnly",
      "model": "openai/gpt-4o-mini",
      "thinking": "low",
      "prompt": "Return compact JSON with a concise summary and ordered workItems."
    },
    "Build": {
      "tools": "coding",
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "high",
      "prompt": "Implement exactly the adapter-provided current workItem."
    },
    "Auto-Eval": {
      "tools": { "type": "custom", "tools": ["read", "grep", "find", "ls", "bash"] },
      "model": "openai/gpt-4o-mini",
      "thinking": "medium",
      "prompt": "Verify the current workItem strictly. Bash is available for evaluation commands such as running tests; do not use it to modify project files."
    },
    "Maintain": {
      "tools": "coding",
      "prompt": "Checkpoint accepted work."
    }
  }
}
```

In this example, `Maintain` intentionally has no `model` or `thinking`, so it falls back to whatever model and thinking level are active in Pi at that point. The bundled default loadouts leave materia model-free, so installing pi-materia does not pin or override your active Pi model.

Run `/materia grid` to verify the resolved materia settings before casting. Agent slots show `model=<configured value>` and `thinking=<configured value>` for explicit settings, or labels such as `model=active Pi model` and `thinking=active Pi thinking` for fallback materia.

Provider/runtime limitations: explicit model switching requires Pi's runtime to expose model switching and the requested model must exist in Pi's registry with usable credentials. Explicit thinking requires Pi's runtime to expose thinking-level controls, and individual providers/models may ignore or map levels differently. If a configured model is unknown, unavailable, or cannot be used because credentials are missing or unauthorized, pi-materia shows a warning naming that configured model and continues the cast with the active Pi session model. If configured thinking is unsupported by the effective model, pi-materia falls back to the active or nearest safe supported thinking setting and warns or records the fallback where possible. Runtime usage/events may record the requested model/thinking, effective model/thinking, and fallback reason when Pi exposes enough metadata.

Generic socket mechanics:

- `materia`: named top-level materia assigned to an agent socket
- `parse`: `"text"` or `"json"`; JSON-parsed socket outputs are compact payloads that follow socket-specific requirements from the canonical [materia handoff JSON contract](docs/handoff-contract.md)
- `assign`: copy parsed output/state values into generic cast state
- `edges`: ordered condition-driven links using canonical conditions such as `satisfied`, `not_satisfied`, or `always`; runtime selects the first edge whose guard matches, so repeated guarded predicates are allowed, while edges after an unconditional edge are invalid because they are unreachable. The WebUI's **Flow** label is the `always` condition, not a separate edge model.
- `foreach`: iterate a socket over an array in state
- `advance`: advance a configured cursor
- `limits`: socket/edge cycle safety

Materia graphs are workflow state machines, not DAGs. Loops such as `Socket-4 (Build) -> Socket-5 (Auto-Eval) -> Socket-6 (Maintain) -> Socket-4 (Build)` are valid and model repeated work-item sections/retry paths; runtime socket-visit and edge-traversal limits bound execution instead of config validation rejecting cycles. Prefer declaring a top-level Generator materia with `generator: true`, wiring its JSON socket with `parse: "json"` and an assign entry for the canonical handoff path (`"workItems": "$.workItems"`), then adding a loadout-level `loops` region with `consumes: { from, output: "workItems" }`. pi-materia derives the loop consumer iterator path from the canonical Generator config (`state.workItems`) instead of tagging arbitrary loop members as iterators. Generated units of work intentionally use `workItems`; pi-materia does not emit a `tasks` output for new generated work units. See [docs/handoff-contract.md](docs/handoff-contract.md), [docs/graph-semantics.md](docs/graph-semantics.md), and [examples/graph-semantics-loadout.json](examples/graph-semantics-loadout.json).

Top-level materia define agent capabilities and behavior with `tools`, `prompt`, optional `model`, optional `thinking`, optional `multiTurn`, and optional `generator: true` for list-producing Generator materia. The bundled Auto-Eval default uses a custom tool allowlist for read-oriented tools plus `bash` so it can run evaluation commands such as tests without edit/write tools; bash can still mutate files, so prompts should direct it not to modify project files. Set `"multiTurn": true` on a materia to let any agent socket using that materia pause for interactive refinement until the user runs `/materia continue`.

### Multi-turn planning materia

Agent sockets are single-turn by default: after the assistant responds, pi-materia parses/assigns the output and follows edges automatically. Add `"multiTurn": true` to an agent materia when you want sockets using that materia to run a manual refinement loop. A multi-turn materia records each assistant response as a refinement artifact, keeps the cast active at the current socket, and treats ordinary user replies as refinement instructions instead of finalization.

Examples of refinement replies that do **not** finalize or advance the socket:

- `Let's do a full CRT-inspired shader with phosphor glow.`
- `Add rollback steps before we continue.`
- `Can you split the bootstrap work into its own work item?`
- `Continue refining the risk section.`

Natural-language replies never finalize or advance the socket, even when they say things like `ready to continue`, `looks good, proceed`, or `finalize`. When the latest draft is ready, run `/materia continue`; this command is the only supported way to finalize a paused multi-turn socket.

Only after `/materia continue` does pi-materia request the final assistant output and process it using the socket's normal `parse`, `assign`, and `edges` behavior. For JSON-parsed multi-turn sockets, refinement turns should stay conversational: the agent should not emit final structured JSON, and pi-materia should not parse final JSON, until the command-triggered finalization turn.

The bundled config wires the `Interactive-Plan` materia, which has `multiTurn: true`, into the `Planning-Consult` loadout. To customize that behavior, create a project `.pi/pi-materia.json` or pass `--materia-config` with named `loadouts` and `activeLoadout` like this excerpt:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Custom",
  "loadouts": {
    "Custom": {
      "entry": "ignoreArtifacts",
      "sockets": {
        "ignoreArtifacts": {
          "materia": "Ignore-Artifacts",
          "edges": [{ "when": "always", "to": "detectRepository" }]
        },
        "detectRepository": {
          "materia": "Detect-VCS",
          "edges": [{ "when": "always", "to": "Socket-3" }]
        },
        "Socket-3": {
          "materia": "Interactive-Plan",
          "parse": "json",
          "assign": { "workItems": "$.workItems", "guidance": "$.guidance" },
          "edges": [{ "when": "always", "to": "Build" }]
        },
        "Build": { "materia": "Build", "foreach": { "items": "state.workItems", "as": "workItem", "cursor": "workItemIndex", "done": "end" }, "edges": [{ "when": "always", "to": "end" }] }
      }
    }
  },
  "materia": {
    "Ignore-Artifacts": { "type": "utility", "script": { "kind": "shippedUtility", "name": "ensure-ignored.mjs", "runtime": "node" }, "parse": "json", "params": { "patterns": [".pi/pi-materia/"] }, "assign": { "artifactIgnore": "$" } },
    "Detect-VCS": { "type": "utility", "script": { "kind": "shippedUtility", "name": "detect-vcs.mjs", "runtime": "node" }, "parse": "json", "assign": { "vcs": "$" } },
    "Interactive-Plan": { "tools": "readOnly", "multiTurn": true, "prompt": "Collaboratively refine an implementation plan for this request. Do not emit final JSON during refinement. Only after the user runs /materia continue, return compact JSON with a concise summary and generated workItems. Request: {{request}}" },
    "Build": { "tools": "coding", "prompt": "Implement exactly the assigned workItem using adapter-provided guidance." }
  }
}
```

For deterministic local steps that should run without an LLM turn, use utility materia. A utility socket is canonical when it references a top-level utility materia by `materia`; the utility materia owns its label/color plus `command` or typed shipped `script`, `params`, `parse`, `assign`, and `timeoutMs`. Command utilities receive JSON on stdin, write the machine-readable result on stdout, write diagnostics on stderr, and run with the target project as cwd. Bundled defaults use `{ "kind": "shippedUtility" }` script references that are synced from package assets into the active profile utilities directory (`${XDG_CONFIG_HOME:-~/.config}/pi/pi-materia/utilities` or `PI_MATERIA_PROFILE_DIR/utilities`) with a hash manifest so user-modified profile scripts are not overwritten; explicit relative command paths from user/project config are still resolved from the config file that defined the utility materia. Utility JSON output participates in normal `assign`, `always`/`satisfied`/`not_satisfied` routing, and generator materia marked `generator: true` can emit compact JSON with top-level `workItems` for loops. See [Utility Materia](docs/utility-materia.md) for the full contract, default scripts, examples, security notes, and current configuration guidance.

Runtime artifacts are written to `.pi/pi-materia/<timestamp>/` by default. Override with:

```json
{
  "artifactDir": ".pi/my-materia-runs"
}
```

Budget limits can be configured:

```json
{
  "budget": {
    "maxTokens": 200000,
    "maxCostUsd": 5,
    "warnAtPercent": 75,
    "stopAtLimit": true
  }
}
```

## Artifacts

Each cast writes enough information to debug the run after the fact:

```text
.pi/pi-materia/<cast-id>/
  config.resolved.json
  events.jsonl
  usage.json       # token totals and USD cost totals/breakdowns from Pi usage metadata
  manifest.json
  sockets/<socket-id>/<visit>.md       # canonical socket output artifact
  sockets/<socket-id>/<visit>.json
  contexts/<socket-id>-<visit>.md
```

## Default loadouts

The bundled defaults live at `config/default.json` and set `activeLoadout` to `Full-Auto`.

- `Full-Auto`: the autonomous software-development workflow. The `Auto-Plan` materia immediately produces compact JSON with structured `workItems` from the initial request, then `Build`, `Auto-Eval`, and `Maintain` iterate through implementation, verification, and checkpointing.
- `Planning-Consult`: the conversational planning workflow. The planning socket uses the `Interactive-Plan` materia with `multiTurn: true`, so it starts with normal discussion instead of immediate work-item JSON: it can summarize the request, ask clarifying questions, propose a breakdown, and refine scope or acceptance criteria with you before implementation begins.
- `Hojo-Consult`: a consultative workflow that starts with the same deterministic utility setup/discovery sockets, then combines interactive planning with architecture guidance before entering the Build/Eval/Maintain loop.

When using `Planning-Consult`, reply naturally during the planning loop with corrections, answers, tradeoffs, or requested changes such as "add a CRT shader requirement" or "split testing into a separate work item"; these refinement messages do not finalize. Once the plan looks right, run `/materia continue`. pi-materia then asks for the final compact JSON plan, parses the socket-relevant fields such as `summary`, `workItems`, and optional guidance, merges them into canonical runtime state, and advances to the automated `Build`/`Auto-Eval`/`Maintain` execution loop. JSON output and parsing are intentionally deferred until that command-triggered finalization step.

These loadouts are defined entirely as config using top-level reusable materia prompts and utility materia plus socket adapters for JSON parsing, state assignment, conditional edges, foreach cursors, and named Materia assignments. Bundled default socket ids are sequential (`Socket-1` through `Socket-8`); reusable behavior and appearance stay in top-level materia definitions referenced by socket `materia` fields, while displays can add context like `Socket-4 (Build)`. The first two bundled sockets reference the command-backed utility materia `Ignore-Artifacts` and `Detect-VCS`; Loadout config and WebUI save payloads use canonical `sockets` collections for loadout membership and loop membership. Use `/materia loadout` to see which one is active and `/materia loadout Full-Auto` or `/materia loadout Planning-Consult` to switch.

### Socket terminology

Socket terminology is now canonical across config, runtime state, monitor payloads, events, manifests, and artifacts. Current configs must use `sockets` for loadout and loop membership, runtime state uses fields such as `currentSocketId`, `socketState`, `bySocket`, and `socketId`, events use `socket_start`/`socket_complete`, same-socket recovery uses `same_socket_recovery_exhausted`, and new output artifacts are written under `sockets/` with `socket_output`/`socket_refinement` manifest kinds. Pre-socket aliases and old artifact directory names are intentionally no longer part of the active contract; migrate old configs and tooling to these socket field/path names before running current pi-materia.
