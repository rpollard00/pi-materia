# Graph semantics

Materia graphs are ordered workflow state machines. They may branch, loop, and run deterministic utility sockets before or between agent turns.

For the normative structured loop contract that future runtime, validation, link compilation, and materialization work must follow, see [Structured loop semantics](structured-loop-semantics.md). In short: normal edges route current-item control flow, `advance` increments cursors and detects exhaustion, `loops.<id>.exits` owns post-exhaustion routing, and `end` is only the graph/loadout terminal sentinel.

## Canonical edge conditions

All graph links use the same canonical edge model:

```json
{ "when": "always", "to": "Socket-4" }
```

The supported `when` values are:

- `always`: an unconditional transition. The UI may label this as **Flow**, but Flow is not a separate edge type; it is the `always` condition of the canonical edge model.
- `satisfied`: follows when the previous JSON handoff contains `{ "satisfied": true }`.
- `not_satisfied`: follows when the previous JSON handoff contains `{ "satisfied": false }`.

Edges are evaluated in order and the first matching edge wins. Put guarded edges before any `always` edge, because edges after an unconditional edge are unreachable.

## Canonical output parsing and control fields

`parse` is the canonical persisted output parsing field for loadout sockets. UI-authored loadouts and JSON-authored defaults must save the same semantics here: use `parse: "json"` for sockets whose output is structured JSON that feeds `assign`, `advance`, or guarded routing, and use `parse: "text"` or omit `parse` only for plain-text outputs.

`satisfied` is the only canonical boolean satisfaction/control field. `satisfied` and `not_satisfied` edges, and `advance.when: "satisfied"`, read the parsed JSON handoff's boolean `satisfied` value. Because that value is only available after JSON parsing, any socket with `satisfied` / `not_satisfied` routing must have `parse: "json"`; text-outputting sockets may only use `always` edges. Legacy aliases such as `passed` are migration-only compatibility if encountered in old configs or tests; do not author new defaults, reusable materia, UI saves, or prompts that depend on them.

When adding reusable materia or defaults, make the socket `parse` value explicit whenever routing or state assignment depends on structured output. Palette/UI-created sockets should preserve this canonical `parse` setting so UI-authored and hand-written JSON loadouts remain equivalent.

## Generator and loop-consumer regions

Loops are explicit regions under a loadout's `loops` object. A loop region groups socket ids, consumes at most one generator-provided list with `consumes: { from, output }`, derives shared iterator metadata from the referenced materia's canonical Generator config, and declares an exit condition with `exit: { from, when, to }` using the same canonical edge conditions as normal edges. For generator-consuming loops, `loops.exit` plus `loops.consumes` is materialized into the canonical runtime fields on the exit source: `parse: "json"` when `satisfied` / `not_satisfied` control is needed, and an `advance` block whose `cursor`/`items` come from the consumed generator output and whose `done`/`when` come from the loop exit. The normal ordered `edges` remain canonical routing; `advance` runs before edge selection, so unconditional back-edges continue non-final items while `advance.done` exits after the consumed items are complete. The `exit.from` socket must exist and be one of the loop members. See [Loop semantics](loop-semantics.md) for migration behavior, conflict handling, and full examples.

A Generator materia uses the semantic authored marker `generator: true`. Runtime resolves that marker to the canonical work-items contract (`workItems`, `workItem`, `workItemIndex`, `end`). A generator socket must parse JSON and expose `workItems` from the canonical handoff envelope. For reusable work planning, use the generic handoff envelope and generate `workItems`; do not retain `tasks`, `work`, or custom `generates.output` aliases as compatibility outputs for newly generated units of work:

```json
"planner": {
  "tools": "readOnly",
  "prompt": "Return the generic handoff envelope with workItems.",
  "generator": true
}
```

Any generator socket whose loop consumes that generator must parse JSON and assign the canonical output from the handoff JSON, for example `"parse": "json"` and `"assign": { "workItems": "$.workItems" }`. The derived loop iterator defaults to `state.workItems`. If validation reports `Generator pipeline slot "Socket-N" must parse JSON and expose generated output "workItems" from the canonical handoff envelope`, fix the named socket by setting `parse: "json"` and assigning `workItems` from `$.workItems`.

A loadout declares the consumer region separately from the generator materia:

```json
"loops": {
  "workItemIteration": {
    "label": "Build → Eval → Maintain until all work items complete",
    "sockets": ["Socket-4", "Socket-5", "Socket-6"],
    "consumes": { "from": "Socket-3", "output": "workItems" },
    "exit": { "from": "Socket-6", "when": "satisfied", "to": "end" }
  }
}
```

`consumes.from` is the socket id of the generator socket, not the materia definition name. `consumes.output` defaults to the canonical Generator output `workItems`; include it only to be explicit or when migrating a legacy config. Optional `as`, `cursor`, and `done` overrides belong on `consumes` only when that loop intentionally differs from the generator defaults.

In the bundled default loadouts, socket ids are sequential placement identifiers (`Socket-1`, `Socket-2`, ...). Keep materia identity in the socket's `materia`, `utility`, labels, or palette metadata rather than encoding names such as `Build` or `planner` into socket ids. User-facing displays may combine both, for example `Socket-4 (Build)`, but routing, loop `sockets`, `consumes.from`, `exit.from`, and `advance` references should use the socket ids.

The WebUI creates these regions from selected sockets. Select the sockets that form the cycle using shift-click or by dragging a selection rectangle around the socket cards, then choose **Create Loop**. Creation succeeds only when the selected sockets already contain a directed cycle and exactly one edge enters that cycle from a Generator materia. The generator edge is highlighted and the loop region label shows that it consumes canonical `workItems`.

The default software workflow models work-item iteration as:

```text
Socket-4 (Build) --always--> Socket-5 (Auto-Eval) --satisfied--> Socket-6 (Maintain) --always--> Socket-4 (Build)
                                               └--not_satisfied--> Socket-4 (Build)
```

The loop consumes the planner generator's `workItems` output, which derives an iterator over `state.workItems`; each member socket handles the current work item until `Maintain` advances the cursor. Build-style text sockets consume the current `workItem` plus global guidance supplied by the adapter context and summarize implementation; they do not decide parsing, assignment, routing, or iteration themselves. The documented exit summary renders source-aware, for example `exit=Socket-6.satisfied->end`, and the loop exits to `end` when the materialized `advance` block reaches the generator-derived consumed-list boundary.

## Loop-owned exit routes

Loops declare explicit post-completion routes in `loops.<id>.exits`. These records are canonical graph semantics owned by the loop, not normal socket `edges`, not generator edges, and not persisted derived render/runtime edges:

```json
"loops": {
  "workItemIteration": {
    "sockets": ["Socket-4", "Socket-5", "Socket-6"],
    "exit": { "from": "Socket-6", "when": "satisfied", "to": "end" },
    "exits": [
      { "id": "exit:Socket-6:always", "from": "Socket-6", "condition": "always", "targetSocketId": "Socket-7" },
      { "id": "exit:Socket-6:satisfied", "from": "Socket-6", "condition": "satisfied", "targetSocketId": "Socket-8" },
      { "id": "exit:Socket-6:not_satisfied", "from": "Socket-6", "condition": "not_satisfied", "targetSocketId": "Socket-9" }
    ]
  }
}
```

Each route id is stable and unique within the owning loop. `from` is the loop member socket that acts as the loop exit, `targetSocketId` must be an existing socket (not `end`), and there may be at most one route for each `condition` per `from` socket. Breaking or deleting a loop removes its `exits` metadata; pi-materia must not convert those routes into normal outgoing edges or leave stale materialized `advance.done` routes behind.

Route resolution is centralized and deterministic. When the loop finishes with canonical `{ "satisfied": true }`, a `satisfied` route wins, then `always`, then terminal `end` if no route exists. When it finishes with `{ "satisfied": false }`, a `not_satisfied` route wins, then `always`, then terminal `end` if no route exists. When the satisfaction outcome is unavailable, only `always` may be selected before falling back to `end`. The resolver reads only the canonical boolean `satisfied` field. `passed` is not a canonical loop-exit field; any compatibility handling for `passed` belongs only to explicit migrations or negative compatibility tests, not to authored loadouts or new prompts. Legacy `loops.exit.to` / `advance.done` routing is migration compatibility, not the future authoring model.

The WebUI derives special visual edges for these routes with stable ids like `loop-exit:<loopId>:<routeId>` and labels such as **Upon Loop Exit**, **Upon Loop Exit: Satisfied**, and **Upon Loop Exit: Not Satisfied**. Editing or deleting those visual edges mutates `loops.<id>.exits`, not normal socket edges.

Generator-to-generator chaining uses the same contract. An upstream generator emits a handoff envelope with `workItems`; a downstream generator may consume those items, refine or split them, and must itself return a JSON handoff envelope with a new canonical `workItems` array:

```json
{
  "materia": {
    "planner": { "tools": "readOnly", "prompt": "Draft epics as workItems.", "generator": true },
    "refiner": { "tools": "readOnly", "prompt": "Refine incoming workItems and emit the next workItems envelope.", "generator": true },
    "Build": { "tools": "coding", "prompt": "Build the adapter-provided workItem." }
  },
  "loadouts": {
    "Chained-Generators": {
      "entry": "Socket-1",
      "sockets": {
        "Socket-1": { "type": "agent", "materia": "planner", "parse": "json", "assign": { "workItems": "$.workItems" }, "next": "Socket-2" },
        "Socket-2": { "type": "agent", "materia": "refiner", "parse": "json", "assign": { "workItems": "$.workItems" }, "next": "Socket-3" },
        "Socket-3": { "type": "agent", "materia": "Build", "next": "end" }
      }
    }
  }
}
```

The important invariant is that every generator stage in the pipeline consumes and produces the canonical `workItems` envelope; generator chaining is not an untyped “always show” connection.

## Utility materia and generator/consumer styling

Built-in setup/discovery steps such as `ensureArtifactsIgnored` and `detectVcs` are first-class utility materia. They appear in the WebUI palette under the Utility group and can be placed in sockets like agent materia. Palette-created utility sockets render and execute through the same graph runtime as generated utility sockets.

Generator materia are marked with a **Generator** badge. Sockets inside loop regions are marked as **Loop consumer** instead of labeling arbitrary loop members as iterators. The badge is the accessible cue; the overlay preserves the materia's configured base color.

## Migration and compatibility

`satisfied` is the canonical boolean route/control field for `satisfied` / `not_satisfied` edges and `advance.when`. Legacy aliases are migration-only when they are mentioned by old notes or negative tests; do not author new loadouts that depend on aliases such as `passed`.

Saved UI loadouts that already declare `loops.exit` and generator `consumes` but are missing executable socket-level fields are normalized through the shared materializer in `loadConfig()`, `saveMateriaConfigPatch()`, WebUI save normalization, and `resolvePipeline()`. Compatible hand-authored fields are preserved. Conflicts, such as `parse: "text"` on a `satisfied` exit source or an existing `advance` whose cursor/items/done/when do not match the loop declaration, fail with remediation messages instead of being silently rewritten.

Older layouts may have loop regions with direct `iterator` metadata but no `consumes` generator declaration. pi-materia preserves explicit iterator-only loops for non-generator workflows. When a legacy iterator loop has exactly one inbound edge from a generator materia, `resolvePipeline` migrates the resolved loop by adding `consumes: { from, output }` from that generator while preserving the original iterator fields for runtime compatibility.

If a legacy iterator loop has more than one inbound generator edge, pi-materia fails with a remediation error that names the candidate generator sockets. Fix the layout by adding an explicit `loops.<id>.consumes` entry and ensuring only one generator edge enters the selected cycle. If the intended generator is not detected, set `generator: true` on that materia and make the generator socket parse JSON with `assign: { "workItems": "$.workItems" }`. Existing authored `generates` metadata is migration-only compatibility, not as the canonical schema; legacy `tasks`, `work`, and custom generated-output aliases are not active generator outputs.

## Example

See [`../examples/graph-semantics-loadout.json`](../examples/graph-semantics-loadout.json) for a complete loadout that combines utility materia, `always`/`satisfied`/`not_satisfied` edges, a generic-envelope generator materia, sequential `Socket-N` ids, and the Build → Eval → Maintain work-item loop.

## Contributor commands

Common local checks:

```bash
npm run typecheck
npm test        # bun test
npm run test:webui
npm run build:webui
```
