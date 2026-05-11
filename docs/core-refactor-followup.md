# Core Refactor Follow-up Gap Audit

Date: 2026-05-11  
Scope: targeted audit only. Primary input is the prior cast artifact `./.pi/pi-materia/2026-05-10T23-19-08-320Z/nodes/Socket-8/1.md`; repository inspection was limited to `src/native.ts`, `src/application/ports.ts`, `src/domain`, and the WebUI loadout DTO path.

## Baseline validation

Before making this documentation-only change:

- `npm run typecheck` passed.
- `npm test` passed: 333 tests across 40 files.

Passing tests are useful regression evidence, but they do not prove the architectural refactor is complete.

## Prior-cast claims versus current gaps

| Area | Prior cast artifact claimed | Current targeted evidence | Follow-up conclusion |
| --- | --- | --- | --- |
| Layered core | The prior summary says it completed a staged refactor into domain, application, infrastructure, schema adapters, plugin composition, and layering checks. | The layers exist, but `src/native.ts` is still 1,723 lines and owns cast lifecycle, handoff application, routing, prompt assembly, persistence/artifacts, utility command execution, recovery, compaction, and Pi transport calls. | The layering is a useful start, not a completed split. Continue by extracting behavior slices from `native.ts`, not by creating another broad facade. |
| Native runtime shape | The prior summary says application services and infrastructure/plugin adapters were introduced. | `src/native.ts` remains much more than plugin/runtime wiring. It contains functions such as `startNativeCast`, `handleAgentEnd`, `completeSocket`, `applyGenericHandoffEnvelope`, `selectNextTarget`, `executeCommandUtility`, `handleSameSocketRecoverableTurnFailure`, `writeContextArtifact`, `buildSocketPrompt`, and `buildIsolatedMateriaContext`. | Native is still the mixed-concern module. The target is a thin composition layer for command registration, dependency wiring, adapter calls, and temporary compatibility exports only. |
| Cast execution split | The prior summary says application ports/use cases were added. | `src/application/ports.ts` explicitly labels `CastRuntime` as a temporary workflow facade around the existing native/plugin runtime, with broad methods spanning prompt/context, lifecycle, agent-end handling, resume/revive, clear, and status. | Cast execution has not been fully split into narrow application use cases and infrastructure adapters. `CastRuntime` is debt to remove after extraction. |
| Domain model | The prior summary says a pure materia/loadout domain model was extracted. | `src/domain` currently has `result.ts`, `socket.ts`, `handoff.ts`, `loadout.ts`, and `index.ts`; there is no `src/domain/materia.ts`, and `src/domain/index.ts` exports no materia module. | The domain is incomplete for a project whose core concept is materia. Add a first-class pure materia domain model before deeper runtime extraction depends on ad hoc runtime/config types. |
| Sockets versus nodes | The prior summary says internals migrated to canonical sockets and legacy `nodes` was retained only for compatibility. | Core/schema compatibility helpers use `sockets ?? nodes`, while the WebUI client loadout model still defines `PipelineConfig.nodes`, `PipelineLoop.nodes`, and tests assert `loadout.nodes`. | Keep sockets canonical in core. Treat WebUI `nodes` as a narrow DTO compatibility seam that needs an explicit adapter; do not perform a broad WebUI rewrite. |
| Compatibility seams | The prior summary says remaining `node`/`nodes` names are stable external or persisted surfaces. | Current tests still include native/recovery names such as same-node recovery and usage by-node output, while WebUI DTOs remain node-shaped. | Preserve saved cast, artifact, event, usage, and WebUI compatibility unless a tested migration is created. Document any remaining `node` names as external compatibility, not domain terminology. |

## Target layering for the next slices

- **Domain**: pure data types and deterministic validation/transition helpers. No filesystem, process, Pi/plugin, provider, native runtime, or WebUI imports.
- **Application**: orchestrates use cases over explicit inputs/outputs and narrow ports. It may coordinate workflow policy, but should not depend on `native.ts` or WebUI DTO shapes.
- **Infrastructure**: owns filesystem/session persistence, artifact/event/usage IO, process execution, and concrete adapter implementations.
- **Native/plugin runtime**: wires dependencies and registers plugin commands/events. It should not own prompt wording, routing decisions, handoff application, persistence details, utility execution, or recovery policy.
- **WebUI**: may keep legacy node-shaped DTOs only behind an explicit adapter boundary. Sockets remain canonical internally.

## Recommended next steps

1. Repair the WebUI socket-first compatibility seam with a focused sockets-to-nodes DTO adapter and round-trip coverage.
2. Add `src/domain/materia.ts` with pure, data-oriented materia definitions and validation/normalization helpers.
3. Extract deterministic handoff, assignment, routing, loop advancement, and current-work-item selection from `src/native.ts` behind characterization tests.
4. Then extract prompt/synthetic-context assembly, persistence/artifact/event/usage IO, and utility/recovery/compaction workflows in separate slices.
5. Finally collapse `src/native.ts` into a thin runtime/composition module and replace the temporary `CastRuntime` facade with narrower use-case-specific ports.
