# Materia handoff JSON contract

JSON-parsed agent sockets hand off reusable work context by returning a single JSON object. Sockets are placement adapters: they decide parse mode, assignment, routing, and iteration. Materia should stay reusable behavior/skill units.

## Agent handoff fields

Agent-authored handoff JSON is intentionally small. The only top-level fields in the agent contract are:

- `workItems`: an optional array of generated or refined work units.
- `satisfied`: an optional boolean reserved for `satisfied` / `not_satisfied` graph control.
- `context`: optional explanatory text for downstream agents.
- `text`: optional renderable prose — the materia's primary user-facing text output (for example narration, notes, or a description). See [Renderable text payloads](#renderable-text-payloads).

Shape reference:

```json
{
  "workItems": [],
  "satisfied": true,
  "context": "plain text handoff context",
  "text": "optional renderable prose payload"
}
```

Do not ask agents to emit a broad envelope. Obsolete broad-envelope fields such as `summary`, `guidance`, `decisions`, `risks`, `feedback`, `missing`, or `state` are not part of the agent handoff contract.

## Renderable text payloads

`text` is the canonical field for materia whose primary product is displayable prose (for example a Narrate materia producing a cast summary, or a materia that turns a description into branch-name notes). It lets a text-style materia emit JSON-first output while still appearing to the user as clean text.

- The raw JSON `text` value is authoritative. TUI rendering is a one-way presentation layer; rendered text must never replace or mutate the underlying JSON handoff or cast state.
- Emit `text` only when this socket's main product is renderable prose that downstream materia may consume. Do not duplicate narration into `context`.
- Every emitted `text` payload is accumulated in order under `state.data.texts` (an append-only array of `{ socket, materia?, text }` entries) so following materia can consume prior prose even after intervening sockets have run. Unlike `state.data.envelope.text`, which mirrors only the most recently emitted payload, the `texts` collection preserves all upstream payloads with their source attribution.
- Prompt assembly surfaces accumulated payloads to following materia as a "Prior renderable text payloads" context section, and each entry is also reachable in raw JSON at `state.data.texts`; the most recent payload is mirrored at `state.data.envelope.text`. Downstream materia consume the payload through normal state references in their prompt (for example `{{state.texts}}`, a dedicated assignment, or the rendered prior-text context section). Consumption is opt-in per graph; narration is not hard-wired to any consumer.
- Use `context` for accumulating cross-socket handoff notes. Use `text` for the materia's discrete prose payload.

Example narration output:

```json
{
  "text": "## Summary\n\nImplemented the retry toggle and added tests."
}
```

A following socket can then surface that prose as PR notes, branch-name input, or any other derived context without the narration materia needing to know about its consumers.

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

Utility materia marked `generator: true` follow the same top-level `workItems` / `satisfied` / `context` contract as agent generators. A deterministic script emits canonical generator output; utility-only state patches remain under a separate `state` object. Pass-through validator generators (such as `Commit-Sigil`) echo input `workItems` unchanged while validating titles and reporting `satisfied` / `context` for routing. They are `generator: true` because they produce canonical `workItems` for downstream generator and loop-region semantics — not because they transform or rewrite titles.

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

## Follow-up/rework context

`satisfied:false` is a graph-control result, not an evaluator-only rejection field. If runtime selects a `not_satisfied` edge from that result, it captures bounded route provenance and reason text from this canonical handoff output and renders it into the next matching socket prompt as runtime-owned follow-up context.

Agents should keep using only `workItems`, `satisfied`, and `context`. Put actionable follow-up reasons in top-level `context`; do not invent additional handoff fields such as `feedback`, `reason`, `failure`, or `rework`, and do not put rework messages into utility state patches. See [Socket rework context semantics](socket-rework-context.md).

## Evaluator example

```json
{
  "satisfied": false,
  "context": "The README still links to stale branch syntax."
}
```

## Event side-channel

The reserved top-level field `event` is a runtime side-channel for structured event
emission. It is processed before handoff semantics and stripped from the parsed JSON
before validation, assignment, routing, state handoff, and downstream prompt context.
`event` is **not** part of the agent handoff contract — it does not affect routing,
work item assignment, or cast state.

See [Runtime Eventing Contract](runtime-eventing.md) for the full event system design
including the event array shape, processing pipeline, webhook delivery, result
accumulation, and agent-controller integration.
