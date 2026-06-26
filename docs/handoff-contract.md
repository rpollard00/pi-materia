# Materia handoff JSON contract

JSON-parsed agent sockets hand off reusable work context by returning a single JSON object. Sockets are placement adapters: they decide parse mode, assignment, routing, and iteration. Materia should stay reusable behavior/skill units.

## Agent handoff fields

Agent-authored handoff JSON is intentionally small. The agent contract splits into **default handoff fields**, available to every JSON agent socket, and an **opt-in renderable-text payload**, used only by sockets whose primary product is displayable prose.

Default handoff fields (any JSON agent socket):

- `workItems`: an optional array of generated or refined work units.
- `satisfied`: an optional boolean reserved for `satisfied` / `not_satisfied` graph control.
- `context`: optional explanatory text for downstream agents. This is the default cross-socket field for handoff notes: whenever an evaluator, maintainer, planner, architect, or chain-context socket has explanatory prose to pass along, it goes in `context`.

Opt-in renderable text (only renderable-prose sockets):

- `text`: optional renderable prose — the materia's primary user-facing text output (for example narration, notes, or a description). Most sockets do not emit `text`; emit it only when this socket carries explicit renderable-text intent or an assignment consumes `$.text`. See [Renderable text payloads](#renderable-text-payloads).

`context` is the default. A typical evaluator, maintainer, planner, architect, or chain-context socket emits `workItems`, `satisfied`, and/or `context` only — never `text`:

```json
{
  "workItems": [],
  "satisfied": true,
  "context": "plain text handoff context"
}
```

A renderable-prose socket additionally emits top-level `text`, and should not duplicate it into `context`:

```json
{
  "text": "optional renderable prose payload"
}
```

Do not ask agents to emit a broad envelope. Obsolete broad-envelope fields such as `summary`, `guidance`, `decisions`, `risks`, `feedback`, `missing`, or `state` are not part of the agent handoff contract.

## Renderable text payloads

`text` is the canonical field for materia whose primary product is displayable prose (for example a Narrate materia producing a cast summary, or a materia that turns a description into branch-name notes). It lets a text-style materia emit JSON-first output while still appearing to the user as clean text.

- The raw JSON `text` value is authoritative. TUI rendering is a one-way presentation layer; rendered text must never replace or mutate the underlying JSON handoff or cast state.
- Emit `text` only when this socket carries explicit renderable-text intent or its assignment consumes `$.text`. Do not duplicate narration into `context`; ordinary evaluator/maintainer/planner explanations belong in `context`, not `text`.
- `text` is a current-output payload, not automatic shared state. It is not mirrored into `state.data.envelope` or accumulated into any implicit collection, and it is not injected into following prompts unless a socket explicitly asks for it. The authoritative raw value stays in `state.lastJson` (and the `lastJson` artifact) for debugging and replay.
- Downstream materia consume `text` only through an explicit socket assignment (for example `assign: { "prNotes": "$.text" }`), which persists the value into a named `state.data` slot, or through a prompt template that reads that slot. Consumption is opt-in per graph; narration is never hard-wired to a consumer.
- Use `context` for accumulating cross-socket handoff notes. Use `text` for the materia's discrete prose payload.

Example narration output:

```json
{
  "text": "## Summary\n\nImplemented the retry toggle and added tests."
}
```

A following socket can then surface that prose as PR notes, branch-name input, or any other derived context without the narration materia needing to know about its consumers.

### End-to-end example

A representative two-socket loadout (`examples/text-consumption-loadout.json`) shows the durable handoff path: a Narrate materia emits structured renderable text as top-level `text`, the emitting socket explicitly assigns that value into state, and a deterministic utility consumes the assigned slot without hard-coding the producer.

```json
{
  "loadouts": {
    "Text Consumption Example": {
      "entry": "Socket-1",
      "sockets": {
        "Socket-1": {
          "materia": "Narrate",
          "parse": "json",
          "assign": { "prNotes": "$.text" },
          "edges": [{ "when": "always", "to": "Socket-2" }]
        },
        "Socket-2": { "materia": "PR-Notes-Consumer", "parse": "json" }
      }
    }
  },
  "materia": {
    "Narrate": { "type": "agent", "tools": "readOnly", "prompt": "Produce PR-ready notes. Return JSON with a top-level string `text` field only." },
    "PR-Notes-Consumer": { "type": "utility", "command": ["node", "-e", "...read input.state.prNotes and emit JSON..."], "parse": "json" }
  }
}
```

What happens at runtime:

1. Narrate emits `{ "text": "..." }`. The TUI renderer shows the prose to the user as clean text (a `materia_text` presentation message), hiding transport metadata.
2. The raw JSON stays authoritative for debugging and replay in `state.lastJson`, but `text` is not mirrored into `state.data.envelope` or any implicit collection, and no synthetic prior-text section is added to following prompts.
3. The emitting socket's `assign: { "prNotes": "$.text" }` is the durable handoff path: it persists the payload into `state.data.prNotes`.
4. The utility consumes the assigned slot from its input (`input.state.prNotes`) and emits its own canonical output. Narration is not hard-wired: it only reaches the utility because this graph assigns and routes it.

Rendering is a one-way presentation layer; it never replaces or mutates the underlying JSON handoff. Regression coverage in `tests/textConsumptionFlowNative.test.ts` exercises the flow end to end and verifies the rendered presentation does not alter the authoritative payload.

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

Prompt assembly should describe only the socket-relevant fields. Generator/planner prompts should ask for `workItems` with `title` and `context`. Evaluator prompts should ask for `satisfied` plus textual `context` when useful. Renderable `text` guidance should appear only for sockets that opt into renderable prose (explicit intent or `$.text` assignment); never add generic `text` guidance to a non-text JSON socket. Do not copy a full runtime state schema into role-generation prompts or socket suffixes.

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
