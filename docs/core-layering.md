# Core plugin layering

The core refactor uses dependency inversion around materia/loadout behavior. WebUI contracts remain compatibility boundaries rather than canonical core shapes.

## Layers and responsibilities

- **Domain (`src/domain`)**: pure materia/loadout concepts and invariants: materia definitions, loadouts, sockets, handoff/work-item shape, routing outcomes, prompt intent, and validation helpers. Domain modules must not import Pi plugin APIs, WebUI code, filesystem/process/network modules, provider/runtime modules, persistence implementations, or package dependencies.
- **Application (`src/application`)**: workflow use cases plus narrow ports (`ConfigRepository`, `PipelinePresenter`, `CastStateRepository`, `ArtifactCatalog`, `CastContextPort`, `CastAgentTurnPort`, `CastLifecyclePort`, `CastStatusPort`, `EnvironmentLookup`, and optional `Logger`). Application code depends on domain/core DTOs and these ports, not concrete adapters, native runtime, WebUI, or Node builtins.
- **Infrastructure (`src/infrastructure`)**: concrete IO adapters for config/session persistence, artifact/cast-list filesystem access, usage/event IO, utility process execution, process environment lookup, and console-backed logging. Infrastructure may import application port types, but must not import WebUI, plugin composition, or the native cast runtime.
- **Native runtime (`src/castRuntime.ts`)**: Pi-facing cast lifecycle edge code. It wires the already-extracted application/domain/infrastructure workflows to Pi transport and session APIs. `src/native.ts` is now only a legacy compatibility barrel for older imports.
- **Plugin composition (`src/index.ts`, `src/pluginAdapters.ts`)**: the Pi extension entrypoint and adapter wiring. It registers flags/events/commands, creates infrastructure/runtime adapters, constructs application use cases, and translates Pi UI/command events to use-case calls.
- **Schema/compatibility (`src/schema`, `src/loadoutAccessors.ts`, `src/castStateAccessors.ts`, `src/webui/loadoutDto.ts`)**: anti-corruption adapters for persisted/plugin/WebUI DTO seams. New core code uses canonical socket terminology; these modules normalize or expose remaining legacy DTO spellings.

Dependency direction should remain:

`plugin composition -> native runtime/infrastructure adapters -> application ports/use cases -> domain`

Schema compatibility is an edge concern: external JSON loadouts must use `sockets`; legacy loadout or loop `nodes` payloads are rejected before reaching canonical application/domain workflows. Stable saved-cast, artifact, event, usage, and monitor DTO seams may still use historical node terminology.

## Compatibility policy

- `sockets` is canonical for new core/domain/application code and newly written loadout JSON.
- Legacy `node`/`nodes` names remain only for persisted saved casts, artifact/event/usage fields, historical test filenames, and WebUI monitor DTOs that still expose those names. Loadout topology in config, saved loadouts, and WebUI config DTOs must use `sockets`; old `nodes` payloads fail validation with a `use sockets instead` error.
- `maxSocketVisits` is canonical. `maxNodeVisits` is read only as a legacy config fallback.
- Generated units of work are `workItems`. Legacy `tasks` wording in prompts or adapter metadata must not become a runtime output alias.
- Do not add new public domain/application APIs with node terminology. Do not accept legacy loadout `nodes` at schema/accessor/WebUI DTO boundaries; reject it with actionable `sockets` guidance.

## Where new code should go

- Put deterministic invariants, parsers, and state-transition helpers in `src/domain`.
- Put user-facing workflows and orchestration in `src/application`, depending on explicit ports for IO/runtime work.
- Put filesystem, environment, process execution, artifact/event/session persistence, and usage IO in `src/infrastructure`.
- Put Pi transport/session lifecycle glue in `src/castRuntime.ts`, and keep `src/native.ts` as a tiny compatibility barrel only while imports migrate.
- Put saved JSON shape/version/migration handling in `src/schema` and WebUI loadout shape conversion in `src/webui/loadoutDto.ts`.
- Put Pi command/event registration and adapter wiring in `src/index.ts`/`src/pluginAdapters.ts`.

## Lightweight layering check

`tests/coreLayering.test.ts` scans core TypeScript imports and fails if:

- domain imports anything outside `src/domain` or any Node/package dependency;
- application imports infrastructure, native runtime, WebUI, plugin composition, or Node builtins;
- infrastructure imports WebUI, native runtime, or plugin composition;
- schema compatibility imports application, infrastructure, WebUI, or plugin composition;
- `src/native.ts` stops being a thin compatibility module.

Run it with the normal suite (`npm test`). For review, also check that legacy terminology remains limited to rejection checks for old loadout payloads, persisted DTO types, tests/fixtures, or explicit external compatibility notes for saved casts/artifacts/events/usage/monitor data.

## Validation and follow-up debt

Validation for refactor-followup-08 (2026-05-11):

- `npm run typecheck` passed.
- `npm test` passed.

Validation for the socket-only loadout migration (2026-05-11):

- `bun test` passed.
- `npm run test:webui` passed.
- `npm run typecheck` passed.

Known compatibility seams that remain intentional:

- Saved casts, WebUI monitor DTOs, event data, usage summaries, and artifact paths still expose stable `node`/`nodes` names for compatibility. Renaming those external surfaces requires a separate migration/contract plan.
- `src/native.ts` remains as a compatibility barrel; new code should import focused modules or compose ports through `src/pluginAdapters.ts`.
