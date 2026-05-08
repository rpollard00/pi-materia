# Generic Materia handoff contract audit

Date: 2026-05-08

Scope: audit of the current codebase before migrating JSON-producing materia from placement-specific `tasks` handoffs and materia-named default socket ids to a generic reusable work-context envelope.

## JSON-producing materia and current handoff shapes

Current JSON nodes are selected by node/socket adapter config with `parse: "json"`; materia definitions do not inherently decide parsing unless their palette defaults are copied into a socket.

### Built-in utility JSON materia

- `config/default.json` materia `ensureArtifactsIgnored` / utility `project.ensureIgnored`:
  - Shape produced by `src/utilityRegistry.ts`: `{ "ok": boolean, "root": string, "file": string, "patterns": string[], "added": string[], "unchanged": string[] }`.
  - Default adapters assign the whole object with `assign: { "artifactIgnore": "$" }`.
- `config/default.json` materia `detectVcs` / utility `vcs.detect`:
  - Shape produced by `src/utilityRegistry.ts`: `{ "kind": "jj" | "git" | "none", "root": string | null, "available": { "jj": boolean, "git": boolean } }`.
  - Default adapters assign the whole object with `assign: { "vcs": "$" }`.
- `config/default.json` materia `GitMaintain`:
  - Prompt asks for the same maintenance-control family as `Maintain`, restricted to git: `{ "satisfied": boolean, "commitMessage": string, "reason": string, "vcs": "git" | "none", "checkpointCreated": boolean, "commands": string[] }`.
  - It is not used by the bundled default loadout sockets today, but it is a JSON-producing materia definition because the prompt explicitly requires JSON and uses `satisfied` as an evaluator/route-style control field.
- Utility command nodes in `src/native.ts` can also be JSON parsed when a socket sets `parse: "json"`; their parsed stdout is validated as a handoff object before assignment/routing.

### Built-in agent JSON materia

- `planner` prompt in `config/default.json` currently asks for:
  - `{ "tasks": [{ "id": string, "title": string, "description": string, "acceptance": string[] }] }`
  - `generates: { "output": "tasks", "as": "task", "cursor": "taskIndex", "done": "end", "listType": "array", "itemType": "task" }`
  - Default adapters assign `tasks` with `assign: { "tasks": "$.tasks" }` and route always to `Build`.
- `interactivePlan` prompt asks for the same finalized `{ "tasks": [...] }` shape after `/materia continue`, with the same `generates` metadata.
- `Auto-Eval` prompt currently asks for:
  - `{ "satisfied": boolean, "feedback": string, "missing": string[] }`
  - Default adapters assign `lastFeedback` from `$.feedback` and `lastCheck` from `$`, then route on `satisfied` / `not_satisfied`.
- `Maintain` prompt currently asks for:
  - `{ "satisfied": boolean, "commitMessage": string, "reason": string, "vcs": "jj" | "git" | "none", "checkpointCreated": boolean, "commands": string[] }`
  - Default adapters assign `lastMaintain` from `$`, advance the `taskIndex` cursor over `state.tasks` when `satisfied`, route `not_satisfied` to itself, and otherwise route to `Build`.

## Runtime handoff consumers and adapter responsibilities

- `src/json.ts` extracts a fenced JSON block or first balanced JSON object/array, then parses it.
- `src/native.ts` parses only for sockets with `node.node.parse === "json"`, validates via `validateHandoffJsonOutput()`, stores `state.lastJson`, writes a `.json` artifact, applies `assign`, applies `advance`, and selects edges.
- `src/handoffValidation.ts` currently requires a top-level JSON object, validates `satisfied` as boolean when present, and requires `satisfied` when a node has `satisfied`/`not_satisfied` edges or `advance.when` control flow.
- `src/native.ts` `applyAssignments()` copies values from parsed `$`, `state.*`, `item.*`, or `lastJson.*` paths into `state.data`.
- `src/native.ts` `setCurrentItem()` is the current work-item adapter: for node `foreach` or loop-derived iterators, it reads `loop.items`, writes `state.data.item` and the loop alias (currently usually `task`), and sets `currentItemKey` / `currentItemLabel` from item `id`/`key` and `title`/`name`.
- Prompt templating in `src/native.ts` exposes `{{itemJson}}`, `{{item.*}}`, `{{state.*}}`, `{{lastOutput}}`, and `{{lastJson.*}}`; built-in Build/Eval/Maintain prompts currently consume `item` as a task-shaped object.
- `src/pipeline.ts` resolves generator loops from materia `generates` metadata. It requires generator sockets to parse JSON and assign the declared output, then derives iterator defaults such as `items: "state.<output>"`.
- `src/graphValidation.ts` validates endpoints for `entry`, `next`, `edges[].to`, `foreach.done`, `advance.done`, `loops.*.nodes`, `loops.*.consumes.from`, `loops.*.consumes.done`, `loops.*.iterator.done`, and `loops.*.exit`.

## References to `tasks` and work-item assignment

Primary production references that need migration to `workItems` or generic context:

- `config/default.json`
  - Planner and interactive planner prompts request `{ "tasks": [...] }`.
  - Planner and interactive planner `generates.output` is `tasks`, alias is `task`, cursor is `taskIndex`, item type is `task`.
  - Planner sockets assign `tasks` from `$.tasks` in both default loadouts.
  - Maintain sockets advance over `state.tasks` with cursor `taskIndex` in both default loadouts.
  - Loop `taskIteration.consumes` uses `{ "from": "planner", "output": "tasks" }` in both default loadouts.
  - Built-in Build, Auto-Eval, and Maintain prompts call the current unit a `Task` or `task`.
- `src/types.ts` and `src/pipeline.ts` are generic, but examples/comments and generator validation assume a generated list output; current defaults name it `tasks`.
- `src/native.ts` state/event/usage labels still use historical names such as `currentTask`, `taskId`, and `taskIdentityKey`; these are runtime metadata names for the current iterated item.
- `src/webui/client/src/App.tsx` still has production WebUI defaults/placeholders for generator setup: `generatedOutput` defaults to `tasks`, `generatedItemType` and `generatedAs` default to `task`, `generatedCursor` defaults to `taskIndex`, generated-materia submit falls back to `tasks`/`taskIndex`, and the generated-materia form placeholders include `tasks`, `state.tasks`, and `taskIndex`.
- `src/webui/client/src/loadoutModel.ts` is another production adapter surface:
  - `MateriaBehaviorConfig.generates` carries arbitrary generated-list metadata, so current UI-created planner roles can preserve `output: "tasks"`, `itemType: "task"`, alias `task`, cursor `taskIndex`, and `items: "state.tasks"` conventions.
  - `normalizeMateriaConfigEdges()` normalizes and preserves `edges` / legacy `next`, including `satisfied` and `not_satisfied` conditions, when loading configs into the WebUI model.
  - `materiaPaletteNode()`, `extractMateriaBehavior()`, `extractSocketStructure()`, and `placeMateriaInSocket()` intentionally split behavior from socket structure: generated-list config, parse/assign/foreach behavior, and socket edges/layout/limits are copied or preserved when dragging/placing materia into sockets.
  - `makeEmptyEntryLoadout()`, `makeNewSocketId()`, `getNodeLabel()`, and `formatSocketLabel()` already implement adapter-oriented `Socket-N` creation/display, independent of materia ids.
- `src/webui/server/index.ts` validates role-generation generator config from WebUI/API requests via `validateMateriaGeneratorConfig()`: it trims and forwards `generates.output`, `generates.items`, `generates.itemType`, `generates.as`, `generates.cursor`, and `generates.done`, and currently permits the `tasks` / `state.tasks` / `task` / `taskIndex` convention without translating it.
- `src/roleGeneration.ts` injects generated-role metadata into generated materia prompts: `roleGenerationContext()` prints the configured output key, list type, item type, items path, item alias, cursor, and done behavior, then instructs the generated prompt to produce that list under the configured output key and item semantics. Any WebUI/API config that supplies `tasks`, `task`, `taskIndex`, or `state.tasks` is therefore propagated into new JSON-producing role prompts.
- `src/types.ts` exposes runtime and usage metadata named for tasks: `UsageModelSelection.taskId`, `UsageTurn.taskId`, `UsageReport.byTask`, `UsageReport.byAttempt`, and `MateriaRunState.currentTask`.
- `src/usage.ts` creates and updates `byTask` and `byAttempt` aggregations keyed by `taskId`, records model selections with `taskId`, and writes per-turn usage entries with `taskId` and `attempt`.
- `src/ui.ts` renders the current item as `Task ...` via `state.currentTask` and labels usage breakdowns as `By task:` from `usage.byTask`.
- `README.md` contains impacted task-contract examples: the model config example says the planner breaks requests into implementation tasks, the graph semantics section uses `"tasks": "$.tasks"`, a custom `interactivePlan` loadout assigns `tasks`, reads `state.tasks`, uses alias `task`, cursor `taskIndex`, and final JSON shape `{ "tasks": [...] }`, and the Planning-Consult documentation says `/materia continue` parses the plan into configured `{ "tasks": [...] }` artifacts.
- `docs/handoff-contract.md`, `docs/graph-semantics.md`, `docs/handoff-contract-audit.md`, `docs/turn-failure-audit.md`, and `docs/utility-materia.md` contain task-loop examples or notes using `tasks`, `state.tasks`, `taskIndex`, `task`, and/or `satisfied` / `feedback` / `missing` contract references.
- `examples/graph-semantics-loadout.json` demonstrates a planner returning `{ "tasks": [...] }` and a loop consuming `tasks`.
- Tests and fixtures with task-shaped, assignment, routing, or placement-id assumptions include:
  - `tests/pipeline.test.ts`: generator loop resolution and summaries use `generates.output: "tasks"`, `assign: { tasks: "$.tasks" }`, `state.tasks`, alias `task`, cursor `taskIndex`, loop consumes `Plan.tasks`, default loadout assertions for planner/loop/Maintain advance, and validation errors for missing generated-output assignment.
  - `tests/handoffValidation.test.ts`: accepts arbitrary payloads containing `tasks`, validates reserved `satisfied`, requires `satisfied` for `satisfied` / `not_satisfied` edges and `advance.when: "satisfied"`, and still uses `state.tasks` / `taskIndex` in the advance fixture.
  - `tests/roleGeneration.test.ts`: generated-role prompt context fixtures pass `output: "tasks"`, `items: "state.tasks"`, `itemType: "task"`, alias `task`, cursor `taskIndex`, and verify those exact strings are injected into prompts.
  - `tests/webuiRoleGenerationApi.test.ts`: API generator-config validation trims and forwards `tasks`, `state.tasks`, `task`, and `taskIndex` from request bodies.
  - `tests/utilityNative.test.ts`: utility JSON/routing fixtures exercise `satisfied`, `feedback`, `not_satisfied`, `advance`, loops, and generic `state.items` iteration; these are adapter/control references to preserve when renaming work units.
  - `tests/graphSemanticsRegression.test.ts`: an end-to-end fixture seeds `{ tasks: [...] }`, assigns `tasks`, routes through Build / Auto-Eval / Maintain, assigns `lastFeedback`, advances `taskIndex` over `state.tasks` when `satisfied`, defines `taskIteration` over `state.tasks as task`, and asserts the cursor reaches `taskIndex = 2`.
  - `src/webui/client/src/App.vitest.tsx`: UI fixtures and saved-config assertions use planner `generates: tasks`, `assign: { tasks: "$.tasks" }`, generator badges `List: tasks`, loop consumes `planner.tasks`, loop summaries `state.tasks as task`, `taskIndex`, `satisfied` / `not_satisfied` edge rendering/toggling, loop creation defaults consuming `planner.tasks`, and socket ids such as `planner`, `Build`, `Auto-Eval`, and `Maintain`.
  - `src/webui/client/src/loadoutModel.vitest.ts`: adapter fixtures assert `Socket-N` creation/display and that placing/swapping/clearing sockets preserves structural fields such as `edges`, including `satisfied` and `not_satisfied` edge conditions.
  - `tests/usage.test.ts`: usage fixtures key model selections and turn aggregation with `taskId` values and exercise `byTask` / `byAttempt` behavior.
  - `tests/ui.test.ts`: terminal-state fixtures render `currentTask` labels and current task/title overflow behavior.
  - `tests/sameNodeRecoveryNative.test.ts`: multi-turn planner fixture assigns `tasks` from `$.tasks`, later verifies unfinalized recovery does not write `state.data.tasks`, and includes an independent `state.items` / `workItem` / `itemCursor` advance fixture.
  - `tests/graphValidation.test.ts`: graph-control fixtures cover `satisfied` / `not_satisfied` edge validation, unreachable-edge handling, loop `iterator: { items: "state.tasks", as: "task", cursor: "taskIndex" }`, loop exits on `satisfied`, endpoint references under `loops.*`, and edge condition state/guard classification.
  - `tests/config.test.ts`, `tests/handoffContract.test.ts`, `tests/handoffContractDrift.test.ts`, and `tests/nativePromptContract.test.ts`: contract drift and adapter fixtures assert reserved `satisfied`, canonical edge conditions, default config alignment, and prompt contract injection.
  - `tests/genericEngine.test.ts`: runtime fixture helpers and assertions cover generic `itemCursor` state, prompt templating for iterated items, generic routing helpers for `always` / `satisfied` / `not_satisfied`, loop/advance-style item consumption, and usage fixtures that still expose task-named aggregation keys such as `byTask`, `byAttempt`, and `taskId`.
  - `tests/multiturnNative.test.ts`: multi-turn planner fixtures repeatedly use `assign: { tasks: "$.tasks" }`, `state.tasks`, finalized `{"tasks":[...]}` outputs, downstream Build prompt consumption of the current item, `lastJson`/JSON artifact assertions, refinement/finalization behavior, and assertions that task assignment occurs only after finalization.
  - `tests/nativeAttempt.test.ts`: native attempt fixtures exercise generic foreach/work-item assignment with `state.items as workItem`, `itemCursor`, JSON `advance` behavior, and historical task-named usage/reporting assertions including `taskId` and `byAttempt`.
  - `tests/castsList.test.ts`: cast-list fixtures include persisted usage state with `byTask` and `byAttempt`, so UI/listing behavior still depends on task-named usage aggregates even when the iterated payload is generic.

## References to reserved evaluator/route fields

- `src/handoffContract.ts` defines `satisfied` as the only reserved control field and `always` / `satisfied` / `not_satisfied` as canonical edge conditions.
- `src/handoffValidation.ts` reserves `satisfied`, rejects non-boolean values, requires it for satisfied-controlled routing/advancement, and warns that legacy `passed` is not canonical.
- `src/native.ts` `evaluateEdgeCondition()` and `evaluateCondition()` route/advance from `$.satisfied` only.
- `config/default.json` Auto-Eval and Maintain prompts and sockets consume `satisfied`; Auto-Eval consumes `feedback` and `missing`; Maintain uses `satisfied` for cursor advancement and retry routing.
- `src/webui/client/src/App.tsx` has production routing/control references to the reserved conditions: display labels for `satisfied` and `not_satisfied`, edge-state CSS classes for those conditions, `nextCondition()` cycling through `always` -> `satisfied` -> `not_satisfied`, default edge-condition React state initialized to `satisfied`, edge-form reset back to `satisfied`, edge-condition form options for `Satisfied` and `Not Satisfied`, loop creation defaults with `exit.when: "satisfied"`, loop exit fallback defaults using `satisfied`, loop-exit condition selects, and helper/copy text explaining canonical loop exit conditions.
- `docs/handoff-contract.md`, `docs/handoff-contract-audit.md`, `docs/graph-semantics.md`, `docs/webui-integration-notes.md`, and `docs/webui-smoke-tests.md` document or test `satisfied` / `feedback` / `missing` payloads and `satisfied` / `not_satisfied` routing.
- Tests covering these reserved fields include `tests/handoffContract.test.ts`, `tests/handoffContractDrift.test.ts`, `tests/handoffValidation.test.ts`, `tests/nativePromptContract.test.ts`, `tests/graphValidation.test.ts`, `tests/config.test.ts`, `tests/pipeline.test.ts`, WebUI loadout model tests, and utility native routing tests.

## Default loadout socket ids and placement-specific routing

The bundled default loadouts currently use node ids that encode materia/utility identity rather than sequential socket ids.

### `Full-Auto`

- Entry: `ensureArtifactsIgnored`.
- Nodes and routing:
  - `ensureArtifactsIgnored` (`project.ensureIgnored`) --always--> `detectVcs`.
  - `detectVcs` (`vcs.detect`) --always--> `planner`.
  - `planner` (`planner`) --always--> `Build`.
  - `Build` (`Build`) --always--> `Auto-Eval`.
  - `Auto-Eval` (`Auto-Eval`) --satisfied--> `Maintain`; --not_satisfied--> `Build` with `maxTraversals: 3`.
  - `Maintain` (`Maintain`) --not_satisfied--> `Maintain` with `maxTraversals: 3`; --always--> `Build`.
- Advance: `Maintain.advance = { "cursor": "taskIndex", "items": "state.tasks", "done": "end", "when": "satisfied" }`.
- Loop: `taskIteration.nodes = ["Build", "Auto-Eval", "Maintain"]`, `exit = { "from": "Maintain", "when": "satisfied", "to": "end" }`, `consumes = { "from": "planner", "output": "tasks" }`.

### `Planning-Consult`

- Same socket ids and routing as `Full-Auto`, except node `planner` uses materia `interactivePlan`.
- Same `Maintain.advance` and `taskIteration` loop references.

### Sequential socket-id support already present elsewhere

- `src/webui/client/src/loadoutModel.ts` creates empty loadouts with `Socket-1`, formats contextual labels as `Socket-N (Materia)`, allocates the next unused static `Socket-N` id, and preserves socket structure separately from materia behavior while copying generated-list behavior into sockets.
- WebUI tests in `src/webui/client/src/loadoutModel.vitest.ts` already cover contextual labels, next `Socket-N` allocation, and structural edge preservation during socket operations, but the bundled `config/default.json` has not been migrated to those ids.

## Documentation and examples that rely on current placement-specific contract

- `README.md` links to the canonical handoff contract and describes configurable pipelines; check examples when migrating defaults.
- `docs/handoff-contract.md` currently presents a flat arbitrary payload contract with examples using `tasks`, evaluator `{ satisfied, feedback, missing }`, and maintainer advancement.
- `docs/handoff-contract-audit.md` is itself an impacted historical reference: it documents task-based planner output, `assign: { "tasks": "$.tasks" }`, `state.tasks`, `taskIndex`, and evaluator/maintainer shapes containing `satisfied`, `feedback`, and `missing`.
- `docs/graph-semantics.md` uses a planner/task generator and Build → Eval → Maintain task loop throughout.
- `docs/utility-materia.md` documents parse/assign/advance mechanics and examples that may need envelope terminology.
- `docs/webui-integration-notes.md` lists editable routing fields and canonical branch behavior.
- `examples/graph-semantics-loadout.json` uses `Plan`, `Build`, `Auto-Eval`, `Maintain`, `tasks`, and `state.tasks`.
- `PI_MATERIA_PLAN.md` is historical and contains older task/routing language; treat as archival unless updating all examples.

## Migration implications discovered by the audit

- The largest behavioral coupling is not in materia prompts alone; it is the adapter chain `planner.assign tasks` -> loop `consumes.output tasks` -> generated iterator `state.tasks as task` -> `setCurrentItem()` -> Build/Eval/Maintain prompts using `item`/`task` -> Maintain `advance.items state.tasks`.
- A generic envelope can be introduced without changing the runtime parser, because `validateHandoffJsonOutput()` already requires top-level JSON objects and only reserves `satisfied`.
- To avoid a compatibility layer, defaults and tests should migrate the generator output from `tasks` to `workItems` together: prompt shapes, `generates.output`, `assign`, loop consumes, `advance.items`, docs, fixtures, and usage labels where user-visible.
- Default loadout renumbering must update every endpoint reference at the same time: `entry`, all `edges[].to`, `advance.done` if it points at a socket, `loops.*.nodes`, `loops.*.exit.from`, `loops.*.exit.to`, and `loops.*.consumes.from`.
