# Materia handoff JSON contract audit

Date: 2026-05-07

This historical audit covered materia-to-materia JSON handoff behavior in code, prompts, docs, and tests before the canonical contract work. It is investigative only; the current canonical documentation is `docs/handoff-contract.md`.

## Current contract definition points

### Runtime parsing and routing

- `src/json.ts` defines generic `parseJson()` behavior. It extracts the first fenced JSON block or the first balanced JSON object/array from assistant text, then calls `JSON.parse`. This allows surrounding prose and allows arrays as well as objects.
- `src/native.ts` parses node output only when `node.node.parse === "json"`, stores the parsed value in `state.lastJson`, writes a per-node `.json` artifact, then applies assignments and routing.
- `src/native.ts` does not validate the parsed handoff as a JSON object or against a schema before `assign`, `advance`, or `edges` run.
- `src/native.ts` routes `edges` with `evaluateEdgeCondition()`. Supported edge condition strings are `always`, `satisfied`, and `not_satisfied`.
- `src/native.ts` currently resolves edge satisfaction from `$.satisfied` first, but previously fell back to a legacy `passed` JSONPath field when `satisfied` was absent. This made `passed` a runtime alias for edge routing.
- `src/native.ts` evaluates `advance.when` through `evaluateCondition()`, where `satisfied` and `not_satisfied` check only `$.satisfied`. `advance` does not use the `passed` fallback used by edges.
- `src/native.ts` uses strict boolean routing: `satisfied` edges match only `true`; `not_satisfied` edges match only `false`. Missing or non-boolean values simply do not match and may fall through to `next`/`end`.

### Config and graph validation

- `src/types.ts` defines node-level `parse`, `assign`, `edges`, `next`, `foreach`, and `advance` configuration, plus `MateriaEdgeCondition` (canonical condition type is used by validation and tests).
- `src/graphValidation.ts` defines `CANONICAL_EDGE_CONDITIONS = ["always", "satisfied", "not_satisfied"]` and rejects non-canonical edge `when` values such as JSONPath expressions.
- `src/pipeline.ts` validates node parse modes and materia prompt presence, but does not validate output schemas for JSON-parsed nodes.
- `config/default.json` wires the default planner, Auto-Eval, and Maintain handoffs:
  - planner: `parse: "json"`, assigns `tasks` from `$.tasks`, and its prompt asks for `{ "tasks": [...] }`.
  - Auto-Eval: `parse: "json"`, assigns feedback/check state, and routes on `satisfied` / `not_satisfied` edges. Its prompt asks for `{ "satisfied": boolean, "feedback": string, "missing": string[] }`.
  - Maintain: `parse: "json"`, assigns the whole result, advances the task cursor when `satisfied`, and loops on `not_satisfied`. Its prompt asks for `{ "satisfied": boolean, "commitMessage": string, "reason": string, "vcs": ..., "checkpointCreated": boolean, "commands": string[] }`.
- `src/roleGeneration.ts` generates free-form role prompts and contains no shared handoff JSON contract guidance; generated prompts are only told to describe expected output behavior.

### Documentation and tests

- At the time of the audit, `README.md` documented generic node mechanics with a legacy `passed` JSONPath true-expression example even though graph validation rejected expression-style edge conditions. Current README guidance links to `docs/handoff-contract.md` instead.
- At the time of the audit, `docs/webui-integration-notes.md` said satisfied/not-satisfied branches should emit legacy `passed` JSONPath true/false-expression conditions. Current notes use canonical `when: "satisfied"` and `when: "not_satisfied"` syntax.
- `PI_MATERIA_PLAN.md` contains historical examples and design notes that use `passed`, `failed`, legacy `passed` JSONPath expressions, and an Auto-Eval `{ passed, feedback, missing }` shape.
- Tests encode mixed expectations:
  - `tests/config.test.ts` checks bundled default loadout edge conditions are canonical and that the Auto-Eval prompt contains `"satisfied": boolean` and not `"passed": boolean`.
  - `tests/graphValidation.test.ts` verifies legacy `passed` JSONPath true-expression and `satisfied` JSONPath true-expression conditions are invalid edge conditions.
  - `tests/utilityNative.test.ts` had a test explicitly proving `satisfied` edge conditions route legacy `{ passed: true }` JSON.
  - `tests/config.test.ts` also verifies saving config with a legacy `passed` JSONPath true-expression edge condition is rejected.
  - WebUI tests include invalid legacy expression conditions and expect them to be shown as invalid/hidden from normal condition labels.

## Does the system provide a strong contract guarantee?

No. The current system provides a partial syntactic guarantee for JSON-parsed nodes, plus partial canonical graph-condition validation, but not a strong handoff contract guarantee.

What is guaranteed today:

- If `parse: "json"`, output must contain parseable JSON somewhere in the assistant text; otherwise the cast fails with an invalid JSON error.
- Configured graph edge conditions must be one of `always`, `satisfied`, or `not_satisfied` at config validation time.
- Edge routing treats `satisfied`/`not_satisfied` as strict booleans when it evaluates the resolved satisfaction value.

What is not guaranteed today:

- The parsed value does not have to be a JSON object; arrays and scalar-looking extracted values can pass parsing where extraction permits.
- Required fields such as `tasks`, `satisfied`, `feedback`, `missing`, `checkpointCreated`, or `commands` are not validated by runtime schemas.
- Reserved routing/control fields are not centrally defined or documented.
- Missing `satisfied` on a routed JSON node does not fail fast; it can silently fall through to `next` or `end` if no edge matches.
- Non-boolean `satisfied` / `passed` values do not produce targeted contract errors; they simply do not match boolean routes.
- Edge routing and `advance.when` disagree on legacy aliases: edges accept `passed` as a fallback, while `advance.when: "satisfied"` does not.

## Stale or conflicting `passed` references

Known source/documentation/test references that conflict with a canonical `satisfied` contract or preserve legacy behavior:

- `src/native.ts`: `resolveSatisfiedValue()` fell back from `$.satisfied` to a legacy `passed` JSONPath field for edge routing.
- `tests/utilityNative.test.ts`: a test named `satisfied edge conditions route legacy Auto-Eval passed JSON` used `{ passed: true }` and expected a `satisfied` edge to route.
- `README.md`: the generic node mechanics example used a legacy `passed` JSONPath true-expression for `edges`, which is no longer valid config syntax. Current README guidance links to the canonical contract.
- `docs/webui-integration-notes.md`: WebUI branch guidance previously said to emit legacy `passed` JSONPath true/false-expression conditions. Current guidance uses canonical condition names.
- `tests/graphValidation.test.ts`, `tests/config.test.ts`, and `src/webui/client/src/App.vitest.tsx`: legacy `passed` JSONPath true-expression conditions appear as invalid-condition fixture coverage. These references are intentional negative tests, but they should remain clearly negative if `passed` is removed as a runtime alias.
- `PI_MATERIA_PLAN.md`: historical plan sections contain multiple stale `passed` examples (`edges.passed`, `passed -> maintainer`, legacy `passed` JSONPath expressions, `{ passed, feedback, missing }`). These are archival/design-plan references but are easy to mistake for current contract guidance.
- `dist/webui/client/assets/...`: generated bundle contains `passed` from the WebUI test/source history or build output; update only through normal source/build flow if needed.

## Risks

- **Runtime alias drift:** `passed` is rejected by graph validation as a condition expression but accepted by edge routing as a payload alias. This makes the actual handoff semantics broader than the documented/default `satisfied` shape.
- **Inconsistent routing semantics:** `edges` accept `passed` fallback; `advance.when` does not. A Maintain-like node using only `{ passed: true }` could route differently than an Auto-Eval-like node.
- **Weak failure modes:** malformed or incomplete handoff objects can fall through the graph instead of failing with actionable schema errors.
- **Prompt duplication:** JSON output shapes are embedded independently in `config/default.json` prompts. Role generation has no shared contract text, so generated materia can drift from runtime expectations.
- **Documentation conflict:** README and WebUI notes showed expression-style `passed` branches even though canonical graph validation accepts only `always`, `satisfied`, and `not_satisfied`.
- **Undocumented reserved fields:** arbitrary payload fields and reserved control fields are not separated in one central place, which makes future fields likely to collide or be inconsistently interpreted.

## Suggested follow-up plan

1. Add a central `src/handoffContract.ts` module with reserved field constants (`satisfied` first), plain-language contract guidance, and explicit legacy/migration notes.
2. Add runtime validation for JSON handoff outputs where routing or advancement depends on reserved fields: require object output, validate reserved field types, and fail fast for missing required routing fields on nodes with `satisfied`/`not_satisfied` edges or `advance.when`.
3. Remove or quarantine the `passed` edge-routing fallback. If retained temporarily, document it as migration-only and emit warnings/errors in tests.
4. Refactor default prompts and role-generation prompt instructions to consume the shared contract guidance instead of duplicating shape prose.
5. Update README/docs examples from legacy `passed` JSONPath true-expression syntax to canonical `when: "satisfied"` / `when: "not_satisfied"` examples and add a dedicated handoff contract document.
6. Add regression tests that keep runtime routing, prompt text, docs, and config validation aligned and prevent `passed` from reappearing as canonical behavior.
