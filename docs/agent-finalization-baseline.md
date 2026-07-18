# Agent JSON finalization baseline

Date: 2026-07-17

This is a characterization of the current direct-JSON path, not an architecture decision. The reusable fixtures and sanitized observations live under `tests/fixtures/finalization/`; ignored local cast artifacts are not required to rerun the deterministic tests.

## Current path

### Agent producer

1. `src/runtime/agentLifecycle.ts` handles `agent_end`, selects the latest assistant entry, joins its text parts with `assistantText`, captures message usage, and calls `completeSocket`. A multi-turn socket can only commit after explicit finalization; the same completion path receives `finalizedMultiTurn: true`.
2. `src/runtime/socketExecution.ts` delegates completion to `commitSocketOutput` and advances only when that returns a `route` outcome. A repair returns `recovery_started`, so no downstream socket starts.
3. `src/runtime/socketOutputCommit.ts` records the raw output artifact before authoritative handoff state changes. For a JSON socket it then:
   - parses with `parseSocketJson`;
   - validates, dispatches, and removes the optional event side-channel;
   - serializes the stripped plain object back to text;
   - validates the socket-specific handoff with `validateHandoffJsonOutput`;
   - records `lastJson` and the parsed artifact; and only then
   - applies the canonical envelope, assignments, advancement, and routing.
4. `src/utilities/json.ts` first attempts `JSON.parse` on the JSON-looking suffix. It can recover a balanced object from fenced, prose-prefixed, or trailing-prose output, but it does not repair invalid JSON string escaping.
5. `src/handoff/handoffValidation.ts` distinguishes syntactically valid JSON from contract violations. Agent output must be a top-level object, use allowed top-level fields, satisfy socket-required fields and consumed paths, and use canonical work-item and reserved-field types.

### Agent retry

A parse or handoff validation error is wrapped as a pre-commit validation failure. `src/runtime/turnRecovery.ts` stores a bounded 600-character invalid-output excerpt and classifies it as `json_parse` or `handoff_validation`. `src/application/recoveryWorkflow.ts` records `same_socket_recovery_start`, sends a correction prompt on the same socket, and records `same_socket_recovery_retry`. The default allowance in `src/application/recoveryPolicy.ts` is one retry for this recovery identity. A second invalid submission exhausts recovery and fails the cast. Socket visit and downstream state do not advance during repair.

### Deterministic utility producer

`src/application/utilityExecution.ts` keeps utilities on a separate producer path. Configured object output is serialized by `stringifyDeterministicHandoffOutput`; command and built-in utilities return their own deterministic strings. JSON utilities then share parsing, event stripping, validation, and commit semantics with agent sockets. They do **not** enter model repair: malformed utility output throws, and `startSocket` fails the cast. No agent turn or model tokens are involved.

## Fixtures

`tests/finalizationBaseline.test.ts` exercises:

- `complex-canonical-envelope.json`: a 4,935-byte, ten-work-item envelope containing embedded quotes, LF and CRLF content, a tab, Windows and UNC paths, regex backslashes, literal `\\n`, direct Unicode from several scripts, emoji, combining characters, and longer work-item contexts;
- `malformed-unescaped-quote.txt`: an unescaped quote inside a JSON string;
- `malformed-literal-newline.txt`: a physical newline inside a JSON string;
- `malformed-backslash.txt`: invalid path and regex escape sequences; and
- `model-run-evidence.json`: sanitized observational measurements described below.

The complex envelope passes both direct agent finalization and runtime-owned deterministic utility serialization without value loss. Each malformed text fixture is classified as `json_parse`, starts exactly one same-socket agent retry, does not advance early, and succeeds after corrected output. The equivalent utility object completes with zero agent turns and zero repair events.

## Available model-run evidence

The local artifact sample contains three completed multi-turn planning finalizations. All used `openai-codex/gpt-5.6-sol` with `xhigh` thinking. Finalization latency is measured from the `materia_model_settings` event carrying `finalization: true` to `socket_complete`. Reported usage is the corresponding finalization turn or turns in `usage.json`.

| Cast | First submission | Repair retries | Eventual result | Finalization latency | Reported finalization tokens | Reported cost |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| `2026-07-09T22-54-39-003Z` | accepted | 0 | accepted | 126.017 s | 59,119 | 0.143183 |
| `2026-07-10T02-53-33-302Z` | accepted | 0 | accepted | 137.648 s | 46,783 | 0.289326 |
| `2026-07-17T23-53-10-806Z` | rejected: empty output / `json_parse` | 1 | accepted | 238.842 s | 6,856 | 0.093455 |

Derived observations:

- first-submission acceptance: **2/3 (66.7%)**;
- eventual acceptance within the current retry bound: **3/3 (100%)**;
- JSON repair retries: **1** across three finalizations;
- mean full finalization latency: **167.502 s**;
- total reported finalization usage: **112,758 tokens**; and
- the one observed retry added **83.414 s** and reported **6,856 tokens** (4,489 input and 2,367 output) with reported cost `0.093455`.

The usage files label these runs `costKind: "subscription"`; cost values are token-value estimates, not evidence of billed per-token charges. The sample is observational and too small for a stable rate. Most importantly, the rejected output was empty (`excerptLength: 0`): it is evidence of a direct-finalization parse retry, but **not** evidence that quotes or backslashes caused that failure. No smaller model appears in the available sample, so no small-model failure rate or comparative token cost can be claimed yet.

## Separate deterministic utility observation

The same three casts ran a `Commit-Sigil` command utility that produced and committed JSON without model repair.

| Cast | Retries | Model tokens | Socket start-to-complete latency |
| --- | ---: | ---: | ---: |
| `2026-07-09T22-54-39-003Z` | 0 | 0 | 47 ms |
| `2026-07-10T02-53-33-302Z` | 0 | 0 | 37 ms |
| `2026-07-17T23-53-10-806Z` | 0 | 0 | 59 ms |

Mean observed utility socket latency was **47.667 ms**. This is a useful control for producer behavior, not a provider benchmark: it includes local command and commit work and should not be merged with agent acceptance, latency, or token rates.

## Baseline conclusion

The current parser and validator carry escaping-heavy canonical content losslessly once valid JSON reaches runtime. The avoidable risk is model-authored serialization before parsing; bounded retries recover it at the cost of another model turn. Deterministic utilities already avoid that authoring risk and should remain a separate control. Broader conclusions require controlled runs across the target smaller models and providers, with enough repetitions to separate empty-output, JSON syntax, event, and handoff-contract failures.

Run the baseline with:

```bash
bun test tests/finalizationBaseline.test.ts
```
