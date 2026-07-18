# Agent finalization architecture decision

Date: 2026-07-18

Status: **Accepted** — use a producer- and capability-aware hybrid; keep validated direct JSON as the default and make tool-backed submission an evidence-gated opt-in, not a universal replacement.

## Decision summary

Tool-backed finalization is worthwhile as a **selective agent strategy**. It moves canonical envelope assembly and serialization into runtime code after Pi has parsed tool arguments, which removes a real outer-envelope syntax failure class and enables field-level validation and diagnostics. It is not worthwhile as the default for every agent: the paired provider sample showed no acceptance improvement and substantially greater turn, token, and latency cost.

Materia will therefore retain one canonical handoff contract, validator, and commit path while choosing how a producer reaches that boundary:

| Producer or capability | Selected strategy |
| --- | --- |
| Deterministic utility or script | Keep direct deterministic JSON or utility `state` output. Never require agent tools. |
| Agent without an explicitly qualified structured capability | Validated direct JSON with conservative extraction and bounded same-socket retry. This remains the portable default. |
| Agent/provider with verified native strict response-schema support | Prefer the native one-response mode when Pi exposes a stable capability and paired validation shows it preserves the canonical contract; retain direct JSON fallback. |
| Agent/model with reliable tools and measured direct-JSON failures | Permit the runtime-owned tool accumulator and commit protocol only when paired evidence shows a material net reliability benefit for that model/provider and workload. |
| Controlled backend with verified grammar support | A constrained canonical-JSON response may be selected explicitly; it is not a cross-provider default. |

The checked-in `openai-codex/gpt-5.4-mini` result does **not** qualify that model for tool-backed-by-default finalization. Tool support may be implemented behind explicit capability/configuration boundaries so weaker target models can be evaluated, but no model should be opted in merely because it can call tools.

## Evidence for the decision

The escaping-heavy deterministic replay establishes the useful but limited guarantee:

- direct parsing rejected all three intentionally malformed quote, literal-newline, and backslash fixtures;
- submitting those values as already-parsed tool arguments and using runtime `JSON.stringify` produced zero malformed envelopes; and
- the larger envelope round-tripped quotes, physical and literal newlines, paths, regexes, Unicode, combining characters, emoji, and ordered work items without value loss.

That result proves runtime serialization removes model-authored **outer envelope** escaping after arguments have become JavaScript values. It does not prove that a provider will transport the arguments correctly.

The paired Pi agent-session experiment used the same escaping-heavy semantic payload for both strategies. For three repetitions on `openai-codex/gpt-5.4-mini`:

| Measure | Direct JSON | Tool-backed |
| --- | ---: | ---: |
| First and eventual acceptance | 3 / 3 | 3 / 3 |
| Recovery prompts | 0 | 0 |
| Provider turns | 3 | 10 |
| Mean latency | 6.592 s | 11.918 s |
| Reported tokens, including cache reads | 2,809 | 12,538 |
| Raw tool arguments | n/a | 15 valid, 0 malformed or uncaptured |
| Schema / commit rejections | n/a | 0 / 0 |

In that sample, tools used 3.33 times the provider turns, 4.46 times the reported tokens, and 1.81 times the mean latency without improving acceptance. The provider supplied tool schemas, but the experiment records no native strict-schema guarantee; Pi performed local validation after provider parsing.

The production baseline contains three `openai-codex/gpt-5.6-sol` finalizations. One empty response required a retry, adding 83.414 seconds and 6,856 reported tokens, but it was not an escaping failure and it is not a matched cohort. There is still no measured smaller-model failure rate. That observation demonstrates that retries can be expensive, not that tools would have prevented the observed failure or reached a break-even point.

Deterministic utilities are the control, not candidates for migration. In the same three casts, the deterministic command utility completed with zero model turns and retries and a mean observed socket latency of 47.667 ms. Agent tools cannot improve model-authored serialization for a producer that uses no model.

## Invariants

Every successful strategy must produce the same canonical value and cross the same authoritative runtime boundary:

1. Socket requirements determine which handoff fields are allowed and required. The canonical agent fields remain `workItems`, `satisfied`, `context`, and socket-opt-in `text`; permitted `event` data remains a side-channel processed and stripped before handoff validation.
2. The existing handoff/domain validator remains authoritative. Provider schemas and Pi tool schemas are early checks, not replacements for runtime validation.
3. Event processing, assignment, graph advancement, routing, artifacts, and state updates occur only through the normal socket-output commit path. A tool strategy must not create a second implementation of those semantics.
4. Runtime serialization may differ by strategy, but successful strategies must yield an equivalent canonical object. Work-item order and exact string values must be preserved.
5. Strategy state is scoped to one cast session, socket visit, and finalization attempt. Partial values must never leak across retries, sockets, branches, or casts.
6. A finalization attempt selects one authoritative protocol. Text output and tool accumulation are never merged. A successful commit is exactly once; a fallback starts a clean bounded attempt after discarding partial tool state.

## Failure classes

### What tool-backed submission solves

After Pi has produced parsed argument values, runtime-owned accumulation and serialization remove or narrow these failures:

- malformed punctuation and escaping in the final outer handoff object;
- model-authored array/object assembly and canonical field ordering;
- many missing, wrong-type, or unsupported fields through narrow tool schemas and commit validation; and
- coarse whole-response diagnostics, because a failed setter or commit can identify a field or protocol phase without logging the handoff content.

### What it does not solve

Tools do not remove the provider boundary or semantic validation:

- raw tool-argument JSON can still be malformed, repaired by an adapter, truncated, or unsupported;
- a model can emit text instead of tools, call an unknown tool, omit a setter or commit, batch calls incorrectly, or duplicate a commit;
- schema-valid values can still contain altered prose, wrong work-item order, or incorrect graph-control meaning;
- refusal, empty output, provider failure, and context truncation remain possible;
- weak or emulated tool calling may treat schemas as guidance rather than constraints; and
- optional event data and socket-specific field eligibility still require runtime handling.

Tool-backed submission also introduces accumulator lifecycle, exactly-once commit, protocol-conflict, and tool-selection failures that direct JSON does not have. Canonical runtime validation and bounded recovery therefore remain mandatory.

## Selection and fallback policy

Tool-backed finalization may be enabled for an agent model/provider/socket cohort only when all of the following are true:

1. Pi and the provider expose usable tool calls for the active model, including observable validation/execution outcomes.
2. The active JSON socket can be represented by narrowly generated setters and a commit operation without weakening its field, event, or routing requirements.
3. A paired experiment on representative payloads records direct syntax and contract failures, raw argument syntax, schema and commit failures, missing/duplicate commits, retries, turns, latency, and token use.
4. The tool cohort materially improves the reliability objective after its additional cost is considered. A successful tool smoke test alone is insufficient.
5. Validated direct JSON remains available for unsupported capability or a clean, bounded fallback. Fallback must not reinterpret or merge a partially accumulated tool result.

Prefer a simpler socket-specific prompt before a stateful tool protocol when it provides adequate reliability. Prefer a genuinely strict provider-native response schema when available through a stable Pi capability because it can retain a single response and runtime validation. Conservative extraction of fenced or prose-wrapped objects remains safe because it does not alter values. Aggressive JSON repair must not silently commit ambiguous quotes, controls, or backslashes.

## Deterministic utility and script policy

Utilities and scripts remain a distinct producer class:

- Configured deterministic objects continue through runtime-owned serialization.
- Deterministic commands may emit canonical handoff JSON directly and, where supported by the utility contract, a top-level `state` patch for shallow runtime-state merging.
- They continue to share applicable parsing, event stripping, contract validation, and commit semantics, but malformed output is a utility failure rather than a reason to invoke an agent.
- They do not register, select, or call agent finalization tools and do not consume model retries, tool schemas, or accumulator state.

This exemption does not weaken the canonical handoff contract. It preserves the shortest reliable production path for producers that can already construct JSON or state deterministically.

## Consequences and follow-up

The accepted architecture allows a runtime-owned agent handoff builder and narrow finalization tools to be developed without changing the default producer path. Production integration must add scoped state, socket-derived schemas, exactly-once commit behavior, explicit strategy/fallback configuration, and content-safe diagnostics before the isolated prototype can be enabled.

The trade-off is additional implementation and test surface for an optional strategy. That cost is justified only as infrastructure for cohorts where direct serialization is demonstrably unreliable; it is not justified as mandatory overhead for reliable agents or deterministic utilities. Rollout data should be segmented by strategy and model/provider, and should record failure categories and costs without retaining sensitive handoff values.

Revisit the default only after larger paired samples include the smaller models and providers that motivated the concern. Native response-schema or constrained-output support should be reconsidered when Pi exposes provider-neutral capability negotiation. Until then, validated direct JSON remains the default, and the current measured Codex cohort remains on it.

## Evidence and contract references

- [Agent JSON finalization baseline](agent-finalization-baseline.md)
- [Tool-backed handoff submission prototype](tool-backed-handoff-prototype.md)
- [Agent finalization: structured-output alternatives](structured-output-alternatives.md)
- [Materia handoff JSON contract](handoff-contract.md)
- [`tool-backed-provider-evidence.json`](../tests/fixtures/finalization/tool-backed-provider-evidence.json)
