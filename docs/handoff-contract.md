# Materia handoff JSON contract

JSON-parsed materia nodes hand off state to the rest of the graph by returning a single JSON object. This document is the canonical documentation for that handoff shape and for the reserved routing/control fields interpreted by pi-materia.

## Required shape

When a node is configured with `"parse": "json"`, its final assistant output must be a JSON object:

```json
{
  "satisfied": true,
  "feedback": "The task meets acceptance criteria.",
  "missing": []
}
```

The output should be the object only: no markdown fences, prose, or extra commentary. The object should be flat for control fields; payload fields may contain nested data when downstream assignments or prompts need it.

Nodes whose outputs are plain text (`"parse": "text"`) do not use this JSON handoff contract.

## Reserved control fields

`satisfied` is the canonical routing field.

- `satisfied` is reserved by pi-materia for `satisfied` / `not_satisfied` routing and advancement.
- When present, `satisfied` must be a JSON boolean (`true` or `false`), not a string, number, or nullable value.
- Nodes whose graph control flow depends on `satisfied` or `not_satisfied` must return `satisfied`.
- Do not use legacy aliases such as `passed` as routing fields. They are not canonical handoff fields.

All other top-level keys are materia payload fields unless pi-materia reserves them in the future. Payload fields can carry task lists, feedback, diagnostics, artifacts metadata, checkpoint results, or user-defined data, but they must not redefine or alias reserved control semantics.

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

At runtime:

- `when: "satisfied"` matches only a handoff object with `"satisfied": true`.
- `when: "not_satisfied"` matches only a handoff object with `"satisfied": false`.
- `when: "always"` is unconditional.
- `next` is the fallback link when no edge matches.
- `advance.when: "satisfied"` advances only when `satisfied` is `true`; `advance.when: "not_satisfied"` advances only when it is `false`.

Expression-style conditions such as `$.satisfied == true` are not the canonical config syntax. Use `when: "satisfied"` and `when: "not_satisfied"` instead.

## Examples

### Planner payload handoff

A planner node may not participate in satisfied/not-satisfied routing, so it can return only payload data:

```json
{
  "tasks": [
    {
      "id": "docs-contract-update",
      "title": "Document the handoff contract",
      "description": "Add canonical JSON handoff docs.",
      "acceptance": ["Docs explain satisfied routing"]
    }
  ]
}
```

A config can assign that payload into cast state:

```json
{
  "parse": "json",
  "assign": { "tasks": "$.tasks" },
  "next": "Build"
}
```

### Evaluator control handoff

An evaluator that controls branching must return `satisfied`:

```json
{
  "satisfied": false,
  "feedback": "The README still links to stale branch syntax.",
  "missing": ["Update README edge examples"]
}
```

A graph can route that result with canonical edge conditions:

```json
{
  "parse": "json",
  "assign": {
    "lastFeedback": "$.feedback",
    "lastMissing": "$.missing"
  },
  "edges": [
    { "when": "satisfied", "to": "Maintain" },
    { "when": "not_satisfied", "to": "Build" }
  ]
}
```

### Maintainer advancement handoff

A maintainer can use `satisfied` both for routing and cursor advancement:

```json
{
  "satisfied": true,
  "commitMessage": "Document handoff contract",
  "reason": "Docs now link to canonical satisfied semantics.",
  "vcs": "jj",
  "checkpointCreated": true,
  "commands": ["jj status", "jj describe -m ...", "jj new"]
}
```
