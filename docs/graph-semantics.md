# Graph semantics

Materia graphs are ordered workflow state machines. They may branch, loop, and run deterministic utility nodes before or between agent turns.

## Canonical edge conditions

All graph links use the same canonical edge model:

```json
{ "when": "always", "to": "Build" }
```

The supported `when` values are:

- `always`: an unconditional transition. The UI may label this as **Flow**, but Flow is not a separate edge type; it is the `always` condition of the canonical edge model.
- `satisfied`: follows when the previous JSON handoff contains `{ "satisfied": true }`.
- `not_satisfied`: follows when the previous JSON handoff contains `{ "satisfied": false }`.

Edges are evaluated in order and the first matching edge wins. Put guarded edges before any `always` edge, because edges after an unconditional edge are unreachable.

## Generator and loop-consumer regions

Loops are explicit regions under a loadout's `loops` object. A loop region groups node ids, consumes at most one generator-provided list with `consumes: { from, output }`, derives shared iterator metadata from the referenced materia's `generates` declaration, and documents an exit condition using the same canonical edge conditions as normal edges.

A generator materia declares its list contract at the top level:

```json
"planner": {
  "tools": "readOnly",
  "prompt": "Return { \"tasks\": [...] }.",
  "generates": {
    "output": "tasks",
    "listType": "array",
    "itemType": "task",
    "as": "task",
    "cursor": "taskIndex",
    "done": "end"
  }
}
```

Any node whose loop consumes that generator must parse JSON and assign the declared output from the handoff JSON, for example `"parse": "json"` and `"assign": { "tasks": "$.tasks" }`. The derived loop iterator defaults to `state.<output>` unless `generates.items` supplies an explicit runtime state path.

The default software workflow models task iteration as:

```text
Build --always--> Auto-Eval --satisfied--> Maintain --always--> Build
                         └--not_satisfied--> Build
```

The loop consumes the planner generator's `tasks` output, which derives an iterator over `state.tasks`; each member node handles the current task until `Maintain` advances the cursor. The loop exits to `end` when the cursor reaches the generator-derived `done` target.

## Utility materia and generator/consumer styling

Built-in setup/discovery steps such as `ensureArtifactsIgnored` and `detectVcs` are first-class utility materia. They appear in the WebUI palette under the Utility group and can be placed in sockets like agent materia. Palette-created utility nodes render and execute through the same graph runtime as generated utility nodes.

Generator materia are marked with a **Generator** badge. Sockets inside loop regions are marked as **Loop consumer** instead of labeling arbitrary loop members as iterators. The badge is the accessible cue; the overlay preserves the materia's configured base color.

## Example

See [`../examples/graph-semantics-loadout.json`](../examples/graph-semantics-loadout.json) for a complete loadout that combines utility materia, `always`/`satisfied`/`not_satisfied` edges, a generator materia, and the Build → Eval → Maintain task loop.

## Contributor commands

Common local checks:

```bash
npm run typecheck
npm test        # bun test
npm run test:webui
npm run build:webui
```
