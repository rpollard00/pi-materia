# Materia handoff JSON contract

JSON-parsed agent sockets hand off reusable work context by returning a single JSON object. Sockets are placement adapters: they decide parse mode, assignment, routing, and iteration. Materia should stay reusable behavior/skill units.

## Agent handoff fields

Agent-authored handoff JSON is intentionally small. The only top-level fields in the agent contract are:

- `workItems`: an optional array of generated or refined work units.
- `satisfied`: an optional boolean reserved for `satisfied` / `not_satisfied` graph control.
- `context`: optional explanatory text for downstream agents.

Shape reference:

```json
{
  "workItems": [],
  "satisfied": true,
  "context": "plain text handoff context"
}
```

Do not ask agents to emit a broad envelope. Obsolete broad-envelope fields such as `summary`, `guidance`, `decisions`, `risks`, `feedback`, `missing`, or `state` are not part of the agent handoff contract.

## Generated work items

Generated units of work use `workItems`, not `tasks`. Each agent-produced work item contains only `title:string` and `context:string`:

```json
{
  "title": "Document sparse JSON payloads",
  "context": "Explain the small agent handoff contract and update examples that still show broad envelopes."
}
```

Agents should not invent work item `id` values, duplicate the title into `description`, provide `acceptance` arrays, or create nested `context` objects. Runtime/UI code may derive internal loop keys such as `WI-1` from position or loop state, but those keys are not model-authored handoff fields. Displays should label generated work from `workItems[].title`; derived keys are diagnostic/runtime labels only.

For model output, return the object only: no markdown fences, prose, or extra commentary. Plain text sockets (`"parse": "text"`) do not use JSON output requirements.

## Utility/script state is separate

Utility and script materia are deterministic producers, not model-authored agent handoffs. When configured, they may return structured data under a top-level `state` object for shallow merging into runtime state. That utility `state` patch is separate from agent handoff fields and should not be mixed into agent-authored JSON. Utilities may also expose explicitly documented script-owned fields for `assign`, but they should not mimic a broad agent envelope.

Graph-control fields remain outside utility state: `workItems` drives loops and `satisfied` drives routing/advancement.

## Prompt layering

Prompt assembly should describe only the socket-relevant fields. Generator/planner prompts should ask for `workItems` with `title` and `context`. Evaluator prompts should ask for `satisfied` plus textual `context` when useful. Do not copy a full runtime state schema into role-generation prompts or socket suffixes.

## Generator pipeline contract

Materia marked `generator: true` produce generated work as a sparse JSON payload with a top-level `workItems` array. A generator socket, including a generator upstream of another generator, must use JSON parsing and expose `workItems` (for example, `"assign": { "workItems": "$.workItems" }`).

Generator-to-generator pipelines behave like iterator transforms: the upstream generator emits `workItems`; the downstream generator consumes that context, transforms or filters it, and emits a new payload with its own `workItems`. `workItems` is the canonical generator payload; do not author `tasks`, `task`, `work`, or custom output names for generated work.

## Reserved route field

`satisfied` is the canonical routing field.

- `satisfied` is reserved by pi-materia for `satisfied` / `not_satisfied` routing and advancement.
- When present, `satisfied` must be a JSON boolean (`true` or `false`).
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
  "workItems": [
    {
      "title": "Document sparse JSON payloads",
      "context": "Update handoff documentation and examples to show only title/context work items."
    }
  ],
  "context": "Planner found stale examples that still show broad handoff fields."
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
  "context": "The README still links to stale branch syntax."
}
```
