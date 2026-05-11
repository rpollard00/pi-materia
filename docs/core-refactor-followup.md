# Core Refactor Follow-up Gap Audit

Date: 2026-05-11  
Scope: historical targeted audit with current socket terminology notes.

## Baseline validation

Before making the original documentation-only change:

- `npm run typecheck` passed.
- `npm test` passed: 333 tests across 40 files.

Passing tests are useful regression evidence, but they do not prove the architectural refactor is complete.

## Prior-cast claims versus current gaps

| Area | Prior cast artifact claimed | Current targeted evidence | Follow-up conclusion |
| --- | --- | --- | --- |
| Layered core | The prior summary says it completed a staged refactor into domain, application, infrastructure, schema adapters, plugin composition, and layering checks. | The layers exist, and lifecycle behavior has since moved out of the old broad runtime module into focused runtime/application/infrastructure modules. | Keep extracting behavior by ownership instead of creating broad facades. |
| Native runtime shape | The prior summary says application services and infrastructure/plugin adapters were introduced. | `src/castRuntime.ts` is the retained Pi-facing runtime facade; active lifecycle implementation lives behind focused runtime modules. | Import `src/castRuntime.ts` only for intentional Pi-facing runtime facade use. |
| Cast execution split | The prior summary says application ports/use cases were added. | Cast execution use cases now depend on narrow lifecycle/context/agent/status ports instead of one broad runtime facade. | Continue keeping application ports narrow and behavior-oriented. |
| Domain model | The prior summary says a pure materia/loadout domain model was extracted. | `src/domain` now owns pure socket/loadout/handoff/prompt intent concepts. | Keep domain deterministic and free of IO/plugin dependencies. |
| Socket terminology | The socket-only migration supersedes older topology wording. | Config/defaults, saved loadouts, persisted runtime state, artifacts, events, usage, and WebUI DTOs now use socket terminology. | Keep sockets canonical in core and WebUI boundaries. |

## Target layering for future slices

- **Domain**: pure data types and deterministic validation/transition helpers. No filesystem, process, Pi/plugin, provider, native runtime, or WebUI imports.
- **Application**: orchestrates use cases over explicit inputs/outputs and narrow ports. It may coordinate workflow policy, but should not depend on native runtime or WebUI DTO shapes.
- **Infrastructure**: owns filesystem/session persistence, artifact/event/usage IO, process execution, and concrete adapter implementations.
- **Native/plugin runtime**: wires dependencies and registers plugin commands/events. It should not own prompt wording, routing decisions, handoff application, persistence details, utility execution, or recovery policy.
- **WebUI**: loadout/config request and response DTOs are socket-only.

## Follow-up completion update

The planned extraction sequence has been carried through the cleanup slices:

- `src/castRuntime.ts` is the retained Pi-facing runtime facade; lifecycle implementation delegates prompt, handoff/routing, persistence/artifact, utility, recovery, and compaction behavior to focused modules.
- The temporary broad application facade was removed. Cast execution use cases depend on narrow ports.
- Runtime/plugin composition moved to `src/runtime/pluginAdapters.ts`; infrastructure adapters no longer import native runtime code.
- `docs/core-layering.md` and `tests/coreLayering.test.ts` document/enforce that domain stays pure, application avoids native/WebUI/infrastructure, infrastructure avoids native/WebUI/plugin composition, and `src/castRuntime.ts` remains thin.
- Canonical runtime/persistence terminology is socket-based: `currentSocketId`, `currentSocketState`, `socketState`, `bySocket`, `socket_*` events/artifacts, and `sockets/` artifact paths.
