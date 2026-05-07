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

## Loop and iterator regions

Loops are explicit regions under a loadout's `loops` object. A loop region groups node ids, can provide shared `foreach` iterator metadata, and documents an exit condition using the same canonical edge conditions as normal edges.

The default software workflow models task iteration as:

```text
Build --always--> Auto-Eval --satisfied--> Maintain --always--> Build
                         └--not_satisfied--> Build
```

The loop has an iterator over `state.tasks`; each member node handles the current task until `Maintain` advances the cursor. The loop exits to `end` when the cursor reaches the iterator `done` target.

## Utility materia and iterator styling

Built-in setup/discovery steps such as `ensureArtifactsIgnored` and `detectVcs` are first-class utility materia. They appear in the WebUI palette under the Utility group and can be placed in sockets like agent materia. Palette-created utility nodes render and execute through the same graph runtime as generated utility nodes.

Iterator-enabled materia or sockets have an **Iterator** badge and a metallic overlay in the palette and graph. The badge is the accessible cue; the overlay preserves the materia's configured base color.

## Example

See [`../examples/graph-semantics-loadout.json`](../examples/graph-semantics-loadout.json) for a complete loadout that combines utility materia, `always`/`satisfied`/`not_satisfied` edges, and the Build → Eval → Maintain task loop.

## Contributor commands

Common local checks:

```bash
npm run typecheck
npm test        # bun test
npm run test:webui
npm run build:webui
```
