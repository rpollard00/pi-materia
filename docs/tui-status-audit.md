# pi-materia TUI status and panel audit

This audit identifies the current pi-materia-owned render paths for the compact status badge and below-editor widgets. It intentionally does not change runtime behavior; it is a source map for the follow-up render-model/layout refactor.

## Current render paths

### Compact status badge

- `src/native.ts` — `materiaStatusLabel(state, node?, options?)` builds the value passed to Pi's compact extension status API.
  - Sources: `nodeMateriaName(node)`, `state.currentMateria`, `node.id`, `state.currentNode`, `state.phase`, optional suffix, and optional `state.currentItemLabel`.
  - Call sites:
    - `src/index.ts` session restore: `ctx.ui.setStatus("materia", materiaStatusLabel(state))`.
    - `src/native.ts` node start / recast / refinement paths: `ctx.ui.setStatus("materia", materiaStatusLabel(...))`.
    - `src/native.ts` failure/completion paths: `ctx.ui.setStatus("materia", "failed" | "done")`.
    - `src/index.ts` abort/start-failure paths: clears or sets `ctx.ui.setStatus("materia", undefined | "failed")`.

### Main pi-materia below-editor widget

- `src/ui.ts` — `renderMateriaRunWidget(state, now?)` renders the basic three-line widget from `MateriaRunState`.
  - Line 1: cast id, loadout, attempt, elapsed, usage.
  - Line 2: task and current materia.
  - Line 3: last message.
- `src/ui.ts` — `renderConfiguredLoadoutWidget(loadoutName)` renders the no-active-cast/configured state.
  - Line 1: `configured`, active loadout, placeholder attempt/elapsed/usage.
  - Line 2: `active loadout` and `no active cast`.
  - Line 3: readiness text.
- `src/ui.ts` — `renderMateriaCastStatusWidget(state, now?)` renders the richer active/resumed cast state by reusing the first two lines of `renderMateriaRunWidget(state.runState)` and replacing line 3 with cast-state status.
- Widget call sites:
  - `src/ui.ts` `updateWidget(...)` sets widget key `materia` with `renderMateriaRunWidget(...)` and starts the ticker.
  - `src/ui.ts` `syncConfiguredLoadoutWidget(...)` sets widget key `materia` with `renderMateriaRunWidget(...)` or `renderConfiguredLoadoutWidget(...)`.
  - `src/ui.ts` ticker refresh sets widget key `materia` with `renderMateriaRunWidget(...)`.
  - `src/index.ts` `/materia status` sets widget key `materia` with `renderMateriaCastStatusWidget(...)`.

### Loadout below-editor widget

- `src/loadouts.ts` — `renderLoadoutList(config, source)` renders a separate loadout list.
  - Lines currently include `Loadout: ...` and `Available: ...`.
- Call sites:
  - `src/index.ts` `/materia loadout` with no argument sends the rendered list as a displayed pi-materia message.
  - `src/activeLoadoutEvents.ts` `publishActiveLoadoutChange(...)` sets widget key `materia-loadouts` with the same rendered list, sends it as a displayed message, and appends it to history.

### Other pi-materia below-editor widgets/messages

These are separate command/summary panels rather than the permanent cast status panel, but they also construct below-editor content directly:

- `src/ui.ts` `showUsageSummary(...)` sets widget key `materia-usage` with `renderCompactUsageWidget(...)`.
- `src/index.ts` `/materia status`, `/materia casts`, `/materia grid`, `/materia ui`, and `/materia loadout` build or render lines and send displayed pi-materia messages.
- `src/index.ts` `renderCastList(...)` and `renderCastSummaryLines(...)` construct cast-list panel/message lines.
- `src/pipeline.ts` `renderGrid(...)` constructs grid panel/message lines.
- `src/ui.ts` `clearMateriaAuxiliaryWidgets(...)` clears auxiliary widget keys: `materia-webui`, `materia-loadouts`, `materia-status`, `materia-casts`, `materia-usage`, `materia-grid`.

## Field ownership and sources

### Pi host-owned status in the user's sample

The directory, VCS detached indicator, model/provider/thinking, cost, token totals/context-window, and other global session/account telemetry are provided by Pi's host TUI status line, not by pi-materia's `renderMateriaRunWidget`/`renderMateriaCastStatusWidget`. pi-materia should not duplicate these unless a segment adds distinct materia-specific meaning.

### pi-materia-owned fields from `MateriaRunState`

Available to the basic renderer in `src/ui.ts`:

- Cast id/name: `runId`, displayed via `shortCastId(...)`; timestamp-like ids are made prominent today.
- Loadout: `loadoutName`.
- Attempt/turn-ish counter: `attempt` from task attempts, not loop current/total.
- Elapsed: `startedAt` and optional `endedAt`.
- Usage: `usage.tokens.input/cacheRead/output/cacheWrite`.
- Current node/materia: `currentNode`, `currentMateria`.
- Task/cast label: `currentTask` currently mirrors `currentItemLabel` when set; otherwise falls back to `-`.
- Status/message: `lastMessage`.
- Model selection exists as `currentMateriaModel`, but the current widget does not render it.

`MateriaRunState` does not contain the resolved pipeline, loop definitions, cursor totals, request/cast title, cast phase/node state, or full active/resumed cast metadata needed to render `Build -> [Auto-Eval] -> Maintain` or current/total loop turns safely.

### pi-materia-owned fields only available from richer `MateriaCastState`

Available to `renderMateriaCastStatusWidget(state)` and follow-up richer render work:

- Request/task title: `request`.
- Cast lifecycle: `active`, `phase`, `awaitingResponse`, `nodeState`, `failedReason`.
- Current graph position: `currentNode`, `currentMateria`, `currentItemKey`, `currentItemLabel`.
- Loop/progress data: `pipeline`, `pipeline.loops`, `cursors`, `visits`, `taskAttempts`, `edgeTraversals`, `data`, `lastJson`.
- Paths/artifacts: `cwd`, `runDir`, `artifactRoot`, `configSource`.
- Run-state fallback: embedded `runState`.

This richer state is the appropriate source for loop-aware display and active pipeline-position display. The current `renderMateriaCastStatusWidget(...)` only uses a small subset: it reuses `runState`, overlays `currentNode/currentMateria`, derives `nodeState`, and renders a one-line status message.

## Duplicate or low-value display currently observed

- `Loadout: ...` in `src/loadouts.ts` duplicates the compact loadout already shown in the main `materia` widget (`⌘ ...`) and in the configured widget.
- `Available: ...` in `src/loadouts.ts` is low-value as persistent panel content after a loadout change; it is more appropriate for an explicit `/materia loadout` query or WebUI/config inspection.
- The cast id displayed by `shortCastId(runId)` is a timestamp-derived value and occupies the first/most stable field despite often being less useful than the request/current item.
- The current materia can repeat between Pi's compact `ctx.ui.setStatus("materia", ...)` badge and the below-editor `◉ ...` field.
- The active/current item can repeat as a status badge suffix, `◆` task field, and `›` message depending on state.
- Usage in the pi-materia widget (`Σ input/output`) can overlap with Pi host token/context telemetry. It is pi-materia-owned per-cast usage, but should be clearly treated as distinct from host totals if kept.
- Model/provider/thinking and directory shown in the user's sample are host-owned Pi status fields; pi-materia should avoid adding parallel permanent fields for them.

## Suggested central render seam for follow-up work

The practical seam is `src/ui.ts`: both `renderMateriaRunWidget(...)` and `renderMateriaCastStatusWidget(...)` already converge there, and all main `materia` widget updates route through `updateWidget(...)`, `syncConfiguredLoadoutWidget(...)`, the ticker, or `/materia status`.

For the loadout bloat, `src/loadouts.ts` and `src/activeLoadoutEvents.ts` are the separate seam: persistent `materia-loadouts` content should be reduced or routed through the same display policy so future changes do not reintroduce redundant `Loadout:`/`Available:` lines.
