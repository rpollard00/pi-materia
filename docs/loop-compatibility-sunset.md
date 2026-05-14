# Loop compatibility and sunset plan

This document inventories the temporary compatibility boundaries that let existing UI-authored and persisted loadouts keep running while new loadouts use the structured loop model.

## Canonical structured loop model

New-model loop routing has four separate responsibilities:

1. **Normal edges** (`edges[].when` / `edges[].to`) route same-item control flow between sockets. `satisfied` and `not_satisfied` remain ordinary predicates over the parsed boolean `satisfied` field; retry and forward edges are not post-loop metadata.
2. **Cursor advance** (`advance.cursor`, `advance.items`, `advance.when`) advances to the next item and detects exhaustion. It does not own the canonical post-loop route.
3. **Loop exit routes** (`loops.<id>.exits`) own post-exhaustion routing after an empty-loop entry or after the final item completes.
4. **Terminal fallback** uses `end`, the only graph/loadout terminal sentinel, when no loop-owned exit route matches.

New loadouts should therefore omit route-bearing `advance.done` for loop exits. Use `loops.<id>.exits` for socket targets after exhaustion, or omit matching exits to terminate at `end`.

## Detecting new-model or normalized configs

A loadout is new-model or normalized for loop routing when all of these are true:

- Every socket-valued post-loop route is present in `loops.<id>.exits` with `{ from, condition, targetSocketId }`.
- `advance` blocks on loop members contain cursor/items/when behavior only, or contain only `done: "end"` as preserved legacy terminal compatibility.
- Any legacy `loops.<id>.exit.to` or loop-member `advance.done` that points at a socket already has an equivalent canonical `loops.<id>.exits` route.
- Loop back-edges remain normal same-item continuation/retry edges inside the loop and are not interpreted as post-exhaustion exits.
- UI-only descriptive edge/rune metadata is preserved as presentation data unless it is explicitly backed by `loops.<id>.exits`.

The implementation helper `isCanonicalOrNormalizedLoopRouting()` in `src/loadout/loopCompatibility.ts` performs the main route-coverage check for legacy `loop.exit` and `advance.done` socket targets.

## Compatibility shim inventory

| Shim / behavior | Owner / location | Rationale | Removal condition | Test coverage classification |
| --- | --- | --- | --- | --- |
| Legacy `loops.<id>.exit` mirroring | `normalizeLegacyLoopRoutingCompatibilityInPlace()` / `normalizeLegacyLoopExit()` in `src/loadout/loopCompatibility.ts`; invoked by `normalizeLoadedLoadout()` in `src/loadout/loadoutNormalization.ts` | Older UI saves stored one descriptive loop exit instead of canonical `loops.<id>.exits`. Socket targets are mirrored so runtime, validation, link compilation, and save preparation can use structured routing. `to: "end"` is not mirrored because missing route means terminal fallback. | After a versioned migration or save path rewrites persisted loadouts with canonical `loops.<id>.exits`, and telemetry/tests show no supported configs depend on `loop.exit` for socket routing. | Keep `tests/loadoutNormalization.test.ts` normalization/non-mutation coverage and `tests/crossBoundaryLoopSemantics.test.ts` until removal; convert them into rejection/migration-command tests when the shim is removed. |
| Legacy loop-member `advance.done` mirroring | `normalizeLegacyLoopRoutingCompatibilityInPlace()` / `normalizeLegacyAdvanceDone()` in `src/loadout/loopCompatibility.ts` | Prior materialization used `advance.done` as the final-item route. Socket-valued `done` targets are mirrored into canonical exits. `done: "end"` remains accepted as terminal compatibility but is not a canonical route. | After newly saved/materialized loadouts no longer write route-bearing `advance.done`, old configs have a migration path, and validators can warn/error on socket-valued `advance.done` in loop members. | Keep `tests/loadoutNormalization.test.ts`, `tests/graphSemantics.test.ts`, `tests/workflowTransitions.test.ts`, `tests/linkCompiler.test.ts`, and `tests/crossBoundaryLoopSemantics.test.ts` compatibility cases; delete or convert `legacy advance.done` fallback assertions after removal. |
| Legacy terminal back-edge detection | `detectLegacyTerminalBackEdges()` in `src/loadout/loopCompatibility.ts` | Old runtime scaffolding and UI-created loops often have unconditional edges back into the loop. These are normal continuation/retry edges, not post-loop exits, but detecting them prevents accidental route inference and documents why they remain untouched. | When all supported loop authoring emits canonical `loops.<id>.exits` and docs/tests no longer need to distinguish old scaffold back-edges from exits. Do not remove if the UI still presents loop continuation edges this way. | Keep `tests/loadoutNormalization.test.ts` back-edge detection and cross-boundary same-item edge coverage; retain normal-edge tests permanently even after compatibility detection is removed. |
| Runtime legacy `advance.done` fallback for non-loop-owned sockets | `resolveLoopExhaustionTargetWithLegacyAdvanceDoneFallback()` and `resolveIndexedLoopExhaustionTargetWithLegacyAdvanceDoneFallback()` in `src/graph/graphSemantics.ts`; called through `applyAdvance()` in `src/application/workflowTransitions.ts` | Some non-normalized or non-loop socket flows may still use `advance.done` as a final target. The fallback is explicitly named so runtime code does not inline `canonicalRoute ?? advance.done` again. | After normalization covers all supported loop-member cases and any remaining non-loop `advance.done` usage is either migrated or deliberately specified as non-loop semantics. | Keep helper-level tests in `tests/graphSemantics.test.ts` and runtime tests in `tests/workflowTransitions.test.ts`; convert fallback cases to canonical exit-or-`end` tests when removed. |
| Empty-loop legacy iterator/foreach `done` input | `resolveEmptyLoopExhaustionTarget()` in `src/application/workflowTransitions.ts`; called by `src/runtime/nativeLifecycle.ts` with `loop.done` | Older iterator/foreach metadata can specify a no-item route. New-model empty-loop routing uses the same loop exit-or-`end` resolver as final-item exhaustion, with legacy `done` only as compatibility when no loop owns the socket. | After persisted configs no longer rely on iterator/foreach `done` for loop exits and validators can require canonical exits or terminal fallback for loop-owned empty entry. | Keep `tests/workflowTransitions.test.ts`, `tests/yoloLoopSemantics.test.ts`, and `tests/crossBoundaryLoopSemantics.test.ts` empty-loop cases; convert legacy-done tests to migration-error tests after removal. |
| Generator output/iterator compatibility | `migrateLegacyLoopConsumers()` and `validateLegacyGeneratorDeclaration()` in `src/runtime/pipeline.ts`; generator helpers in `src/graph/generator.ts` | Older loop configs may have iterator metadata or obsolete `generates` fields. Runtime infers `consumes` only when there is exactly one canonical generator source, and rejects obsolete generated-output aliases for new runtime semantics. | After configs have explicit `consumes` and `generator: true`, and old `generates` metadata is either migrated or rejected everywhere with a versioned migration note. | Keep `tests/pipeline.test.ts`, `tests/generator.test.ts`, and handoff drift tests; convert inference tests to migration-command tests when inference is removed. |
| Legacy graph syntax normalization (`next`, Flow aliases) | `normalizePipelineGraph()` in `src/graph/graphValidation.ts` and WebUI transforms in `src/webui/client/src/loadoutModel.ts` / `loadoutTransforms.ts` | Older configs and editor state may still store `next` or UI Flow aliases. They normalize into canonical ordered `edges` / `when: "always"`. | After saved configs and WebUI no longer emit these forms and a migration command exists for old configs. | Keep `tests/graphValidation.test.ts` and WebUI loadout transform/model tests; convert accepted legacy syntax cases to migration-only or rejection tests after removal. |
| UI descriptive edges/runes preservation | WebUI loadout model/transforms and loop exit route helpers in `src/webui/client/src/loadoutModel.ts`, `src/webui/client/src/loadoutTransforms.ts`, and graph route metadata helpers | Visual labels such as loop-exit runes are presentation affordances. They must not become hidden routing semantics unless backed by canonical `loops.<id>.exits`. | Do not remove while the WebUI displays descriptive loop edges. Sunset only the compatibility interpretation; keep presentation metadata preservation. | Keep WebUI model/transform tests and cross-boundary source non-mutation tests; no runtime fallback tests should depend on descriptive metadata alone. |

## Warning-to-error policy

Current compatibility remains non-destructive: normalization preserves legacy fields and adds canonical route metadata on cloned/prepared loadouts where safe. Unknown non-sentinel targets already remain validation errors.

Warnings should become errors in this order:

1. **Now / current behavior:** error on unknown targets, incompatible parse/advance conflicts, obsolete authored `generates` runtime metadata, and ambiguous legacy iterator loops with multiple generator sources.
2. **After a migration command or automatic save rewrite exists:** warn when loop-member `advance.done` points at a socket and can be mirrored; warn when `loops.<id>.exit.to` points at a socket but `loops.<id>.exits` is absent.
3. **After one documented release with warnings:** error on route-bearing `advance.done` and socket-valued `loop.exit.to` in new saves, while still allowing explicit migration commands to read them.
4. **After compatibility tests are converted:** remove runtime fallback branches that are no longer reachable from normalized configs.

Never warn for `advance.done: "end"` solely because it is present in an old loadout; it is accepted terminal compatibility. New authoring docs should still omit it because terminal fallback is represented by no matching loop exit route.

## Tests to delete or convert at sunset

When compatibility is removed, update tests instead of silently deleting coverage:

- Convert `legacy advance.done` fallback tests in `tests/graphSemantics.test.ts` and `tests/workflowTransitions.test.ts` into canonical `loops.<id>.exits` and terminal-fallback tests.
- Convert `tests/loadoutNormalization.test.ts` cases for mirroring `loop.exit` / `advance.done` into explicit migration-command tests or rejection diagnostics.
- Keep same-item `satisfied` / `not_satisfied` edge tests permanently; they are canonical normal control flow.
- Keep `/materia link` remapping and source non-mutation tests, but remove assertions that route-bearing `advance.done` is accepted once link inputs are required to be normalized.
- Keep WebUI presentation tests for descriptive edges/runes, but ensure they assert presentation preservation rather than runtime routing.

## Documentation cleanup rules

Avoid phrases such as “terminal advance target” for loop completion. Prefer:

- “cursor advancement/exhaustion detection” for `advance`;
- “loop-owned post-exhaustion route” for `loops.<id>.exits`;
- “terminal fallback to `end`” when no loop exit route exists.

Historical audit documents may quote old behavior, but they must label it as historical or compatibility-only and point back to `docs/structured-loop-semantics.md` plus this sunset inventory.
