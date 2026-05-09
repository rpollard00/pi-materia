# Loadout loop semantics audit

This note audits how loadouts, loops, cursor consumption, parsing, advancement, and routing are represented and executed today. It is intentionally descriptive: no runtime behavior is changed here.

## Authoritative load/save/normalize paths

- Runtime and CLI load config through `src/config.ts#loadConfig`. Config layers are merged in this order: bundled `config/default.json`, user profile asset, project config, then explicit config. `mergeLoadouts()` and `normalizeLoadouts()` call `normalizePipelineGraph()`.
- UI config GET/POST is wired in `src/webui/server/index.ts` and launched from `src/webui/launcher.ts`; GET uses `loadConfig()`, POST uses `saveMateriaConfigPatch()`.
- UI save (`src/webui/client/src/App.tsx#saveDraft`) posts `normalizeMateriaConfigEdges(draftConfig)` to `/api/config`.
- Shared graph normalization lives in `src/graphValidation.ts#normalizePipelineGraph`. It only normalizes legacy `next` and edge condition aliases into canonical `edges`; it does not materialize `loops.exit` or `loops.consumes` into node `advance`/routing.
- Runtime resolution is in `src/pipeline.ts#resolvePipeline`: it normalizes the active loadout, migrates legacy loop iterator metadata to `consumes` when possible, normalizes generator sockets, validates graph structure, resolves nodes, validates generator contracts, and derives loop iterator metadata with `resolveLoopIterators()`.

## Current execution order

When a node starts (`src/native.ts#startNode`):

1. `setCurrentItem()` looks for direct `node.foreach` or `loopIteratorForNode(state.pipeline, node.id)`.
2. If an iterator exists, the current cursor selects an item from `loop.items`, stores aliases such as `state.item`, `state.currentWorkItem`, and `state.workItem`, and exposes item metadata for the prompt/run state.
3. If an iterator exists but no item is available, runtime routes to `loop.done ?? "end"` with no agent call.
4. The node visit/edge limits are enforced and the agent/utility node runs.

When a node completes (`src/native.ts#completeNode`):

1. The raw output is recorded and `state.lastOutput` is set.
2. If `node.parse === "json"`, the output is parsed, handoff JSON is validated by `validateHandoffJsonOutput()`, `state.lastJson` is set, and a JSON artifact is written. If parse is omitted or `"text"`, `parsed` remains raw text.
3. Generic handoff envelope fields are copied into state.
4. Node `assign` mappings are applied.
5. `applyAdvance()` runs before edge selection. If `node.advance` is absent, or `advance.when` evaluates false, it returns no target. If it runs, it increments `state.cursors[advance.cursor]`; only when the next cursor is at/past the item list length does it return `advance.done`.
6. Runtime appends completion events and checks budget.
7. `advanceTarget ?? selectNextTarget(...)` decides the next node. This means `advance.done` wins only on final consumption; non-final consumed items fall through to normal edges.
8. `selectNextTarget()` iterates `canonicalOutgoingEdges(node.node)` in order and chooses the first edge whose condition evaluates true; otherwise it returns `"end"`.

Condition evaluation is canonical: `always` is true; `satisfied` and `not_satisfied` read the reserved JSON field `$.satisfied` from the parsed node output. Therefore satisfied/not_satisfied control flow requires JSON parsing on that node. `validateHandoffJsonOutput()` enforces a boolean `satisfied` when a JSON-parsed node has satisfied/not_satisfied edges or `advance.when`.

## Loop metadata handling today

Loop types are declared in `src/types.ts`:

- `loops[id].nodes` groups sockets for UI/validation/iterator discovery.
- `loops[id].consumes` names the generator source and optional output/as/cursor/done overrides.
- `loops[id].iterator` is legacy/shared iterator metadata.
- `loops[id].exit` is documented in the type as: "Optional documented exit edge/condition for UI and validation. Runtime routing remains canonical edges."

Current runtime use of loop metadata is limited to iterator derivation and item setup:

- `src/pipeline.ts#resolveLoopIterators` derives `loop.iterator` from `loop.consumes` plus generator metadata.
- `src/pipeline.ts#loopIteratorForNode` returns that iterator for any member node.
- `src/native.ts#setCurrentItem` uses the iterator to expose the current item.

There is no runtime lookup of `loop.exit` in `completeNode()`, `applyAdvance()`, `selectNextTarget()`, or `advanceToNode()`. `loop.exit` is currently validated and rendered, but not executable routing.

## Why default loadouts work

The bundled default loadouts in `config/default.json` do not rely on `loop.exit` alone. They include explicit canonical runtime semantics on the Maintain socket:

- `parse: "json"` so the `satisfied` control field is available.
- `advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" }` so completed items advance and final completion routes to `end`.
- Edges such as `not_satisfied -> retry` and `always -> Build` so non-final successful items continue through the loop after `applyAdvance()` increments the cursor.

The default loop metadata (`loops.taskIteration.exit` and `loops.taskIteration.consumes`) matches this behavior for display/validation, but the executable behavior comes from node-level `parse`, `advance`, `assign`, and `edges`.

## Where UI-created loadouts omit semantics

The UI creates and edits loops in `src/webui/client/src/App.tsx`:

- `createTaskIteratorLoop()` writes `loops[loopId] = { label, nodes, consumes: { from, output }, exit: { from: lastSelectedNode, when: "satisfied", to: "end" } }`.
- `updateLoopExit()` and `clearLoopExit()` mutate only `loop.exit`.
- The loop editor copy currently says loop exits "use the same canonical edge model as graph edges", which is structurally true for validation but misleading because runtime does not execute `loop.exit`.
- UI save calls `normalizeMateriaConfigEdges()`, whose generator normalization sets generator sockets to `parse: "json"` and assigns `workItems`, but it does not set the loop exit-source node to `parse: "json"`, does not add `advance`, and does not rewrite edges.

Thus a UI-authored Build → Maintain loop can save `loops.exit` and `loops.consumes` while leaving Maintain as `parse: "text"` with an unconditional back-edge. Runtime then sees only the unconditional edge and loops until traversal/node limits are hit.

## Validation coverage and gap

`src/graphValidation.ts` validates:

- Socket ids and target existence for entries, edges, `foreach.done`, `advance.done`, `loops.consumes.done`, `loops.iterator.done`, and `loops.exit.to`.
- Canonical edge conditions on node edges and `loops.exit.when`.
- No edges after an unconditional `always` edge.
- Loop structural topology: selected nodes must contain a directed cycle and, for generator loops, exactly one inbound generator edge matching `loops.consumes.from`.

It does not validate that a loop exit can be materialized/executed. In particular, it does not require the exit source to parse JSON, does not require/derive `advance`, and does not check that `loop.exit` and `loop.consumes` correspond to node-level runtime fields.

## Implementation note

The clean unification point is a shared semantic materialization/analysis layer invoked from both load/run time and UI validation/save paths. The UI should be allowed to author high-level intent (`loops.exit` + `loops.consumes`), but the runtime should continue to execute one canonical model: node `parse`, `advance`, and ordered `edges`.

Recommended placement:

1. Add a shared materializer near the existing graph/pipeline normalization boundary, likely alongside `graphValidation.ts`/`pipeline.ts`, because both runtime config loading and the UI already import graph normalization/validation there.
2. Have runtime call it before `resolvePipeline()` validates/resolves nodes, so old saved user loadouts are repaired or rejected with actionable conflicts at run time.
3. Have UI validation/save call the same analyzer/materializer or its dry-run diagnostics, so users see the same conflicts before saving.
4. Materialize only missing, safe canonical fields: set JSON parsing where satisfied/not_satisfied control is required, add compatible `advance` derived from `loop.consumes` and `loop.exit`, and preserve existing compatible explicit semantics. Report conflicts rather than overwriting explicit incompatible fields.

This preserves working hand-authored defaults while making UI-authored loadouts executable in the same way.
