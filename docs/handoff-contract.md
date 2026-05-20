# Materia handoff JSON contract

JSON-parsed materia sockets hand off reusable work context to the rest of the graph by returning a single JSON object. Sockets are the placement adapters: they decide parse mode, assignment, routing, and iteration. Materia should stay reusable behavior/skill units.

## Canonical generic envelope

When applicable, JSON-producing agent materia return this envelope:

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

Generated units of work use `workItems`, not `tasks`. pi-materia intentionally does not keep a `tasks` stability layer for newly generated work units; adapters should assign and iterate `workItems` directly:

```json
{
  "id": "stable-id",
  "title": "short title",
  "description": "actionable work",
  "acceptance": ["observable criteria"],
  "context": {
    "architecture": "optional guidance",
    "constraints": [],
    "dependencies": [],
    "risks": []
  }
}
```

JSON sockets should preserve useful existing `summary`, `workItems`, `guidance`, `decisions`, and `risks` context, augmenting it when possible. The output should be the object only: no markdown fences, prose, or extra commentary. Plain text sockets (`"parse": "text"`) do not use this JSON handoff contract.

## Prompt layering

Prompt assembly exposes the shared handoff summary through synthetic cast context for JSON sockets that are ready to produce final output. Socket-local prompt suffixes should stay thin: JSON-only formatting, generated-output placement in `workItems`, upstream `workItems` context for generator transforms, and multi-turn finalization/refinement guidance. Do not copy this full envelope schema into generated socket prompts or role-generation prompts; refer to the runtime-provided canonical handoff contract instead.

## Generator pipeline contract

Materia marked `generator: true` produce generated work through the same handoff envelope. Their canonical output is always the top-level `workItems` array. A generator socket, including a generator upstream of another generator, must use JSON parsing and expose `workItems` (for example, `"assign": { "workItems": "$.workItems" }`).

Generator-to-generator pipelines behave like iterator transforms: the upstream generator emits `workItems`; the downstream generator consumes that context, transforms or filters it, and emits a new handoff JSON object with its own `workItems`. `workItems` is the canonical generator payload; do not author `tasks`, `task`, `work`, or custom output names for generated work.

## Reserved evaluator/route fields

`satisfied` is the canonical routing field.

- `satisfied` is reserved by pi-materia for `satisfied` / `not_satisfied` routing and advancement.
- `feedback` and `missing` are reserved evaluator fields.
- Reserved evaluator/route fields must not be repurposed by general payload logic.
- When present, `satisfied` must be a JSON boolean (`true` or `false`).
- When present, `feedback` must be a JSON string.
- When present, `missing` must be a JSON array of missing items.
- Sockets whose graph control flow depends on `satisfied` or `not_satisfied` must return `satisfied`.
- Do not use current aliases such as `passed` as routing fields. They are not canonical handoff fields.

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
  "summary": "Add canonical handoff documentation.",
  "workItems": [
    {
      "id": "docs-contract-update",
      "title": "Document the handoff contract",
      "description": "Add canonical JSON handoff docs.",
      "acceptance": ["Docs explain satisfied routing"],
      "context": {
        "architecture": "Keep materia reusable; keep placement logic in adapters.",
        "constraints": ["Do not emit tasks"],
        "dependencies": [],
        "risks": []
      }
    }
  ],
  "guidance": {},
  "decisions": [],
  "risks": [],
  "satisfied": true,
  "feedback": "",
  "missing": []
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
  "summary": "README branch syntax is still stale.",
  "workItems": [],
  "guidance": {},
  "decisions": [],
  "risks": [],
  "satisfied": false,
  "feedback": "The README still links to stale branch syntax.",
  "missing": ["Update README edge examples"]
}
```
