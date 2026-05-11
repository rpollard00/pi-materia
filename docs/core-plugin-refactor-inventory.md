# Core plugin refactor inventory

Status: inventory only; no production behavior moved in this stage.

Baseline validation recorded on 2026-05-10:

- `npm run typecheck`: pass (`tsc --noEmit`, WebUI client `tsc`, WebUI server `tsc`).
- `npm test`: pass (Bun test, 308 pass / 0 fail across 34 files).

## Scope boundary

This refactor should target the core plugin/materia-loadout runtime. The recently refactored WebUI is out of scope except for preserving integration contracts and DTOs consumed by WebUI APIs, monitor snapshots, config save/load, and active-loadout changes.

Current WebUI touch points to preserve:

- `src/index.ts` launches/closes the WebUI through `src/webui/launcher.ts` for `/materia ui` and session shutdown.
- `src/webui/launcher.ts` calls core functions from `native.ts`, `config.ts`, `activeLoadoutEvents.ts`, and `roleGeneration.ts` to expose session snapshots, config persistence, active-loadout mutation, and role generation.
- WebUI client code imports shared graph/config helpers (`loadoutGraphAnalysis.ts`, `loadoutNormalization.ts`, `loopSemantics.ts`, `socketIds.ts`, `graphValidation.ts`, `types.ts`) to keep editor validation aligned with runtime. These shared DTOs/helpers should remain stable or be bridged during core extraction.

## Current core plugin entrypoints and flows

### Plugin composition and commands

`src/index.ts` is the extension entrypoint registered by `package.json` (`pi.extensions`). It currently mixes plugin integration, command dispatch, cast listing, and some artifact inspection.

Registered plugin hooks:

- `context`: loads active cast state and replaces visible conversation context with `buildIsolatedMateriaContext(...)` while a cast is active/paused.
- `before_agent_start`: handles paused multi-turn refinement setup, then appends active materia system prompt via `activeMateriaSystemPrompt(...)`.
- `agent_end`: delegates response processing to `handleAgentEnd(...)`.
- `session_start`: restores active cast status/widgets from session state.
- `session_shutdown`: clears widget ticker and closes WebUI session.

Registered command: `/materia` with subcommands:

- `ui`: launch/reuse WebUI, emit session event.
- `grid`: load config, resolve active loadout pipeline, render graph/loadout summary.
- `loadout [name]`: list or persist active loadout; blocks changes during active casts.
- `casts`: inspect artifact root and session states to render cast summaries.
- `status`: render active/latest cast status widget.
- `abort`: mark active cast failed/aborted and update UI.
- `continue`: finalize or continue paused/runnable cast state.
- `recast [cast-id]`: resume newest or specified failed/aborted cast.
- `revive [cast-id]`: extend same-socket recovery allowance for eligible exhausted casts, then resume.
- `cast <request>`: load config, resolve active loadout, start native cast.

### Cast lifecycle and runtime orchestration

`src/native.ts` is the current core runtime/god module. It coordinates Pi APIs, filesystem artifacts, prompt assembly, schema validation, routing, usage, widgets, recovery, and utility execution.

Primary lifecycle:

1. `/materia cast` loads config (`loadConfig`) and resolves pipeline (`resolvePipeline`).
2. `startNativeCast` creates artifact directories, writes `config.resolved.json`, `manifest.json`, `usage.json`, and `events.jsonl`, appends session state, updates UI, then starts the entry socket.
3. `startSocket` sets current socket/socket state, records socket_start, checks limits, selects current loop item, then either:
   - executes a utility socket locally and completes it, or
   - applies model/tool settings and sends an isolated agent prompt.
4. `sendMateriaTurn` stores the hidden prompt, may compact proactively, writes a context artifact, emits visible and hidden Pi messages, and triggers the Pi agent turn.
5. `handleAgentEnd` finds the latest assistant response, captures usage, handles transport/context-window recovery, pauses multi-turn sockets for refinement, or completes the socket.
6. `completeSocket` records socket output artifacts, parses/validates JSON handoff if requested, updates generic envelope and assignments, applies loop advancement, enforces budget, chooses next route, and advances/finishes.
7. `advanceToSocket` starts the next socket or `finishCast` writes terminal artifacts/events/state and UI updates.
8. `resumeNativeCast`/`reviveNativeCast` rehydrate latest persisted session state and continue from the failed current socket.

### Persistence and artifact paths

Config persistence/loading:

- `src/config.ts` loads layered config from bundled `config/default.json`, user profile asset (`~/.config/pi/pi-materia/materia.json` or `PI_MATERIA_PROFILE_DIR`), project config (`.pi/pi-materia.json`), and optional explicit path from flag/env.
- `saveMateriaConfigPatch` writes JSON patches to user/project/explicit targets.
- `saveActiveLoadout` writes minimal `activeLoadout` to project or explicit config.
- Load/save paths normalize loadouts and validate graph semantics before runtime.

Cast/session persistence:

- Active/latest cast state is persisted as Pi session custom entries with custom type `pi-materia-cast-state` (`saveCastState`, `loadActiveCastState`, `listLatestCastStates`).
- Artifact root defaults to `.pi/pi-materia` (`resolveArtifactRoot`).
- Each cast run directory contains:
  - `config.resolved.json`: resolved runtime config snapshot.
  - `manifest.json`: cast request plus artifact entries.
  - `events.jsonl`: runtime event stream.
  - `usage.json`: usage totals/model selections.
  - `sockets/<socket>/<visit...>.md|.json|.input.json|.command.*`: socket/utility outputs and command artifacts.
  - `contexts/<socket...>.md`: isolated hidden prompt/context artifacts.

### Prompt and handoff paths

- Handoff contract source is `src/handoffContract.ts`; validation is in `src/handoffValidation.ts`.
- Prompt assembly currently lives in `native.ts` (`buildSocketPrompt`, `buildMultiTurnFinalizationPrompt`, `activeMateriaSystemPrompt`, `buildSyntheticCastContext`, `materiaPrompt`, template rendering).
- JSON sockets receive the canonical handoff contract final instruction; multi-turn JSON sockets receive it only on `/materia continue` finalization.
- Text/build sockets receive adapter context containing current work item and global guidance.
- Generator sockets receive adapter context requiring canonical `workItems`; legacy `tasks`/custom generated aliases are not active runtime outputs.

### Assignment, routing, and loop flows

- Assignment is configured per socket with `assign` paths and executed by `applyAssignments` using JSON/path helpers in `native.ts`.
- Generic handoff envelope fields are captured into `state.data.envelope`, `state.data.workItems`, `state.data.guidance`, `state.data.summary`, `state.data.decisions`, and `state.data.risks`.
- Routing uses ordered canonical outgoing edges from `graphValidation.canonicalOutgoingEdges`; `always`, `satisfied`, and `not_satisfied` are evaluated against the canonical JSON `satisfied` field.
- Loop advancement uses `advance` and `loops` metadata; `loopIteratorForNode`, `resolveLoopExitRoute`, and current cursor state determine current work item and exit targets.
- Visit and edge traversal limits are enforced at runtime from loadout/global limits.

## Materia/loadout concepts currently represented

Primary types in `src/types.ts`:

- `PiMateriaConfig`: artifact/budget/limits/compaction, reusable `materia`, named `loadouts`, `activeLoadout`.
- `MateriaConfig`: reusable agent or utility behavior definition.
- `MateriaPipelineConfig`: active loadout graph with `entry`, `sockets`, `layout`, and `loops`.
- `MateriaPipelineSocketConfig`: agent/utility socket config with parse, assign, edges, foreach, advance, limits, and legacy layout.
- `ResolvedMateriaPipeline` / `ResolvedMateriaNode`: runtime graph after resolving socket references to reusable materia.
- `MateriaCastState`: persisted runtime cast state, including current socket/socket, data, cursors, visits, recovery state, usage run state, and resolved pipeline.
- `HandoffEnvelope`/`HandoffWorkItem` in `handoffContract.ts`: canonical inter-socket payload.

## Module responsibility inventory and target layering

Suggested target categories for extraction:

### Domain candidates

Pure/data-oriented concepts and deterministic operations:

- `types.ts` subsets: materia definitions, loadout graph, socket ids, work items/handoff types, cast routing state, loop state, usage value types where pure.
- `socketIds.ts`: canonical socket id parsing/validation.
- Pure portions of `handoffContract.ts`: canonical field constants, envelope/workItem types, deterministic field picking.
- Pure portions of `handoffValidation.ts`: reserved field and JSON handoff validation.
- Pure portions of `graphValidation.ts`: graph invariants, edge condition rules, structural validation.
- `loopExitRoutes.ts`: pure loop-exit route selection.
- Pure path/expression helpers currently private in `native.ts`: assignment path resolution, condition evaluation, current item/cursor selection.

### Application/use-case candidates

Workflow orchestration with ports, no concrete Pi/fs/process/webui imports:

- Start cast, continue cast, complete agent turn, process handoff, advance route, recast/revive, abort.
- Load/select active loadout workflow around config repository port.
- Prompt preparation as a use case using prompt renderer/model/tool ports.
- Cast listing/status workflow using cast repository/artifact index ports.
- Utility-socket execution orchestration should depend on a utility executor port; built-in/command execution are infrastructure.
- Budget/usage updates can be application services around pure aggregation plus persistence ports.

### Infrastructure/adapter candidates

Concrete IO/runtime implementations:

- Filesystem config/profile/artifact repository portions of `config.ts`, `artifacts.ts`, manifest/event/usage writers.
- Pi session state repository wrapping `appendEntry`/`sessionManager` custom entries.
- Pi messaging/tool/model adapters in `native.ts`/`modelSettings.ts`/`renderer.ts`/`ui.ts`.
- Built-in utility and command execution in `utilityRegistry.ts` and `native.ts` (`spawn`, process env, bounded stdout/stderr capture).
- VCS/project utilities under `utilityRegistry.ts`.
- WebUI launcher/server remains an edge adapter and should not move into application/domain.

### Plugin integration candidates

Thin composition/orchestration shell:

- `src/index.ts`: register flags/hooks/commands, parse command args, call application services, translate results to Pi UI/messages.
- `src/renderer.ts`: Pi custom renderer registration.
- WebUI launch command wiring in `index.ts` should remain at plugin edge.

### Compatibility/schema candidates

Anti-corruption layer for external JSON and legacy formats:

- `config.ts` read/merge/write JSON schema handling and obsolete field rejection.
- `loadoutNormalization.ts`, `loopSemantics.ts`, `loadoutGraphAnalysis.ts`: migration/normalization for legacy layout, loop iterator/consumer metadata, and generated output conventions.
- Legacy `next` edge normalization in `graphValidation.ts` should move to schema adapter while domain consumes canonical edges.
- Legacy `sockets` terminology compatibility should be isolated here before canonical internal APIs move toward sockets.

## Dependency map and boundary leaks

Current high-level dependencies:

```text
index.ts (plugin)
  -> config, pipeline, loadouts, activeLoadoutEvents, renderer, native, webui/launcher, ui

native.ts (runtime orchestration)
  -> artifacts, compaction, config, pipeline, json, generator, graphValidation,
     loopExitRoutes, handoffContract, handoffValidation, modelSettings,
     notificationFormatting, ui, usage, utilityRegistry, Pi APIs, fs, child_process

config.ts (config IO + schema + validation)
  -> compaction, graphValidation, loadoutNormalization, fs/os/path/url

pipeline.ts (resolution + rendering)
  -> config(resolveArtifactRoot), graphValidation, generator, loadoutNormalization

loadoutNormalization.ts
  -> generator, graphValidation, loadoutGraphAnalysis, loopSemantics

loopSemantics.ts
  -> generator, loadoutGraphAnalysis

loadoutGraphAnalysis.ts
  -> generator

graphValidation.ts
  -> handoffContract, socketIds

usage.ts
  -> artifacts, fs/path

activeLoadoutEvents.ts
  -> loadouts, ui

webui/launcher.ts
  -> native, config, activeLoadoutEvents, roleGeneration, webui/server

webui/client shared imports
  -> loadoutGraphAnalysis, loadoutNormalization, loopSemantics, socketIds,
     graphValidation, generator, types
```

Notable boundary leaks/cycles to address during extraction:

- `native.ts` is the main boundary leak: domain rules, application workflow, Pi session APIs, fs artifacts, command execution, prompt assembly, usage, model/tool mutation, and UI updates are in one module.
- `pipeline.ts` imports `config.ts` only for `resolveArtifactRoot` in `renderGrid`, creating an avoidable dependency from graph resolution/rendering back to config IO utilities.
- `config.ts` performs both filesystem/profile IO and schema/domain validation. It should become an infrastructure/schema adapter around pure validators.
- `graphValidation.ts` currently includes both canonical graph invariants and legacy `next`/`flow` normalization; normalization belongs at compatibility boundaries.
- `types.ts` mixes external schema DTOs, domain concepts, runtime state, persistence manifests, and usage reports. Expect staged splitting with compatibility barrels.
- `usage.ts` mixes pure aggregation/extraction with filesystem event/usage writing through `artifacts.ts`.
- `activeLoadoutEvents.ts` couples active-loadout domain events to UI widget rendering.
- WebUI client imports shared core helper modules directly; these are integration contracts to preserve while moving internals behind stable barrels/DTOs.

No obvious import cycle was observed from the current source import map, but several modules have reversed or too-broad dependency direction for the target architecture.

## Socket terminology migration points

The canonical core model is socket-first:

- `MateriaPipelineConfig.sockets` is the canonical graph map in config/defaults and user/project configs.
- `ResolvedMateriaPipeline.sockets`, socket ids, visits, edge traversals, task attempts, and loop membership are canonical runtime concepts.
- Persisted DTO fields such as `MateriaCastState.currentSocketId`, `currentSocketState`, `UsageReport.bySocket`, manifest `socket`, and event names like `socket_start`/`socket_complete` use canonical socket terminology.
- Artifact layout uses `sockets/<socket-id>/...`.
- WebUI/server monitor and config/loadout DTOs are socket-only.

Migration intent:

- New domain/application APIs use socket terminology (`socketId`, `sockets`, socket state).
- Persisted loadouts use `sockets`.
- Public DTOs consumed by WebUI config save/load paths are socket-only.
- Artifact directory/event fields use socket names and should stay aligned with fixture tests.

## Target dependency direction

Target layering for the refactor:

```text
Plugin composition
  -> infrastructure adapters
    -> application ports/use cases
      -> domain

Schema/persistence compatibility adapters sit at the edge and translate external
JSON/save/session formats into domain/application models before use.
```

Rules:

- Domain imports no plugin APIs, WebUI, filesystem/process/network/provider/runtime implementation, or persistence adapters.
- Application imports domain and defines minimal use-case-oriented ports.
- Infrastructure imports application ports/domain DTOs to implement concrete fs/Pi/runtime/provider/VCS/prompt adapters.
- Plugin entrypoints compose concrete adapters and delegate workflows.
- Schema adapters own legacy `sockets`/`next`/layout/generates compatibility and produce canonical domain/application models.

## Suggested extraction order notes

1. Add characterization tests around existing plugin-facing behavior and persisted formats before moving logic.
2. Split pure domain helpers first behind compatibility barrels: socket ids, handoff contract/validation, graph invariants, loop exit routing, assignment/condition helpers.
3. Add schema adapters for config/session/cast formats, including legacy `sockets` to canonical sockets mapping.
4. Move use cases out of `native.ts` in vertical slices: start cast, process agent end, continue/recast/revive, utility execution, prompt prep.
5. Replace direct Pi/fs/process calls with narrow ports as each use case moves.
6. Keep WebUI contracts stable; migrate internals to socket terminology only after adapters and fixtures are in place.
