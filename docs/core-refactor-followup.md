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
| Sockets versus nodes | The prior summary says internals migrated to canonical sockets and legacy `nodes` was retained only for compatibility. | This row is superseded by the socket-only loadout migration: config/defaults, saved loadouts, and WebUI config DTOs now require `sockets`; legacy loadout or loop `nodes` payloads are rejected with guidance to use `sockets` instead. | Keep sockets canonical in core and WebUI loadout/config boundaries. Do not reintroduce `nodes` as a loadout topology compatibility seam. |
| Compatibility seams | The prior summary says remaining `node`/`nodes` names are stable external or persisted surfaces. | Current tests still include native/recovery names such as same-node recovery and usage by-node output. WebUI monitor/status DTOs may still expose historical node terminology, but WebUI loadout/config DTOs are socket-only. | Preserve saved cast, artifact, event, usage, and WebUI monitor compatibility unless a tested migration is created. Document any remaining `node` names as external compatibility, not loadout topology terminology. |

## Target layering for the next slices

- **Domain**: pure data types and deterministic validation/transition helpers. No filesystem, process, Pi/plugin, provider, native runtime, or WebUI imports.
- **Application**: orchestrates use cases over explicit inputs/outputs and narrow ports. It may coordinate workflow policy, but should not depend on `native.ts` or WebUI DTO shapes.
- **Infrastructure**: owns filesystem/session persistence, artifact/event/usage IO, process execution, and concrete adapter implementations.
- **Native/plugin runtime**: wires dependencies and registers plugin commands/events. It should not own prompt wording, routing decisions, handoff application, persistence details, utility execution, or recovery policy.
- **WebUI**: loadout/config request and response DTOs are socket-only; reject legacy topology `nodes` with actionable `sockets` guidance. Historical node terminology may remain only in monitor/status compatibility DTOs until a separate migration is planned.

## Follow-up completion update (refactor-followup-08)

The planned extraction sequence has now been carried through the final cleanup slice:

- `src/native.ts` is a tiny compatibility barrel; the remaining Pi-facing lifecycle implementation is in `src/castRuntime.ts` and delegates prompt, handoff/routing, persistence/artifact, utility, recovery, and compaction behavior to focused modules.
- The temporary `CastRuntime` application facade was removed. Cast execution use cases now depend on narrow ports: `CastContextPort`, `CastAgentTurnPort`, `CastLifecyclePort`, and `CastStatusPort`.
- Runtime/plugin composition moved to `src/pluginAdapters.ts`; infrastructure adapters no longer import native runtime code.
- `docs/core-layering.md` and `tests/coreLayering.test.ts` document/enforce that domain stays pure, application avoids native/WebUI/infrastructure, infrastructure avoids native/WebUI/plugin composition, and `src/native.ts` remains thin.
- Remaining `node`/`nodes` names are intentional external compatibility surfaces for persisted data, event/artifact/usage fields, WebUI monitor/status DTOs, or historical tests. Loadout topology in config, saved artifacts, and WebUI config DTOs is socket-only and rejects legacy `nodes`. Canonical internal terminology remains sockets.
