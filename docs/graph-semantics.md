# Graph semantics

Materia graphs are ordered workflow state machines. They may branch, loop, and run deterministic utility sockets before or between agent turns.

For the structured loop contract, see [Structured loop semantics](structured-loop-semantics.md). Normal edges route current-item control flow, `advance` increments cursors and detects exhaustion, `loops.<id>.exits` owns post-exhaustion routing, and `end` is the graph/loadout terminal sentinel.

## Edge conditions

All graph links use the same edge model:

```json
{ "when": "always", "to": "Socket-4" }
```

Supported `when` values:

- `always`: unconditional transition.
- `satisfied`: follows when parsed JSON contains `{ "satisfied": true }`.
- `not_satisfied`: follows when parsed JSON contains `{ "satisfied": false }`.

Edges are evaluated in order and the first matching edge wins. Put guarded edges before any `always` edge.

`not_satisfied` is generic graph control meaning the current item needs follow-up at the selected target. It is not evaluator-only terminology. When a `satisfied:false` result selects a `not_satisfied` edge, runtime captures bounded source/reason provenance and renders it into the next matching prompt as follow-up/rework context; agents still emit only canonical handoff fields. See [Socket rework context semantics](socket-rework-context.md).

## Output parsing and control fields

`parse` is the persisted output parsing field for loadout sockets. Use `parse: "json"` for sockets whose output feeds `assign`, `advance`, or guarded routing. Use `parse: "text"` or omit `parse` only for plain-text outputs.

`satisfied` is the boolean control field read by `satisfied` / `not_satisfied` edges and `advance.when`.

## Generator and loop-consumer regions

Loops are explicit regions under a loadout's `loops` object. A loop region groups socket ids, consumes at most one generator-provided list with `consumes: { from, output }`, and uses `loops.<id>.exits` for post-exhaustion routes.

A Generator materia uses `generator: true`. Runtime resolves that marker to the work-items contract (`workItems`, `workItem`, `workItemIndex`, `end`). A generator socket must parse JSON and expose top-level `workItems` from its sparse JSON payload.

```json
"Auto-Plan": {
  "tools": "readOnly",
  "prompt": "Return compact JSON with ordered workItems. Each item has title and context strings.",
  "generator": true
}
```

A loadout declares the consumer region separately from the generator materia:

```json
"loops": {
  "workItemIteration": {
    "sockets": ["Socket-4", "Socket-5", "Socket-6"],
    "consumes": { "from": "Socket-3", "output": "workItems" },
    "exits": [
      { "id": "exit:Socket-6:satisfied", "from": "Socket-6", "condition": "satisfied", "targetSocketId": "Socket-7" }
    ]
  }
}
```

`consumes.from` is the socket id of the generator socket, not the materia definition name. Socket ids are sequential placement identifiers (`Socket-1`, `Socket-2`, ...). Keep materia identity in the socket's `materia` field and in materia definition metadata.

The default software workflow models work-item iteration as:

```text
Socket-4 (Build) --always--> Socket-5 (Auto-Eval) --satisfied--> Socket-6 (Maintain) --always--> Socket-4 (Build)
                                               └--not_satisfied--> Socket-4 (Build)
```

## Loop-owned exit routes

Loops declare explicit post-completion routes in `loops.<id>.exits`. These records are graph semantics owned by the loop, not normal socket `edges`, not generator edges, and not persisted derived render/runtime edges:

```json
"loops": {
  "workItemIteration": {
    "sockets": ["Socket-4", "Socket-5", "Socket-6"],
    "exits": [
      { "id": "exit:Socket-6:always", "from": "Socket-6", "condition": "always", "targetSocketId": "Socket-7" },
      { "id": "exit:Socket-6:satisfied", "from": "Socket-6", "condition": "satisfied", "targetSocketId": "Socket-8" },
      { "id": "exit:Socket-6:not_satisfied", "from": "Socket-6", "condition": "not_satisfied", "targetSocketId": "Socket-9" }
    ]
  }
}
```

Each route id is stable and unique within the owning loop. `from` is the loop member socket that acts as the loop exit, and `targetSocketId` must be an existing socket. Breaking or deleting a loop removes its `exits` metadata.

Route resolution is deterministic. A final `{ "satisfied": true }` result selects `satisfied`, then `always`, then `end`. A final `{ "satisfied": false }` result selects `not_satisfied`, then `always`, then `end`. Without a boolean result, only `always` can match before `end`.

The WebUI derives visual edges for these routes with stable ids like `loop-exit:<loopId>:<routeId>`. Editing or deleting those visual edges mutates `loops.<id>.exits`, not normal socket edges.

## Utility materia and generator/consumer styling

Bundled setup/discovery steps such as `Ignore-Artifacts` and `Detect-VCS` are utility materia. They appear in the WebUI palette under the Utility group and execute through the same graph runtime as agent materia.

Generator materia are marked with a **Generator** badge. Sockets inside loop regions are marked as **Loop consumer**. The badge is the accessible cue; the overlay preserves the materia's configured base color.

## Example

See [`../examples/graph-semantics-loadout.json`](../examples/graph-semantics-loadout.json) for a complete loadout that combines utility materia, edge conditions, a sparse-payload generator materia, sequential `Socket-N` ids, and the Build → Eval → Maintain work-item loop.

## Contributor commands

```bash
npm run typecheck
npm test
npm run test:webui
npm run build:webui
```
