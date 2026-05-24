# Socket rework context semantics

`satisfied:false` and `not_satisfied` are generic graph-control signals. They mean the selected edge should route the current item to another socket for follow-up. They are not evaluator-only concepts and they do not, by themselves, mean a human-style rejection, test failure, or quality verdict.

## Runtime-owned follow-up context

When a JSON-parsed socket returns top-level `satisfied: false` and runtime selects a `not_satisfied` edge, pi-materia captures bounded provenance for that route and renders it into the next matching socket prompt as **Runtime follow-up context**. That prompt context tells the receiving materia that this turn is follow-up/rework for the current item, includes the prior socket identity, and includes concise actionable reason text.

The reason text comes first from the prior socket's top-level `context` field. If that is missing, runtime falls back to a bounded excerpt of the prior output. This keeps follow-up information available even when the current work item title is vague or the next materia is not evaluator-specific.

Rework feedback is prompt context, not agent-authored handoff schema. Agents continue to emit only the canonical fields that apply to their socket:

- `workItems` for generated/refined work;
- `satisfied` for graph routing and advancement;
- `context` for concise explanatory text.

Do not add fields such as `feedback`, `reason`, `failure`, `rework`, or nested state objects to agent JSON in order to communicate rework. The socket runtime owns provenance capture and prompt rendering.

## Authoring guidance

For sockets that can return `satisfied:false`:

- Put the actionable follow-up reason in top-level `context`.
- Keep it concise and specific enough for the next socket to act on.
- Prefer concrete observations, failed checks, file paths, or missing behavior over broad judgments.
- Avoid evaluator-specific wording unless the materia actually is an evaluator; `not_satisfied` can route between any sockets.
- Do not use `context` as arbitrary structured state. It is plain explanatory text for downstream agents.

For utility or script materia:

- Keep deterministic state patches under the documented utility `state` mechanism.
- Do not use utility state patches or `state.data.context` as an implicit mailbox for rework feedback.
- If a utility participates in guarded routing, keep graph-control fields such as `satisfied` separate from utility state.

## Prompt behavior

Runtime renders follow-up context only for matching targets reached by selected `not_satisfied` routing. Normal `satisfied` or `always` routes do not inject rework framing.

The rendered context is bounded and text-only. Repeated loops may accumulate a small recent history, but the prompt remains focused on the current target socket and current item. Agents should treat this section as relevant prior feedback and may address it even when the work item title or context is broad.

The canonical handoff contract remains unchanged; see [Materia handoff JSON contract](handoff-contract.md). For edge and loop routing semantics, see [Graph semantics](graph-semantics.md).
