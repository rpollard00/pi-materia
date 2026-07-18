# Tool-backed handoff submission prototype

Date: 2026-07-18

Status: isolated experiment; not registered by the pi-materia extension and not used by cast execution.

## Question

Can a model submit small, typed handoff values through Pi custom tools while runtime code, rather than the model, serializes the canonical JSON envelope?

The prototype supports that shape. It materially removes **envelope-serialization** failures after tool arguments have reached Pi as parsed values. A paired end-to-end Pi agent-session experiment now exercises one provider/model's streamed argument generation and local validation path. That small sample found no malformed output in either cohort, so it demonstrates the mechanism but does **not** show a success-rate improvement.

## Pi extension findings

The implementation follows the current Pi custom-tool documentation and the `dynamic-tools.ts` and `structured-output.ts` examples:

- `pi.registerTool()` exposes a TypeBox parameter schema to the provider and Pi.
- Pi's agent loop runs `validateToolArguments` before tool execution. Invalid missing properties, arrays in string positions, and extra properties rejected by `additionalProperties: false` never reach the tool executor.
- Tool execution must throw to report an error. Returning an error-looking object does not set `isError`.
- `executionMode: "sequential"` is needed because all prototype tools mutate one accumulator and providers may issue sibling calls in one response.
- The final commit returns `terminate: true`. Pi skips the follow-up turn only when every finalized call in that tool-call batch is terminating, so the prompt tells the model to call commit by itself.
- Tool state normally needs branch/session reconstruction from tool-result details. This isolated prototype intentionally does not add persistence; session- and socket-scoped production state is a separate implementation concern.

## Prototype

The prototype lives in:

- `src/prototype/toolBackedHandoffSubmission.ts`: sparse canonical accumulator, domain/socket validation, canonical field ordering, and `JSON.stringify` owned by runtime code.
- `src/prototype/toolBackedHandoffTools.ts`: TypeBox schemas and custom tool definitions.
- `src/prototype/toolBackedHandoffExperimentCase.ts`: shared escaping-heavy semantic payload and paired prompts.
- `src/prototype/toolBackedHandoffExperimentMetrics.ts`: sanitized streamed-argument, validation, retry, latency, and usage instrumentation.
- `src/prototype/toolBackedHandoffExperiment.ts`: isolated `createAgentSession` direct/tool cohort runner.
- `tests/toolBackedHandoffPrototype.test.ts`: deterministic escaping replay and validation coverage.
- `tests/toolBackedHandoffProviderExperiment.test.ts`: recorder, metric-category, and checked-in evidence consistency coverage.
- `tests/fixtures/finalization/tool-backed-provider-evidence.json`: sanitized paired provider-run evidence.

It is not imported by `src/index.ts`. A test host or experimental extension can call `registerToolBackedHandoffPrototype(pi, { onCommit })` explicitly.

The calls are deliberately narrow:

| Tool | Arguments | Effect |
| --- | --- | --- |
| `materia_handoff_begin_work_items` | `{}` | Includes `workItems: []` when zero items is a valid required result. |
| `materia_handoff_add_work_item` | `{ title, context }` | Appends one item in final order. |
| `materia_handoff_set_satisfied` | `{ satisfied }` | Sets the canonical boolean control field. |
| `materia_handoff_set_context` | `{ context }` | Sets downstream explanatory prose. |
| `materia_handoff_set_text` | `{ text }` | Sets opt-in renderable prose; commit still rejects it on a non-text socket. |
| `materia_handoff_commit` | `{}` | Validates, runtime-serializes, invokes the host callback, and terminates when called alone. |

The model never submits a nested envelope or a work-item array. Commit emits fields in canonical order (`workItems`, `satisfied`, `context`, `text`) regardless of setter call order. The callback receives both the parsed envelope and its runtime-owned JSON serialization. Tool results expose counts, field names, and byte length rather than echoing handoff content.

## Deterministic evidence

The tests use the same malformed fixtures as the direct-JSON baseline:

| Replay path | Malformed committed JSON |
| --- | ---: |
| Direct parse of unescaped quote, literal newline, and invalid backslash fixtures | 3 / 3 |
| Each entire fixture submitted as an already-parsed `context` string, then runtime serialized | 0 / 3 |

A larger envelope test also submits quotes, LF/CRLF, tabs, Windows/UNC paths, regex backslashes, literal `\\n`, direct Unicode, combining characters, and emoji through separate calls. Runtime serialization parses back to the exact values and the final envelope passes the existing socket-aware handoff validator.

This result is meaningful but bounded: once Pi has a JavaScript string, `JSON.stringify` deterministically escapes it, so this class of final envelope syntax failure is removed. The test does **not** show that a weak model/provider will always produce a valid tool call containing that string.

Schema tests use Pi's actual `validateToolArguments` path rather than calling executors with trusted values. Missing fields, structurally wrong values, and extra noncanonical work-item fields are rejected before execution. Trim-aware empty-title validation and active-socket contract validation remain runtime checks at commit.

Run the deterministic prototype evidence with:

```bash
bun test tests/toolBackedHandoffPrototype.test.ts
```

## Paired provider experiment

The checked-in experiment used `openai-codex/gpt-5.4-mini` at `minimal` thinking for three paired repetitions. Each cohort received the same two ordered work items and final context containing quotes, physical newlines, a tab, Windows and UNC paths, regex backslashes, literal `\\n`/`\\r\\n`, mixed punctuation, direct Unicode, combining characters, and longer guidance.

Unlike the deterministic replay, both cohorts ran through Pi's real `createAgentSession` loop and the configured provider. The tool observer accumulated provider-streamed `toolcall_delta` text before Pi schema validation, classified the completed raw JSON syntax, then correlated each call with schema or execution results. It stores only tool name, byte count, syntax class, parsed argument type, turn, and outcome—not argument content.

| Measure | Direct JSON | Tool-backed |
| --- | ---: | ---: |
| Repetitions eventually accepted | 3 / 3 | 3 / 3 |
| First submission/prompt accepted | 3 / 3 | 3 / 3 |
| Finalization recovery prompts | 0 | 0 |
| Provider turns | 3 | 10 |
| Mean latency | 6.592 s | 11.918 s |
| Reported total tokens (including cache reads) | 2,809 | 12,538 |
| Raw tool argument payloads | n/a | 15 valid / 0 malformed / 0 uncaptured |
| Schema / commit rejections | n/a | 0 / 0 |
| Missing / duplicate commits | n/a | 0 / 0 |

All six final envelopes matched the source values exactly. Direct output was bare valid JSON on all three first responses. Tool calls committed on provider turns 2, 3, and 5; Pi's loop handled those multiple turns inside the first prompt, so no explicit recovery prompt was needed. The tool cohort used 3.33× as many provider turns, 4.46× the reported total tokens including cache reads, and about 1.81× the mean latency in this sample.

This is evidence against claiming a measured reliability win for this provider/model: the direct baseline had no failure to reduce. It is positive evidence that the provider generated 15 complete, syntactically valid escaping-heavy argument objects and that Pi validation/execution plus runtime serialization produced canonical values without model-authored outer-envelope JSON. The sample is too small and too narrow for a general rate claim.

Re-run into an explicit output file (credentials and provider access are required):

```bash
npm run experiment:tool-handoff -- \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking minimal \
  --runs 3 \
  --max-recovery-prompts 1 \
  --output tests/fixtures/finalization/tool-backed-provider-evidence.json
```

The runner alternates cohort order, uses isolated in-memory sessions, disables discovered tools/extensions and agent auto-retry, requests SSE so raw deltas are observable, and records provider-reported token-value cost separately from token use. For subscription-backed Codex, that cost is not asserted to be a billed per-call charge.

## Provider and model limitations

“Provider-enforced” is not a portable guarantee:

- Providers differ in native tool calling, constrained decoding, schema support, streaming argument assembly, and repair behavior. Some only treat a schema as guidance.
- Pi validates the parsed or repaired object produced by its provider adapter even when the provider does not enforce the schema. Depending on the adapter, malformed streamed text may be repaired or collapse to `{}` before validation; raw-delta instrumentation is needed to distinguish that from natively valid arguments.
- A weak model can emit textual JSON instead of calling a tool, call an unknown tool, omit required setters or commit, repeat commit, or repeatedly submit schema-invalid calls.
- Type validation does not prove semantic correctness. Pi's validation path may coerce some primitive values before checking; the canonical/domain validator remains necessary.
- Complex prose still travels inside a tool argument. Runtime serialization removes the *outer envelope* escaping burden, not every provider wire-format failure.
- A commit batched with nonterminating setter calls cannot suppress Pi's follow-up turn. A later turn sees an already committed accumulator and receives a concise tool error.
- Tool result validation errors can include received arguments in model-visible error text. Production diagnostics should avoid copying sensitive handoff content into logs or telemetry.
- Models/providers without reliable tool support need the existing validated direct-JSON path. Deterministic utility/script producers gain nothing from agent tools and should remain on direct runtime serialization.

## Interpretation and remaining evidence

The historical cast sample still has only three `openai-codex/gpt-5.6-sol` finalizations, including one empty-output retry but no observed escaping-attributed failure. The controlled `gpt-5.4-mini` experiment adds a real provider path, but three successful pairs cannot estimate rare failure rates or represent providers with weaker tool support.

Before production adoption, repeat the paired test for each target model/provider and at a materially larger sample size:

1. Keep semantic payloads identical across cohorts and include several escaping-heavy and long-context cases.
2. Record first and eventual acceptance, direct syntax/contract failures, raw provider argument syntax, Pi schema rejection, domain/commit rejection, missing/duplicate commit, retries, turns, latency, and token usage.
3. Separate native strict/constrained tool schemas from ordinary or emulated tool calling. The checked-in Codex run explicitly records `providerStrictSchemaGuarantee: false`; its successful calls must not be described as strict-schema enforcement.
4. Include models/providers known to have weak tool selection or streamed argument assembly, and retain validated direct JSON as their fallback.
5. Keep deterministic utilities as a zero-model control, not as part of either agent cohort.

The prototype remains worthwhile as an optional strategy experiment because it makes runtime ownership of final serialization concrete and eliminates reproduced post-argument outer-envelope escaping failures. The current provider evidence does not justify a universal migration: for a model already reliable at direct JSON, narrow tools added turns, latency, and tokens without improving acceptance.
