# Loadout loop semantics audit

This note audits how loadouts, loops, cursor consumption, parsing, advancement, and routing were represented during the loop-semantics cleanup. It is intentionally historical/descriptive: for normative current semantics use [Structured loop semantics](structured-loop-semantics.md), and for compatibility ownership/removal conditions use [Loop compatibility and sunset plan](loop-compatibility-sunset.md). Older observations below that describe `advance.done` as the executable post-loop route are legacy-context notes, not new authoring guidance.

## Authoritative load/save/normalize paths

- Runtime and CLI load config through `src/config/config.ts#loadConfig`. Config layers are merged in this order: bundled `config/default.json`, user profile asset, project config, then explicit config. `mergeLoadouts()` and `normalizeLoadouts()` call `normalizePipelineGraph()`.
- UI config GET/POST is wired in `src/webui/server/index.ts` and launched from `src/webui/launcher.ts`; GET uses `loadConfig()`, POST uses `saveMateriaConfigPatch()`.
- UI save (`src/webui/client/src/App.tsx#saveDraft`) posts `normalizeMateriaConfigEdges(draftConfig)` to `/api/config`.
- Shared graph normalization lives in `src/graph/graphValidation.ts#normalizePipelineGraph`. It only normalizes legacy `next` and edge condition aliases into canonical `edges`; it does not materialize `loops.exit` or `loops.consumes` into socket `advance`/routing.
- Runtime resolution is in `src/runtime/pipeline.ts#resolvePipeline`: it normalizes the active loadout, migrates legacy loop iterator metadata to `consumes` when possible, normalizes generator sockets, validates graph structure, resolves sockets, validates generator contracts, and derives loop iterator metadata with `resolveLoopIterators()`.

## Current execution order

When a socket starts (`startSocket`):

1. `setCurrentItem()` looks for direct `socket.foreach` or `loopIteratorForSocket(state.pipeline, socket.id)`.
2. If an iterator exists, the current cursor selects an item from `loop.items`, stores aliases such as `state.item`, `state.currentWorkItem`, and `state.workItem`, and exposes item metadata for the prompt/run state.
3. If an iterator exists but no item is available, runtime routes to `loop.done ?? "end"` with no agent call.
4. The socket visit/edge limits are enforced and the agent/utility socket runs.

When a socket completes (`src/castRuntime.ts#completeSocket`):

1. The raw output is recorded and `state.lastOutput` is set.
2. If `socket.parse === "json"`, the output is parsed, handoff JSON is validated by `validateHandoffJsonOutput()`, `state.lastJson` is set, and a JSON artifact is written. If parse is omitted or `"text"`, `parsed` remains raw text.
3. Generic handoff envelope fields are copied into state.
4. Socket `assign` mappings are applied.
5. `applyAdvance()` runs before edge selection. If `socket.advance` is absent, or `advance.when` evaluates false, it returns no target. If it runs, it increments `state.cursors[advance.cursor]`; only when the next cursor is at/past the item list length does it resolve loop exhaustion through canonical `loops.<id>.exits`, then terminal `end`, with any legacy `advance.done` fallback isolated behind named compatibility helpers.
6. Runtime appends completion events and checks budget.
7. `advanceTarget ?? selectNextTarget(...)` decides the next socket. This means exhaustion bypasses normal back-edges; non-final consumed items fall through to normal edges.
8. `selectNextTarget()` iterates `canonicalOutgoingEdges(socket.socket)` in order and chooses the first edge whose condition evaluates true; otherwise it returns `"end"`.

Condition evaluation is canonical: `always` is true; `satisfied` and `not_satisfied` read the reserved JSON field `$.satisfied` from the parsed socket output. Therefore satisfied/not_satisfied control flow requires JSON parsing on that socket. `validateHandoffJsonOutput()` enforces a boolean `satisfied` when a JSON-parsed socket has satisfied/not_satisfied edges or `advance.when`.

## Loop metadata handling today

Loop types are declared in `src/types.ts`:

- `loops[id].sockets` groups sockets for UI/validation/iterator discovery.
- `loops[id].consumes` names the generator source and optional output/as/cursor/done overrides.
- `loops[id].iterator` is shared iterator metadata.
- `loops[id].exit` is documented in the type as: "Optional documented exit edge/condition for UI and validation. Runtime routing remains canonical edges."

Current runtime use of loop metadata is limited to iterator derivation and item setup:

- `src/runtime/pipeline.ts#resolveLoopIterators` derives `loop.iterator` from `loop.consumes` plus generator metadata.
- `src/runtime/pipeline.ts#loopIteratorForSocket` returns that iterator for any member socket.
- `src/castRuntime.ts#setCurrentItem` uses the iterator to expose the current item.

Runtime no longer treats legacy `loop.exit` as the canonical router. Prepared loadouts normalize socket-valued legacy `loop.exit.to` into `loops.<id>.exits`, and exhaustion routing reads canonical exit routes before terminal fallback. `loop.exit` remains compatibility/descriptive input.

## Why default loadouts work

The bundled default loadouts in `config/default.json` do not rely on `loop.exit` alone. They include explicit canonical runtime semantics on the Maintain socket:

- `parse: "json"` so the `satisfied` control field is available.
- `advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" }` so completed items advance and final completion routes to `end`.
- Edges such as `not_satisfied -> retry` and `always -> Build` so non-final successful items continue through the loop after `applyAdvance()` increments the cursor.

The default loop metadata (`loops.taskIteration.exit` / `loops.taskIteration.exits` and `loops.taskIteration.consumes`) matches this behavior for display/validation. In the structured model, executable post-exhaustion routing comes from loop-owned `exits`; socket-level `parse`, `advance`, `assign`, and normal `edges` still handle parsing, cursor advancement, state updates, and same-item routing.

## Historical UI-created loadout gap

Earlier UI-created loops in `src/webui/client/src/App.tsx` primarily authored descriptive `loops.<id>.exit` metadata plus normal cycle edges:

- `createTaskIteratorLoop()` wrote `loops[loopId] = { label, sockets, consumes: { from, output }, exit: { from: lastSelectedSocket, when: "satisfied", to: "end" } }`.
- `updateLoopExit()` and `clearLoopExit()` mutated only legacy/descriptive `loop.exit`.
- The loop editor copy said loop exits "use the same canonical edge model as graph edges", which was structurally true for validation but misleading before the structured `loops.<id>.exits` route model was introduced.
- UI save normalization handled generator sockets, but older paths did not consistently materialize loop exit-source parsing/advance or canonical exit route metadata.

This was the historical bug: a UI-authored Build → Maintain loop could save `loops.exit` and `loops.consumes` while leaving Maintain as `parse: "text"` with an unconditional back-edge. Current load/save/runtime preparation materializes/normalizes compatible loop semantics or reports conflicts, so the back-edge remains normal same-item continuation rather than the only executable behavior.

## Validation coverage and gap

`src/graph/graphValidation.ts` validates:

- Socket ids and target existence for entries, edges, `foreach.done`, `advance.done`, `loops.consumes.done`, `loops.iterator.done`, and `loops.exit.to`.
- Canonical edge conditions on socket edges and `loops.exit.when`.
- No edges after an unconditional `always` edge.
- Loop structural topology: selected sockets must contain a directed cycle and, for generator loops, exactly one inbound generator edge matching `loops.consumes.from`.

The cleanup added shared preparation/normalization boundaries for executable loop semantics. Validation should continue to reject unknown non-sentinel targets and incompatible parse/advance conflicts while treating legacy `advance.done` and `loop.exit` as migration compatibility, not preferred new-model routing.

## Implementation note

The clean unification point is a shared semantic materialization/analysis layer invoked from both load/run time and UI validation/save paths. The UI should be allowed to author high-level intent (`loops.exit` + `loops.consumes`), but the runtime should continue to execute one canonical model: socket `parse`, `advance`, and ordered `edges`.

Recommended placement:

1. Add a shared materializer near the existing graph/pipeline normalization boundary, likely alongside `graphValidation.ts`/`pipeline.ts`, because both runtime config loading and the UI already import graph normalization/validation there.
2. Have runtime call it before `resolvePipeline()` validates/resolves sockets, so old saved user loadouts are repaired or rejected with actionable conflicts at run time.
3. Have UI validation/save call the same analyzer/materializer or its dry-run diagnostics, so users see the same conflicts before saving.
4. Materialize only missing, safe canonical fields: set JSON parsing where satisfied/not_satisfied control is required, add compatible `advance` derived from `loop.consumes` and `loop.exit`, and preserve existing compatible explicit semantics. Report conflicts rather than overwriting explicit incompatible fields.

This preserves working hand-authored defaults while making UI-authored loadouts executable in the same way. The compatibility layer must remain named, documented, test-covered, and sunsettable; see `docs/loop-compatibility-sunset.md` for the current inventory.
