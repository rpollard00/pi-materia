# Materia handoff JSON contract

JSON-parsed materia nodes hand off reusable work context to the rest of the graph by returning a single JSON object. Nodes and sockets are the placement adapters: they decide parse mode, assignment, routing, and iteration. Materia should stay reusable behavior/skill units.

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

Generated units of work use `workItems`, not `tasks`:

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

JSON nodes should preserve useful existing `summary`, `workItems`, `guidance`, `decisions`, and `risks` context, augmenting it when possible. The output should be the object only: no markdown fences, prose, or extra commentary. Plain text nodes (`"parse": "text"`) do not use this JSON handoff contract.

## Reserved evaluator/route fields

`satisfied` is the canonical routing field.

- `satisfied` is reserved by pi-materia for `satisfied` / `not_satisfied` routing and advancement.
- `feedback` and `missing` are reserved evaluator fields.
- Reserved evaluator/route fields must not be repurposed by general payload logic.
- When present, `satisfied` must be a JSON boolean (`true` or `false`).
- Nodes whose graph control flow depends on `satisfied` or `not_satisfied` must return `satisfied`.
- Do not use legacy aliases such as `passed` as routing fields. They are not canonical handoff fields.

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
  "next": "Build"
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
