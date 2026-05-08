# Graph semantics

Materia graphs are ordered workflow state machines. They may branch, loop, and run deterministic utility nodes before or between agent turns.

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

## Generator and loop-consumer regions

Loops are explicit regions under a loadout's `loops` object. A loop region groups node ids, consumes at most one generator-provided list with `consumes: { from, output }`, derives shared iterator metadata from the referenced materia's canonical Generator config, and documents an exit condition with `exit: { from, when, to }` using the same canonical edge conditions as normal edges. The `exit.from` socket must exist and be one of the loop members.

A Generator materia uses the semantic authored marker `generator: true`. Runtime resolves that marker to the canonical work-items contract (`workItems`, `workItem`, `workItemIndex`, `end`). For reusable work planning, use the generic handoff envelope and generate `workItems`; do not retain `tasks` as a compatibility output for newly generated units of work:

```json
"planner": {
  "tools": "readOnly",
  "prompt": "Return the generic handoff envelope with workItems.",
  "generator": true
}
```

Any node whose loop consumes that generator must parse JSON and assign the canonical output from the handoff JSON, for example `"parse": "json"` and `"assign": { "workItems": "$.workItems" }`. The derived loop iterator defaults to `state.workItems`.

A loadout declares the consumer region separately from the generator materia:

```json
"loops": {
  "workItemIteration": {
    "label": "Build → Eval → Maintain until all work items complete",
    "nodes": ["Socket-4", "Socket-5", "Socket-6"],
    "consumes": { "from": "Socket-3", "output": "workItems" },
    "exit": { "from": "Socket-6", "when": "satisfied", "to": "end" }
  }
}
```

`consumes.from` is the socket id of the generator node, not the materia definition name. `consumes.output` defaults to the canonical Generator output `workItems`; include it only to be explicit or when migrating a legacy config. Optional `as`, `cursor`, and `done` overrides belong on `consumes` only when that loop intentionally differs from the generator defaults.

In the bundled default loadouts, socket ids are sequential placement identifiers (`Socket-1`, `Socket-2`, ...). Keep materia identity in the node's `materia`, `utility`, labels, or palette metadata rather than encoding names such as `Build` or `planner` into socket ids. User-facing displays may combine both, for example `Socket-4 (Build)`, but routing, loop `nodes`, `consumes.from`, `exit.from`, and `advance` references should use the socket ids.

The WebUI creates these regions from selected sockets. Select the sockets that form the cycle using shift-click or by dragging a selection rectangle around the socket cards, then choose **Create Loop**. Creation succeeds only when the selected sockets already contain a directed cycle and exactly one edge enters that cycle from a Generator materia. The generator edge is highlighted and the loop region label shows which generated output it consumes.

The default software workflow models work-item iteration as:

```text
Socket-4 (Build) --always--> Socket-5 (Auto-Eval) --satisfied--> Socket-6 (Maintain) --always--> Socket-4 (Build)
                                               └--not_satisfied--> Socket-4 (Build)
```

The loop consumes the planner generator's `workItems` output, which derives an iterator over `state.workItems`; each member node handles the current work item until `Maintain` advances the cursor. Build-style text nodes consume the current `workItem` plus global guidance supplied by the adapter context and summarize implementation; they do not decide parsing, assignment, routing, or iteration themselves. The documented exit summary renders source-aware, for example `exit=Socket-6.satisfied->end`, and the loop exits to `end` when the cursor reaches the generator-derived `done` target.

## Utility materia and generator/consumer styling

Built-in setup/discovery steps such as `ensureArtifactsIgnored` and `detectVcs` are first-class utility materia. They appear in the WebUI palette under the Utility group and can be placed in sockets like agent materia. Palette-created utility nodes render and execute through the same graph runtime as generated utility nodes.

Generator materia are marked with a **Generator** badge. Sockets inside loop regions are marked as **Loop consumer** instead of labeling arbitrary loop members as iterators. The badge is the accessible cue; the overlay preserves the materia's configured base color.

## Legacy iterator migration

Older layouts may have loop regions with direct `iterator` metadata but no `consumes` generator declaration. pi-materia preserves explicit iterator-only loops for non-generator workflows. When a legacy iterator loop has exactly one inbound edge from a generator materia, `resolvePipeline` migrates the resolved loop by adding `consumes: { from, output }` from that generator while preserving the original iterator fields for runtime compatibility.

If a legacy iterator loop has more than one inbound generator edge, pi-materia fails with a remediation error that names the candidate generator sockets. Fix the layout by adding an explicit `loops.<id>.consumes` entry and ensuring only one generator edge enters the selected cycle. If the intended generator is not detected, set `generator: true` on that materia and make the generator socket parse JSON with `assign: { "workItems": "$.workItems" }`. Existing authored `generates` metadata is supported only as migration compatibility for saved configs, not as the canonical schema.

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
