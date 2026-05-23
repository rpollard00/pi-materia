# Materia handoff JSON contract

JSON-parsed materia sockets hand off reusable work context to the rest of the graph by returning a single JSON object. Sockets are the placement adapters: they decide parse mode, assignment, routing, and iteration. Materia should stay reusable behavior/skill units.

## Canonical runtime state and sparse socket payloads

pi-materia carries a canonical handoff state internally. JSON-producing sockets do **not** have to emit the whole state object. Each JSON socket should return only the fields relevant to its configured role, assignments, routing, and advancement; runtime validation checks those socket-local requirements and then merges the sparse payload into canonical state.

The exact canonical runtime-carried fields and their scopes are:

- `summary`: optional concise cross-cutting summary of the current handoff state or generated payload.
- `workItems`: optional top-level array of generated or refined work units. Generated units belong only here, never in `tasks`, `task`, `work`, `architectureGuidance`, top-level `architecture`, or other aliases.
- `guidance`: optional cross-cutting guidance object/string/notes only when socket-relevant or explicitly requested; do not use it for item-specific architecture notes.
- `decisions`: optional cross-cutting decision records only when socket-relevant or explicitly requested.
- `risks`: optional cross-cutting risks only when socket-relevant or explicitly requested; item risks belong in `workItems[].context.risks`.
- `satisfied`: reserved evaluator/route-owned boolean for satisfied/not_satisfied graph control.
- `feedback`: reserved evaluator-owned string for route/evaluation feedback, not a general guidance channel.
- `missing`: reserved evaluator-owned array of missing items, not a general guidance channel.

Shape reference:

```json
{
  "summary": "string",
  "workItems": [],
  "guidance": {},
  "decisions": [],
  "risks": [],
  "satisfied": true,
  "feedback": "string",
  "missing": []
}
```

Generated units of work use `workItems`, not `tasks`. Generated units belong in top-level `workItems`. pi-materia intentionally does not keep a `tasks` stability layer for newly generated work units; adapters should assign and iterate `workItems` directly. Item-specific architecture direction belongs in `workItems[].context.architecture`; item constraints, dependencies, and risks belong in the matching `workItems[].context` arrays:

```json
{
  "id": "stable-id",
  "title": "short title",
  "description": "actionable work",
  "acceptance": ["observable criteria"],
  "context": {
    "architecture": "Use the existing adapter boundary; keep routing outside reusable materia.",
    "constraints": ["Keep prompt suffixes concise"],
    "dependencies": [],
    "risks": ["Broad wording could make agents emit unnecessary top-level fields"]
  }
}
```

For model output, return the object only: no markdown fences, prose, or extra commentary. Plain text sockets (`"parse": "text"`) do not use JSON output requirements.

If a JSON-parsed agent socket returns malformed JSON or a payload missing fields required by that socket, pi-materia performs a bounded same-socket repair retry before applying assignments or advancing the graph. The retry asks for corrected JSON only; utility JSON validation still fails fast.

## Prompt layering

Prompt assembly exposes canonical runtime context through synthetic cast context for JSON sockets that are ready to produce final output. Socket-local prompt suffixes stay thin and requirement-driven: JSON-only formatting, generated-output placement in `workItems`, consumed assignment paths, routing fields such as `satisfied`, and multi-turn finalization/refinement guidance. Do not copy the full runtime state schema into generated socket prompts or role-generation prompts; describe only the socket-relevant payload fields.

## Generator pipeline contract

Materia marked `generator: true` produce generated work as a sparse JSON payload with a top-level `workItems` array. A generator socket, including a generator upstream of another generator, must use JSON parsing and expose `workItems` (for example, `"assign": { "workItems": "$.workItems" }`).

Generator-to-generator pipelines behave like iterator transforms: the upstream generator emits `workItems`; the downstream generator consumes that context, transforms or filters it, and emits a new payload with its own `workItems`. `workItems` is the canonical generator payload; do not author `tasks`, `task`, `work`, or custom output names for generated work.

## Reserved evaluator/route fields

`satisfied`, `feedback`, and `missing` are route/evaluator-owned, not general-purpose content fields.

`satisfied` is the canonical routing field.

- `satisfied` is reserved by pi-materia for `satisfied` / `not_satisfied` routing and advancement.
- `feedback` and `missing` are reserved evaluator fields.
- Reserved evaluator/route fields must not be repurposed by general payload logic or used as general guidance channels.
- When present, `satisfied` must be a JSON boolean (`true` or `false`).
- When present, `feedback` must be a JSON string.
- When present, `missing` must be a JSON array of missing items.
- Sockets whose graph control flow depends on `satisfied` or `not_satisfied` must return `satisfied`.
- Do not use legacy aliases such as `passed` as routing fields. They are obsolete compatibility behavior if encountered, not canonical handoff fields.

## Routing semantics

Graph edge conditions use canonical condition names, not JSONPath expressions:

```json
{
  "edges": [
    { "when": "satisfied", "to": "Maintain" },
    { "when": "not_satisfied", "to": "Build", "maxTraversals": 3 }
  ]
}
```

At runtime, `when: "satisfied"` matches only `{ "satisfied": true }`, `when: "not_satisfied"` matches only `{ "satisfied": false }`, and `when: "always"` is unconditional. `advance.when` uses the same canonical conditions.

## Planner example

```json
{
  "summary": "Add sparse handoff documentation.",
  "workItems": [
    {
      "id": "docs-contract-update",
      "title": "Document sparse JSON payloads",
      "description": "Explain canonical runtime state and socket-specific JSON outputs.",
      "acceptance": ["Docs show compact planner and evaluator payloads"],
      "context": {
        "architecture": "Keep materia reusable; keep placement logic in adapters.",
        "constraints": ["Do not emit tasks"],
        "dependencies": [],
        "risks": []
      }
    }
  ]
}
```

A socket can assign that payload into cast state:

```json
{
  "parse": "json",
  "assign": { "workItems": "$.workItems" },
  "edges": [{ "when": "always", "to": "Build" }]
}
```

## Evaluator example

```json
{
  "satisfied": false,
  "feedback": "The README still links to stale branch syntax.",
  "missing": ["Update README edge examples"]
}
```

## Maintainer-style example

A socket that assigns maintenance diagnostics can return only the evaluator/control field plus consumed custom fields:

```json
{
  "satisfied": true,
  "feedback": "Checkpoint created.",
  "checkpointCreated": true,
  "vcs": "jj",
  "commands": ["jj status", "jj describe -m ...", "jj new"]
}
```
