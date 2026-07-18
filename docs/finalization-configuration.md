# Finalization configuration and migration

pi-materia supports two protocols for an agent JSON socket to produce the same canonical handoff:

- `direct_json` asks the agent for one validated JSON object. It is the portable default.
- `tool_backed` lets an explicitly qualified agent submit individual values through generated Pi tools; pi-materia validates, accumulates, and serializes the final object.

This setting changes the **agent submission protocol**, not the [Materia handoff JSON contract](handoff-contract.md). Every successful path still enters the normal event, validation, assignment, routing, artifact, and graph-advancement pipeline. Deterministic utilities and scripts are exempt from agent tool selection.

## Configuration

Configure the policy at top-level `finalization.agentJson` in the normal [configuration layers](../README.md#configuration-layering):

```json
{
  "finalization": {
    "agentJson": {
      "strategy": "tool_backed",
      "qualifiedModels": [
        {
          "provider": "acme",
          "api": "responses",
          "model": "small-tools-v2",
          "socketIds": ["Plan"]
        }
      ]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `strategy` | `direct_json` or `tool_backed`. Omitted configuration behaves as `direct_json`. |
| `qualifiedModels` | Explicit allowlist used only when `strategy` is `tool_backed`. Entries are ORed. No match means direct JSON. |
| `qualifiedModels[].model` | Required exact effective model id, provider-qualified id, or `"*"` as an explicit operator wildcard. |
| `provider` / `api` | Optional exact-match restrictions for the effective provider and API. |
| `socketIds` / `materiaIds` | Optional exact-match cohort restrictions. Use these to make the first rollout narrow. |

A higher-precedence configuration layer that supplies `qualifiedModels` replaces that array; it does not append entries from lower layers. Avoid `model: "*"` for an initial rollout: it opts every otherwise matching effective model into a protocol whose reliability can vary by model and provider.

Setting `tool_backed` alone does not activate tools. The effective producer, turn, model, and socket must all qualify. This makes an empty allowlist a safe direct-JSON configuration.

To select tool-backed finalization, the runtime requires all of the following:

1. The producer is an agent, not a utility or script.
2. The socket's effective parse mode is `json`.
3. For a multi-turn materia, the current turn is the `/materia continue` finalization turn; refinement turns remain conversational.
4. The effective model/provider/API matches a `qualifiedModels` entry. Matching uses the effective selection after any model fallback, not merely the requested model.
5. The socket is representable by the runtime builder: its handoff uses `workItems`, `satisfied`, and/or `context`, plus the optional `event` side-channel. Renderable `text` sockets and sockets consuming unsupported custom top-level fields stay on direct JSON.

The runtime exposes only tools relevant to the active socket. For example, the work-item tools are absent when the socket neither produces nor consumes `workItems`, and the satisfaction tool is absent when the socket does not use `satisfied`.

## Provider and model requirements

A qualification entry is an operator assertion, not automatic capability detection. Before adding one, verify that the target model/provider through Pi can reliably:

- select and execute custom tools rather than answer with text;
- transport complete tool arguments, including long strings, quotes, newlines, backslashes, and Unicode;
- follow the supplied schemas and recover from a field-level tool error;
- preserve the order of sequential work-item and event calls; and
- call `materia_handoff_commit` by itself as the final tool call.

Pi validates parsed arguments against each TypeBox tool schema before execution, and the canonical runtime validator checks the accumulated result again at commit. This does **not** imply that every provider performs strict schema-constrained decoding. Raw tool-argument JSON may still be malformed, truncated, repaired by an adapter, or ignored by a weak tool-calling model. Tool-backed submission removes model-authored escaping from the final **outer envelope only after arguments have reached Pi as values**.

Use a paired direct/tool experiment for each intended cohort. Measure first-pass and eventual acceptance, malformed arguments, schema or commit rejection, missing or duplicate commit, turns, latency, and tokens. The current checked-in Codex experiment showed equal acceptance with more tool turns, tokens, and latency, so it is evidence for opt-in infrastructure—not for qualifying that model by default. See the [architecture decision](finalization-architecture-decision.md) and [prototype evidence](tool-backed-handoff-prototype.md).

## Tool-backed agent example

An eligible planning socket might receive only these calls (shown as a conceptual transcript; the agent calls the tools, not textual JavaScript):

```text
materia_handoff_add_work_item({
  "title": "docs: explain Windows paths",
  "context": "Preserve C:\\repo, a literal \\n, and the quoted word \"ready\"."
})
materia_handoff_set_satisfied({ "satisfied": true })
materia_handoff_set_context({
  "context": "The next agent can reuse 東京 and physical newlines without hand-assembling an envelope."
})
materia_handoff_commit({})
```

Call `materia_handoff_add_work_item` once per item in final order. If an explicitly empty required work-item result is intended, call `materia_handoff_begin_work_items({})`. `materia_handoff_emit_event` may be called once per optional event. Call commit as the sole final call, and do not also emit textual JSON.

The runtime serializes and validates the equivalent canonical value:

```json
{
  "workItems": [
    {
      "title": "docs: explain Windows paths",
      "context": "Preserve C:\\repo, a literal \\n, and the quoted word \"ready\"."
    }
  ],
  "satisfied": true,
  "context": "The next agent can reuse 東京 and physical newlines without hand-assembling an envelope."
}
```

Work items still contain only `title` and `context`. Obsolete broad-envelope fields such as `summary`, `guidance`, `feedback`, `tasks`, or agent-authored `state` remain invalid. The optional `event` array remains a runtime side-channel and is stripped before handoff validation and assignment.

## Fallback and conflict behavior

There are two kinds of fallback:

### Selection fallback

An unqualified model, utility producer, non-JSON socket, non-final multi-turn turn, or unsupported socket starts directly with the existing protocol. No partial tool state exists and no extra fallback turn is needed. The `agent_finalization_strategy` event records the reason.

### Active tool-attempt fallback

A schema or setter failure returns concise field paths so the agent can retry that call during the active attempt. If an active tool-backed turn fails or ends without a successful `materia_handoff_commit`, pi-materia:

1. discards every partial submitted value;
2. hides the handoff tools;
3. ignores textual JSON from that failed tool attempt;
4. records a missing-commit/protocol diagnostic when applicable; and
5. uses the bounded same-socket recovery path for a clean direct-JSON retry.

Tool and text values are never merged. After a successful tool commit, the committed runtime value is authoritative; non-empty assistant text is ignored and an `agent_finalization_protocol_conflict` diagnostic records only its byte count. A commit is exactly once, and calls made after commit receive a protocol error.

Direct JSON remains validated. Malformed syntax and contract violations receive a bounded repair prompt with field-level feedback when available. Exhausted recovery fails the socket rather than committing ambiguous or repaired values.

## Deterministic utility example

Do not migrate a command utility to agent tools. Have the program construct values and use its language's JSON serializer:

```js
const output = {
  workItems: [
    {
      title: "docs: publish utility output",
      context: "The script owns these deterministic values.",
    },
  ],
  satisfied: true,
  context: "Generated without an LLM turn.",
};
process.stdout.write(`${JSON.stringify(output)}\n`);
```

With utility `parse: "json"`, this stdout follows the same applicable `workItems` / `satisfied` / `context` contract and normal commit semantics, but it does not register tools or consume model retries. Utility-owned shared-state data remains separate under top-level `state`, for example `{ "state": { "detector": { "ok": true } } }`; do not put `state` in an agent handoff. Invalid utility JSON is a utility failure and does not invoke an agent fallback. See [Utility Materia](utility-materia.md).

## Rollout and rollback

Existing installations require no migration: omitted finalization configuration and explicit `direct_json` preserve prior behavior.

For an evidence-gated rollout:

1. **Baseline by cohort.** Record direct-JSON syntax versus contract failures for the actual model, provider, socket shape, and payload size. Do not combine unrelated models or empty-response failures with escaping failures.
2. **Try the cheapest compatible fixes first.** Keep prompts socket-specific and consider stable provider-native strict response schemas when available. The [structured-output comparison](structured-output-alternatives.md) covers the trade-offs.
3. **Run matched trials.** Compare identical semantic payloads and capture reliability, retries, provider turns, latency, and tokens.
4. **Allowlist narrowly.** Add the exact `provider`, `api`, and `model`, then restrict by `socketIds` or `materiaIds`. Do not move utilities.
5. **Monitor and expand only with evidence.** Segment results by strategy and effective provider/model. A tool smoke test is insufficient if direct JSON is already reliable or tool overhead is material.
6. **Rollback without contract changes.** Set `strategy` to `direct_json` or remove the `finalization` section. Agents return canonical JSON again; utilities and downstream socket semantics remain unchanged.

Never use strategy rollout to relax required fields, change work-item shape, bypass event stripping, or create a second routing path. Strategy compatibility means that direct JSON, successful tool commit, clean fallback, and deterministic utility output produce the same canonical runtime value.

## Troubleshooting

Inspect the cast's `config.resolved.json` for the effective policy and `events.jsonl` for content-safe strategy/recovery metadata.

### Expected tools are not active

Find `agent_finalization_strategy` and inspect its initial selection `reason`:

| Reason | Action |
| --- | --- |
| `default_direct_json` / `configured_direct_json` | Configure `tool_backed` if the cohort has qualifying evidence. |
| `unqualified_model` | Compare the event's effective `model`, `provider`, and `api` with the allowlist; check for model fallback and scope restrictions. |
| `unsupported_socket` | Keep direct JSON, or redesign the socket around canonical fields. Renderable `text` currently requires direct JSON. |
| `deterministic_producer` / `non_json_socket` | Expected; these producers do not use agent handoff tools. |
| `not_finalization_turn` | Expected during multi-turn refinement. Run `/materia continue` when ready to finalize. |
| `qualified_tool_model` | Tools should be active for that finalization attempt. Check Pi/provider tool-call support if they are not selected. |

A later active-attempt fallback does not rewrite the initial strategy event. The persisted cast state uses `agentFinalization.reason: "direct_json_fallback"`; recovery events show the bounded retry, and a missing commit also emits `agent_finalization_protocol_failure` with `fallback: "direct_json"`.

### A tool call is rejected

`agent_finalization_failure` separates `tool_argument_validation`, `contract_violation`, `tool_protocol_violation`, and `tool_execution_failure`. Its `issuePaths` identify fields without logging submitted handoff values. Correct the failed call; do not restart the envelope or mix in textual JSON unless the runtime has explicitly switched to direct fallback.

### The agent repeatedly omits commit

Look for `agent_finalization_protocol_failure` with `failureCategory: "missing_commit"`, followed by `same_socket_recovery_start` / `same_socket_recovery_retry`. Ensure the model can follow a multi-call protocol and call commit alone. If it cannot do so reliably, remove its qualification and use direct JSON.

### Direct JSON keeps retrying

Recovery events distinguish `malformed_syntax` from `contract_violation` and include validation kind, strategy, attempt, and non-sensitive field paths. Inspect the bounded socket output artifact locally for the actual response, fix stale prompts or unsupported fields, and keep the canonical validator enabled. Use `/materia revive` only for an explicitly exhausted recoverable cast; do not treat it as a substitute for correcting a systematically incompatible model or socket.
