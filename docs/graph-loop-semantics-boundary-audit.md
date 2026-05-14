# Graph and loop semantics boundary audit

Implementation-facing inventory from the graph-semantics cleanup planning pass. This is historical/descriptive and may mention pre-refactor behavior. For normative current behavior use [Structured loop semantics](structured-loop-semantics.md); for compatibility shim ownership, removal conditions, warning-to-error timing, and tests to convert use [Loop compatibility and sunset plan](loop-compatibility-sunset.md).

## Target concepts being audited

- Normal socket edges: ordered `socket.edges[]` / legacy `socket.next` same-item control flow.
- Cursor setup: `foreach` or loop-derived iterator selects the current item before a socket runs.
- Cursor advancement: `advance` increments a named cursor after a socket completes and can detect exhaustion.
- Empty-loop entry: entering an iterator socket when the current cursor points past the item list.
- Post-loop routing metadata: `loops.<id>.exits[]` route records, with legacy/documentary `loops.<id>.exit` still present.
- Terminal sentinel: the string `"end"`, currently accepted by graph validation for optional targets and by runtime as loadout completion.

## Runtime execution paths that choose the next socket

### Socket completion: `src/runtime/nativeLifecycle.ts`

- `completeSocket()` parses/validates output, applies generic handoff state, applies assignments, then calls `applyAdvance()`.
- It chooses `nextTarget = advanceTarget ?? selectNextTarget(...)`.
- `advanceToSocket()` treats `targetId ?? "end"` as the terminal fallback. If the target is `"end"`, it calls `finishCast()`; otherwise it resolves a socket id and starts that socket.

### Cursor advancement and exhaustion: `src/application/workflowTransitions.ts`

- `applyAdvance()` reads `resolvedSocketConfig(socket).advance`.
- If no `advance` exists, or `advance.when` evaluates false, no advance target is returned.
- When `advance` runs, it resolves `advance.items`, increments `state.cursors[advance.cursor]`, clears current item metadata, and returns no target for non-final items.
- On exhaustion (`next >= items.length`), current behavior returns:
  - first: `resolveRuntimeLoopExitTarget(state, socket.id, parsed)?.targetSocketId` via `loops.<id>.exits[]` route metadata;
  - fallback: `advance.done`.
- This is the main current coupling: `advance.done` is both the old final/exhaustion target and the fallback after loop-exit route lookup.

### Loop-exit route resolution: `src/graph/loopExitRoutes.ts`

- `resolveLoopExitRoute()` reads only `loop.exits[]`, filtered by `from` (or legacy/default `loop.exit.from` when `from` is omitted).
- Precedence is `satisfied` then `always` for true, `not_satisfied` then `always` for false, and only `always` when the outcome is unavailable.
- It returns no route if there is no matching route; runtime then falls back to `advance.done`.
- It never reads legacy `passed`, `feedback`, `missing`, or arbitrary fields.

### Same-item edge routing: `src/application/workflowTransitions.ts`

- `selectNextTarget()` uses `canonicalOutgoingEdges()` and `selectMatchingEdge()` to choose the first satisfied ordered edge.
- If no edge matches, it returns `"end"`.
- This is normal socket-to-socket control flow and is separate from loop exhaustion metadata, except that it runs only when `applyAdvance()` did not return a final target.

### Empty-loop entry and item setup: `src/application/workflowTransitions.ts` + `src/runtime/nativeLifecycle.ts`

- `setCurrentItem()` finds direct `socket.foreach` first, otherwise `loopIteratorForSocket()` for any loop member with `loop.iterator`.
- The cursor defaults to `loop.cursor` or a `${socket.id}Index`-style fallback and is stored in `state.cursors`.
- If the current item is missing, `setCurrentItem()` returns false.
- `startSocket()` detects this case for loop iterator metadata and routes to `loop.done ?? "end"` with entry id `foreach-empty`.
- Empty-loop routing currently uses the iterator/done value, not `loops.<id>.exits[]`.

## Validators and target/sentinel distinctions

### Domain loadout validation: `src/domain/loadout.ts`

- `validateLoadout()` validates socket ids, edge conditions, and loop metadata for the domain `Loadout` shape.
- `socket.edges[].to` must be an existing socket id; `"end"` is not accepted as a normal edge target here.
- `socket.foreach.done` must reference an existing socket; it does **not** currently allow `"end"` in this domain validator.
- `socket.advance.done` allows `isTerminalAdvanceTarget()` (`"end"`) or an existing socket id.
- `loop.consumes.done`, `loop.iterator.done`, and legacy `loop.exit.to` allow `"end"` or an existing socket id.
- `loop.exits[].targetSocketId` must reference an existing socket; terminal `"end"` is not accepted for canonical loop-exit routes.

### Graph validation: `src/graph/graphValidation.ts`

- `validatePipelineGraph()` normalizes legacy `next`, validates socket links, then validates loop metadata.
- `validateOptionalTarget()` accepts `isTerminalAdvanceTarget(to)` before requiring canonical socket id/existence. It is used for `next`, `foreach.done`, `advance.done`, `loop.consumes.done`, `loop.iterator.done`, and legacy `loop.exit.to`.
- `validateLoopExitRoutes()` intentionally validates `loops.<id>.exits[].targetSocketId` via `validateSocketReference()`, so route targets must be socket ids and cannot be `"end"`.
- `validateExecutableLoopSemantics()` still checks legacy materialized runtime fields for `loop.exit + loop.consumes`: parse mode, expected `advance.{cursor,items,done,when}`, and continuation edges.

### Socket-reference accessor validation: `src/loadout/loadoutAccessors.ts`

- `validateLoadoutSocketReferences()` checks socket references across sockets and loops.
- `addMissingReferenceIssue()` skips `isTerminalAdvanceTarget(socketId)`, so it accepts `"end"` for all optional done/target fields it sees, including `foreach.done`, `advance.done`, `loop.consumes.done`, `loop.iterator.done`, and `loop.exit.to`.
- It also skips `"end"` for `loop.exits[].targetSocketId` if provided, which is more permissive than `graphValidation.ts` and `domain/loadout.ts`.

### Link compiler validation/remapping: `src/link/compiler.ts`

- `/materia link` expands targets to domain `Loadout` fragments and calls `validateLoadout()` on each source fragment and on the assembled virtual loadout.
- It remaps socket ids in socket edges, `foreach.done`, `advance.done`, `loop.sockets`, `loop.consumes.from/done`, `loop.iterator.done`, legacy `loop.exit.from/to`, and `loop.exits[].from/targetSocketId`.
- `remapGraphTarget()` preserves `"end"` unchanged.
- Terminal stitching currently selects terminal sockets with no edges, no `foreach`, and no `advance`; sockets whose final route is encoded as `advance.done: "end"` are not considered terminal stitching points.

### WebUI save validation: `src/webui/client/src/loadoutModel.ts`

- `validateLoadoutSaveSemantics()` normalizes through shared loadout normalization, then checks JSON parse requirements for `edges[].when`, `advance.when`, and `loops.<id>.exits[].condition`.
- It validates loop-consumer diagnostics from graph analysis but does not implement independent terminal-target validation; server/config validation remains authoritative.

## Loadout/materialization/schema/persistence paths

### Shared loadout normalization: `src/loadout/loadoutNormalization.ts`

- `normalizeLoadedLoadout()` normalizes `next` to `edges`, materializes canonical socket containers, normalizes socket kinds/layout, and runs graph analysis.
- `prepareLoadoutForSave()` additionally reconciles loop consumers, normalizes generator sockets, materializes loop semantics, and prunes layout.
- `prepareLoadoutForRuntime()` delegates to save preparation, so runtime receives materialized loop semantics.
- Config-level wrappers apply these operations to every configured loadout.

### Loop materialization: `src/graph/loopSemantics.ts`

- `materializeLoadoutLoopSemantics()` reconciles loop consumers from graph topology and processes every `pipeline.loops` entry.
- `materializeLoopExit()` only acts when both legacy `loop.exit` and `loop.consumes` are present and a generator can be found.
- It may set `parse: "json"` when `loop.exit.when` is `satisfied` / `not_satisfied`.
- It materializes `socket.advance` on `loop.exit.from` with `cursor` from `loop.consumes.cursor` or generator cursor, `items` from generator items or `state.<output>`, `done: loop.exit.to`, and `when: loop.exit.when`.
- It preserves existing compatible advance blocks and errors on conflicts.
- Historical note: the old materializer treated `loop.exit.to` as the source of materialized `advance.done`. New-model docs must not present that as canonical routing; socket-valued legacy routes are normalized into `loops.<id>.exits`, and `advance.done` is compatibility-only.

### Graph analysis: `src/graph/loadoutGraphAnalysis.ts`

- Analyzes socket edges and loop membership to infer/reconcile `loop.consumes.from` for generator-driven loops.
- Uses normal edges entering loop member sockets from generator sockets to derive consumer sources.
- It does not select runtime next targets and does not interpret `advance.done` or `loop.exits[]` routing.

### Config load/save: `src/config/config.ts`

- `readConfigPartial()` calls `normalizePersistedConfigForApplication()` for anti-corruption normalization before merge.
- `mergeConfigLayers()` validates materia/config, calls `normalizeConfigLoadoutsForLoad()`, then `prepareConfigLoadoutsForSave()`, then validates loadout graphs.
- `saveMateriaConfigPatch()` prepares loadouts for save and validates loadout graphs before writing JSON.
- This means normal config persistence stores the materialized socket-level runtime controls in addition to loop metadata.

### Schema/persistence adapters: `src/schema/persistence.ts`

- `PersistedLoadoutSchema` stores `entry`, `sockets`, optional `loops`, and optional layout.
- `PersistedLoopSchema` currently declares `label`, `sockets`, `consumes`, `iterator`, and `exits`; it omits legacy `exit`.
- `parseLoop()`, `serializeLoop()`, `pipelineLoopToDomain()`, and `domainLoopToPipeline()` all preserve `sockets`, `consumes`, `iterator`, and `exits`, but drop `loop.exit`.
- Therefore schema adapter round-trips use `loops.<id>.exits[]` but not legacy `loops.<id>.exit`, while direct config JSON still commonly contains both.

### WebUI mutation/materialization paths

- `src/webui/client/src/loadoutTransforms.ts#createTaskLoop()` creates loop records with `{ label, sockets, consumes, exit }`.
- `updateLoopExitInLoadout()` mutates legacy `loop.exit` and clears `loop.exits` when the exit source changes.
- `upsertLoopExitRouteInLoadout()` / `upsertLoopExitRoute()` create canonical route metadata as `loop.exits[]` records with `{ id, from, condition, targetSocketId }`; they do not create normal socket edges.
- Deletion helpers remove/adjust `foreach.done`, `advance.done`, `loop.consumes.done`, `loop.iterator.done`, `loop.exit.to`, and `loop.exits[].targetSocketId` when sockets are deleted. If `loop.exit.to` points at a deleted socket, it is reset to `"end"`.
- `src/webui/loadoutDto.ts` simply clones loop DTOs without changing shapes.

## Exact loop shapes currently in use

### Canonical config/runtime loop object

Current TypeScript type `MateriaLoopConfig` supports all of these fields:

```json
{
  "label": "Loop label",
  "sockets": ["Socket-4", "Socket-5"],
  "consumes": { "from": "Socket-1", "output": "workItems", "as": "workItem", "cursor": "workItemIndex", "done": "end" },
  "iterator": { "items": "state.workItems", "as": "workItem", "cursor": "workItemIndex", "done": "end" },
  "exit": { "from": "Socket-5", "when": "satisfied", "to": "end" },
  "exits": [{ "id": "exit:Socket-5:always", "from": "Socket-5", "condition": "always", "targetSocketId": "Socket-6" }]
}
```

### `loops.<id>.exit`

- Legacy/declarative loop-exit intent.
- Shape: `{ from: string, when: "always" | "satisfied" | "not_satisfied", to: string }`.
- `to` may be `"end"` or a socket id in graph/domain validation.
- Used by materialization to derive `advance.done` and `advance.when`.
- Used as fallback source by `resolveLoopExitRoute()` only when caller omits `from`.
- Dropped by `schema/persistence.ts` domain/persisted adapters.

### `loops.<id>.exits[]`

- Current loop-owned post-exhaustion route metadata.
- Shape: `{ id: string, from: string, condition: "always" | "satisfied" | "not_satisfied", targetSocketId: string }`.
- Runtime reads this through `resolveRuntimeLoopExitTarget()` after `advance` detects exhaustion.
- `targetSocketId` is expected to be a real socket id by graph and domain validators; it is not a terminal sentinel route in those validators.
- If no route matches, runtime falls back to `advance.done`.

### `loop.exits` / `loop.exit`

Code generally accesses these as properties on each loop object (`loop.exits`, `loop.exit`) after iterating `Object.entries(pipeline.loops ?? {})`. Persisted JSON path is still `loops.<id>.exits` / `loops.<id>.exit`; there is no separate top-level `loop` object.

## UI-authored pattern to preserve

Bundled/default and UI-shaped loadouts can contain both:

```json
"advance": { "cursor": "workItemIndex", "items": "state.workItems", "done": "end", "when": "satisfied" },
"loops": {
  "loopSelection": {
    "exit": { "from": "Socket-7", "when": "satisfied", "to": "end" },
    "exits": [{ "id": "exit:Socket-7:always", "from": "Socket-7", "condition": "always", "targetSocketId": "Socket-8" }]
  }
}
```

In current runtime, the final satisfied item on `Socket-7` advances the cursor, checks `loops.loopSelection.exits`, and routes to `Socket-8` when the `always` route matches. If no `loop.exits` route matches, `advance.done: "end"` terminates the loadout. This coexistence is normal current behavior and is the compatibility case that previously exposed `/materia link` validation drift.

## Test coverage paths

Existing tests that exercise or imply these boundaries:

- `tests/workflowTransitions.test.ts`
  - Covers `selectMatchingEdge()` same-item condition precedence and `applyAdvance()` cursor increment/exhaustion behavior.
  - Explicitly asserts `advance.done: "end"` is returned only after the final item.
  - Gap: only covers helper-level advancement; it does not cover empty-loop entry through `startSocket()` or full cast completion.
- `tests/loopExitRoutes.test.ts`
  - Covers canonical `loops.<id>.exits[]` route selection, including `satisfied` / `not_satisfied` / `always` precedence and fallback when no route matches.
  - Gap: route selection is isolated; runtime fallback to `advance.done` is covered elsewhere or indirectly.
- `tests/graphValidation.test.ts`
  - Covers graph-level target validation, edge endpoint validation, loop metadata validation, executable loop semantics, and terminal target acceptance/rejection in the shared graph validator.
  - Important for future work because it is stricter than accessor validation for `loop.exits[].targetSocketId` and more permissive than domain validation for some optional `done` targets.
- `tests/loadoutAccessors.test.ts`
  - Covers socket-reference inventory/diagnostics for sockets and loop metadata.
  - Important drift marker: accessor validation skips terminal `"end"` more broadly than graph/domain validators, including optional done/target fields discovered through accessors.
- `tests/loadoutNormalization.test.ts`
  - Covers config/loadout normalization and materialization of generator-consuming loop scaffolding into socket-level runtime fields.
  - Asserts materialized `advance` blocks such as `{ cursor, items, done: "end", when: "satisfied" }`.
- `tests/pipeline.test.ts`
  - Covers `resolvePipeline()` graph validation/materialization and `renderGrid()` loop rendering.
  - Exercises legacy `loop.exit` plus `loop.consumes` materialization, iterator metadata preservation, `foreach.done: "end"`, normal edges, and default loadout loop shapes.
- `tests/schemaPersistence.test.ts`
  - Covers persistence adapters and compatibility normalization.
  - Relevant gap: schema adapters currently preserve `loops.<id>.exits[]` but omit/drop legacy `loops.<id>.exit`, so tests here should be revisited before any migration refactor.
- `tests/linkCompiler.test.ts`
  - Covers `/materia link` compilation, socket-id remapping, target stitching, and source-loadout immutability.
  - Includes the previously isolated compatibility regression for link-time validation rejecting `advance.done: "end"`; future refactors should keep this as a cross-boundary drift guard.
- `tests/linkParserResolver.test.ts` and `tests/linkContextLoader.test.ts`
  - Cover command parsing, target resolution, and `--from` cast-context loading for linked loadouts.
  - These tests distinguish parser/source-context failures from graph-validation failures.
- `tests/graphSemanticsRegression.test.ts`
  - Regression coverage for graph/handoff semantics that can interact with `satisfied` / `not_satisfied` routing.
  - Useful as a smoke guard when changing condition semantics, even when it does not directly own loop exhaustion.
- `tests/yoloLoopSemantics.test.ts`
  - Integration-style coverage for reusable loop/loadout behavior and UI-authored loop expectations.
  - Useful for ensuring the structured loop model continues to behave for real loadout shapes.
- `tests/loadoutGraphAnalysis.test.ts`
  - Covers loop-consumer inference/reconciliation from graph topology.
  - Relevant to materialization because `loop.consumes.from` can be inferred from normal edges before iterator/advance metadata is derived.
- `tests/ui.test.ts`
  - Covers presentation of active loop state using `state.cursors` and loop iterator metadata.
  - Does not choose routing targets, but it is affected by cursor-state naming and iterator metadata compatibility.
- `tests/sameSocketRecoveryNative.test.ts`
  - Contains native/runtime fixtures with `foreach.done: "end"` and `advance.done: "end"` during recovery scenarios.
  - Useful as a guard that failure/retry handling does not reinterpret loop terminal sentinels.

Targeted commands used during the prior compatibility investigation were:

```sh
bun test tests/linkParserResolver.test.ts tests/linkContextLoader.test.ts tests/linkCompiler.test.ts
```

Command run for this audit update, and recommended targeted group for future semantic refactors:

```sh
bun test tests/workflowTransitions.test.ts tests/loopExitRoutes.test.ts tests/graphValidation.test.ts tests/loadoutAccessors.test.ts tests/loadoutNormalization.test.ts tests/pipeline.test.ts tests/schemaPersistence.test.ts tests/linkCompiler.test.ts tests/loadoutGraphAnalysis.test.ts
```

## Existing documentation paths

Documentation surfaces that describe or imply graph/loop semantics:

- `docs/graph-semantics.md`
  - Current broad graph-semantics reference.
  - Documents canonical edge conditions, `satisfied` control fields, generator/consumer regions, and `loops.<id>.exits[]` as loop-owned post-completion routes.
  - Needs follow-up to remove ambiguous fallback wording once the new model makes `advance` cursor-only and loop exits canonical for post-loop routing.
- `docs/loop-semantics.md`
  - Current developer reference for generator-driven loop exits and migration.
  - Still describes `loops.<id>.exit` compiling into socket-level `advance.done` and says final items exit via `advance.done`.
  - Treat as current/legacy-compatible documentation, not the final target model.
- `docs/loadout-loop-semantics-audit.md`
  - Older audit focused on load/save/run-time loop materialization gaps.
  - Useful historical context for why default loadouts work and where UI-created loadouts once omitted runtime fields.
  - Partially stale because runtime now also considers `loops.<id>.exits[]` through `resolveRuntimeLoopExitTarget()` before falling back to `advance.done`.
- `docs/schema-persistence-compatibility.md`
  - Persistence terminology reference.
  - Notes persisted loop membership uses `loops.*.sockets`, but does not yet document `loops.<id>.exits[]` preservation versus legacy `loops.<id>.exit` loss in schema adapters.
  - Needs follow-up when migration/normalization behavior is formalized.
- `docs/link-semantics.md` and `docs/link-data-model.md`
  - Link-command documentation surfaces.
  - Relevant because `/materia link` clones/remaps loadout fragments, preserves terminal sentinels, and can drift from runtime/domain graph semantics.
  - Should be updated after validation/remapping helpers are centralized.
- `README.md`
  - User-facing entry point if it mentions loadouts, graph routing, loops, or terminal behavior.
  - Should not become the canonical implementation reference, but examples should avoid presenting legacy `advance.done` routing as the preferred new authoring model.

## Boundary drift and follow-up risks

- `advance.done` still has dual meaning: old fallback final target and runtime fallback after loop-exit route lookup.
- Empty-loop entry uses iterator/foreach `done ?? "end"`, not `loops.<id>.exits[]`.
- Validators are not fully aligned: graph validation accepts `"end"` for `foreach.done`, domain validation does not; accessor validation accepts `"end"` broadly, including places where graph/domain validation reject it.
- `schema/persistence.ts` preserves `loops.<id>.exits[]` but drops legacy `loops.<id>.exit`, while config JSON and UI transforms still use `loop.exit` heavily for materialization.
- Link terminal stitching ignores `advance.done: "end"` terminal completion because sockets with `advance` are not considered terminal sockets.
- New-model work should centralize target classification, remapping, exhaustion routing, and compatibility normalization before changing semantics.
