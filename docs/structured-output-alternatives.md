# Agent finalization: structured-output alternatives

Date: 2026-07-18

Status: comparative evaluation; this is not a production architecture decision.

## Scope and evidence boundary

This evaluation compares ways for an **agent** to produce the existing canonical handoff object. It does not change the handoff fields, socket routing, assignment, event stripping, or validation rules. A successful strategy must ultimately enter the same authoritative commit path and produce the same `workItems`, `satisfied`, `context`, and opt-in `text` values.

Deterministic utilities are a separate producer class. They already serialize configured objects in runtime code, use no model turns, and gain no reliability from agent tools or provider structured-output modes. They should remain on their current direct path.

The only paired provider evidence currently available is the checked-in `openai-codex/gpt-5.4-mini` experiment in `tests/fixtures/finalization/tool-backed-provider-evidence.json`. Native response-schema, grammar-constrained, prompt-simplification, and automatic JSON-repair cohorts have not been run. Their token and reliability effects below are therefore qualitative, not measured claims.

## Current integration constraints

The installed Pi agent surface has first-class TypeBox schemas for tools and validates parsed tool arguments before execution. It does not currently expose a provider-neutral response schema, response format, grammar, or constrained-decoding option through `createAgentSession`, `AgentSession.prompt`, or `@earendil-works/pi-ai` `StreamOptions`. Pi's `before_provider_request` / `onPayload` hook could patch a provider payload, but doing so would be provider- and API-specific, would have no common capability signal, and could break as provider payloads change. It is useful for an isolated experiment, not a portable production abstraction.

The current direct path already has two important properties:

- `parseJson` safely extracts a JSON object from a fence, prefix, or trailing prose when it can identify a balanced object. It does not mutate malformed JSON string contents.
- `commitSocketOutput` parses, processes and strips the optional `event` side-channel, validates the socket-specific handoff, and only then applies handoff state, assignment, advancement, and routing. Agent syntax or contract failures receive one bounded same-socket correction attempt by default; utility failures do not invoke a model retry.

Any alternative should preserve those commit boundaries rather than creating a second routing or assignment implementation.

## Measured comparison: direct JSON and narrow tools

The paired experiment supplied the same escaping-heavy values to both cohorts and ran through Pi's real agent loop.

| Measure | Direct JSON | Narrow tool-backed submission |
| --- | ---: | ---: |
| Eventual acceptance | 3 / 3 | 3 / 3 |
| First prompt/submission accepted | 3 / 3 | 3 / 3 |
| Explicit recovery prompts | 0 | 0 |
| Provider turns | 3 | 10 |
| Mean latency | 6.592 s | 11.918 s |
| Reported tokens, including cache reads | 2,809 | 12,538 |
| Raw tool argument objects | n/a | 15 valid, 0 malformed, 0 uncaptured |
| Schema / commit rejections | n/a | 0 / 0 |

The tool cohort used 3.33 times as many provider turns, 4.46 times the reported tokens, and 1.81 times the mean latency. All outputs in both cohorts preserved the source values. The experiment therefore proves that the tool mechanism works for this provider/model, but it demonstrates no reliability improvement over direct JSON.

The deterministic fixture replay proves a narrower point: after Pi has parsed tool arguments into JavaScript strings, runtime `JSON.stringify` eliminates outer-envelope escaping failures. It does **not** prove that a provider will always produce valid tool-argument JSON. Complex prose still crosses the provider boundary inside a JSON tool argument.

The separate production baseline observed one empty direct finalization followed by a successful retry. That retry added 83.414 seconds and 6,856 reported tokens, but it used a different model, prompt, and context and was not caused by escaping. It must not be combined with the paired experiment to calculate a tool break-even rate.

## Strategy matrix

| Strategy | Portability | Implementation complexity | Token and latency profile | Failure recovery | Observability | Existing socket semantics |
| --- | --- | --- | --- | --- | --- | --- |
| Validated direct JSON plus bounded retry | High; works with every text-generating model | Already implemented | Usually one provider turn; a failure repeats generation | Coarse but effective full-response correction; current default allows one retry | Raw output artifact plus `json_parse` versus `handoff_validation` recovery events | Full compatibility today, including events, assignments, routing, multi-turn finalization, and utilities |
| Simpler socket-specific direct prompt | High | Low; prompt-only, but requires regression tests for every socket shape | Should reduce prompt input; no measured cohort yet | Same bounded retry as direct JSON | Same as direct JSON; A/B strategy label would be needed | Full compatibility if requirements continue to come from `SocketOutputRequirements` |
| Safe deterministic extraction | High | Already implemented | No additional model tokens when fences or trailing prose can be removed | Recovers wrappers only; correctly refuses malformed string escaping | Raw artifact exists, but extraction mode is not currently recorded separately | Full compatibility because the extracted value uses the normal commit path |
| Aggressive deterministic JSON repair | Library-portable, behavior-dependent | Low-to-medium code cost, high correctness risk | Can avoid a model retry | May turn syntax failure into silent value corruption; cannot reliably infer whether `\t`, a quote, newline, or backslash was intended data | Can record repair operations, but schema validation cannot detect altered prose | Mechanically compatible, semantically unsafe for authoritative handoff values |
| Provider-native JSON Schema / structured output | Low-to-medium across providers; not first-class in the current Pi session API | Medium-to-high: capability negotiation, schema conversion, refusal/truncation handling, and fallback | Commonly one provider generation plus schema transmission; not measured here | Provider can prevent syntax/shape errors, but refusal, truncation, unsupported schemas, and semantic mistakes still require fallback or retry | Potentially strong if adapters expose strictness, refusal, and finish metadata; weak if injected through a raw payload hook | High if the provider still returns canonical JSON text into the existing commit path; the schema must include socket-specific fields and optional events |
| Backend grammar / constrained decoding | Low for hosted portability; useful for a known local backend | High: backend-specific grammar generation and schema-subset testing | Usually one generation; grammar compile/transmission overhead is backend-specific | Guarantees only what the grammar expresses; backend rejection, truncation, and semantic errors remain | Backend-specific | High when output remains canonical JSON, but unsuitable as the only cross-provider strategy |
| Narrow tool-backed accumulator and commit | Medium: Pi models are tool-capable, but tool selection, strict schemas, argument streaming, and repair vary | High for production: scoped activation, session/socket state, event support, conflict rules, and exactly-once commit integration | Highest measured cost in the current sample because schemas, tool results, and sequential calls span turns | Field-level schema/tool errors can be corrected in-loop; adds missing, unknown, batched, or duplicate commit failure classes | Strongest prototype diagnostics: raw argument syntax class, schema result, execution result, and commit outcome without payload logging | Partial in the prototype; production must route the committed canonical value through the same event/validation/assignment/routing boundary |

## Failure-class comparison

No strategy removes the need for canonical runtime validation.

| Failure class | Direct / simpler prompt | Native or grammar-constrained output | Tool-backed submission | Deterministic repair |
| --- | --- | --- | --- | --- |
| Outer object punctuation or escaping | Possible; bounded retry | Prevented only when the provider/backend truly constrains generation | Removed after arguments are parsed and runtime serializes the envelope | Sometimes repairable, but ambiguous |
| Malformed JSON inside complex string transport | Possible in final text | Usually prevented by a strict native mode | Still possible in raw tool arguments; provider adapters may repair or collapse them before Pi validation | High risk of changing intended text |
| Missing or wrong field/type | Runtime contract rejection | Schema can prevent many structural cases; runtime must revalidate | Pi schema or commit rejection | Repair should not invent domain fields |
| Unsupported extra field | Runtime contract rejection | Preventable with a supported strict schema | Preventable by tool schema and commit validation | Removing it automatically can hide a model misunderstanding |
| Wrong work-item order or altered prose | Possible | Possible | Possible | Possible and easier to hide |
| Empty output, refusal, or truncation | Retry/fail | Still possible, with provider-specific signals | Can appear as no tool call or missing commit | Not safely repairable |
| Tool not selected, unknown tool, missing/duplicate commit | n/a | n/a | New tool-only failures | n/a |
| Optional `event` side-channel | Supported today | Must be represented by the active schema | Requires separate scoped event accumulation before commit | No improvement |

## Alternative assessments

### Native JSON Schema should be preferred when it is genuinely strict and available

A provider-native response schema best matches the desired shape: one generation, no model-authored unconstrained outer syntax, and no multi-call accumulator protocol. It can feed returned JSON through the existing parser and authoritative commit pipeline, preserving current socket semantics with less orchestration than tools.

It is not a current universal solution. Pi has no provider-neutral response-format capability in the installed agent API, providers implement different schema subsets and refusal behavior, and a raw request-payload patch would couple Materia to wire formats. Native mode is therefore a good targeted experiment or future preferred strategy after Pi exposes explicit capabilities, not a safe default today. Strictness must be recorded as a capability, not inferred from a successful response.

### Grammar constraints are appropriate only for controlled backends

A generated JSON grammar can guarantee syntax for a local inference stack that Materia controls. This can be valuable for a fleet pinned to one backend and model. It is less portable than native schemas, has similar schema-subset and truncation limitations, and does not guarantee correct prose or routing values. It should be selected by an explicit backend capability and always retain canonical validation and a fallback.

### Keep deterministic parsing conservative

The existing balanced-object extraction is useful because it removes transport wrappers without changing values. More aggressive repair is unsafe for the escaping-heavy failure class that motivated this work. For example, an invalid `C:\temp`-like sequence can be interpreted as either intended path characters or an escaped control character; an unescaped quote can be either data or a delimiter. Producing parseable JSON does not prove the repaired string is the string the model intended.

Automatic repair may be used diagnostically to construct a suggested correction, but a repaired value should not be silently committed as authoritative handoff state. Retrying with a concise syntax error preserves the model's responsibility for resolving ambiguity.

### Simplify prompts before adding a stateful protocol

The canonical envelope is already small and the final instruction is socket-aware, but production finalization context also includes broader contract prose and optional event examples. A controlled prompt cohort should test a single generated, socket-specific instruction containing only:

1. allowed and required fields for the active socket;
2. the exact two-string work-item shape when applicable;
3. optional event guidance only when needed; and
4. “one bare object, no commentary.”

This has the lowest rollout risk and may reduce input tokens, but it cannot guarantee valid escaping. It should be measured on the smaller models that exhibit retries rather than assumed to fix them.

### Tools are an optional reliability mechanism, not a universal replacement

Tools are worthwhile when a particular model/provider has materially worse direct-JSON acceptance but reliably selects and completes tools. They move final serialization into runtime code and offer useful field-level recovery and instrumentation. They do not provide a universal strict-schema guarantee, and the measured narrow protocol was substantially more expensive when direct JSON already worked.

If promoted beyond the prototype, tool-backed submission must be enabled only during an eligible agent socket's finalization turn, derive its available setters from that socket's requirements, support permitted events, and commit exactly once through the normal socket-output boundary. Textual and tool commits need an explicit conflict rule. None of those requirements applies to deterministic utilities.

## Evaluation outcome

The evidence supports an incremental hierarchy rather than a universal migration:

1. **Keep validated direct JSON and the conservative balanced-object parser as the portable default.** Retain the bounded, field-aware retry for recoverable agent failures.
2. **Run a simplified-prompt cohort first** on the actual smaller model/provider pairs that show malformed finalization. It is the cheapest compatible intervention.
3. **Prefer native strict response schemas over a multi-turn tool protocol** for providers where Pi exposes and verifies that capability, because they preserve a one-response shape. Keep direct JSON as fallback.
4. **Use tool-backed finalization selectively** only where paired evidence shows a net improvement in first-pass or eventual acceptance after accounting for total turns, tokens, and latency. The current `gpt-5.4-mini` sample does not meet that bar.
5. **Do not silently commit aggressively repaired JSON**, and do not route deterministic utility or script output through agent tools.

A future architecture decision should select strategies by producer and verified model/provider capability, while keeping one canonical runtime validator and commit path. Comparisons must use matched payloads and record syntax, contract, semantic, refusal/truncation, tool-selection/commit, retry, turn, latency, and token outcomes separately.

## Related evidence

- [Agent JSON finalization baseline](agent-finalization-baseline.md)
- [Tool-backed handoff submission prototype](tool-backed-handoff-prototype.md)
- [Materia handoff JSON contract](handoff-contract.md)
