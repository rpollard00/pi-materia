# Core plugin layering

The core refactor uses dependency inversion around materia/loadout behavior. Socket terminology is canonical across core, runtime, persistence, and WebUI contracts.

## Layers and responsibilities

- **Domain (`src/domain`)**: pure materia/loadout concepts and invariants: materia definitions, loadouts, sockets, handoff/work-item shape, routing outcomes, prompt intent, and validation helpers. Domain modules must not import Pi plugin APIs, WebUI code, filesystem/process/network modules, provider/runtime modules, persistence implementations, or package dependencies.
- **Application (`src/application`)**: workflow use cases plus narrow ports (`ConfigRepository`, `PipelinePresenter`, `CastStateRepository`, `ArtifactCatalog`, `CastContextPort`, `CastAgentTurnPort`, `CastLifecyclePort`, `CastStatusPort`, `EnvironmentLookup`, and optional `Logger`). Application code depends on domain/core DTOs and these ports, not concrete adapters, native runtime, WebUI, or Node builtins.
- **Infrastructure (`src/infrastructure`)**: concrete IO adapters for config/session persistence, artifact/cast-list filesystem access, usage/event IO, utility process execution, process environment lookup, and console-backed logging. Infrastructure may import application port types, but must not import WebUI, plugin composition, or the native cast runtime.
- **Runtime facade (`src/castRuntime.ts`)**: Pi-facing cast lifecycle facade. It wires the already-extracted application/domain/infrastructure workflows to Pi transport and session APIs while the focused implementation lives under `src/runtime`.
- **Plugin composition (`src/index.ts`, `src/runtime/pluginAdapters.ts`)**: the Pi extension entrypoint and adapter wiring. It registers flags/events/commands, creates infrastructure/runtime adapters, constructs application use cases, and translates Pi UI/command events to use-case calls.
- **Schema (`src/schema`, `src/loadout`, `src/graph`)**: adapters for saved JSON shape/version handling, graph normalization, and validation. New core code uses canonical socket terminology.

Dependency direction should remain:

`plugin composition -> native runtime/infrastructure adapters -> application ports/use cases -> domain`

Schema handling is an edge concern: external JSON loadouts must use `sockets` and newly written runtime/persistence DTOs use socket-shaped fields.

## Compatibility policy

- `sockets` is canonical for core/domain/application code and loadout JSON.
- `currentSocketId`, `currentSocketState`, `socketState`, `socketId`, `bySocket`, `socket_*` event/artifact kinds, and `sockets/` artifact paths are canonical runtime/persistence names.
- `maxSocketVisits` is canonical for socket visit limits.
- Generated units of work are `workItems`. Older task wording in prompts or adapter metadata must not become a runtime output alias.
- Do not add public domain/application APIs with non-socket topology terminology.

## Root surface and import policy

The base `src/` directory is reserved for intentional entrypoints/facades:

- `src/index.ts`: package Pi extension entrypoint registered by `package.json`.
- `src/types.ts`: shared public DTO/type surface.
- `src/castRuntime.ts`: Pi-facing runtime facade for cast lifecycle integration.

Do not add root compatibility barrels or one-line `export * from "./..."` shims. Import focused nested modules by default, such as `src/config/config.ts`, `src/graph/graphValidation.ts`, or `src/runtime/nativeLifecycle.ts`. Use `src/castRuntime.ts` only when consuming the Pi-facing runtime facade; implementation code should prefer the narrower nested module that owns the behavior.

## Where new code should go

- Put deterministic invariants, parsers, and state-transition helpers in `src/domain`.
- Put user-facing workflows and orchestration in `src/application`, depending on explicit ports for IO/runtime work.
- Put filesystem, environment, process execution, artifact/event/session persistence, and usage IO in `src/infrastructure`.
- Put Pi transport/session lifecycle facade exports in `src/castRuntime.ts` and focused implementation modules under `src/runtime`.
- Put saved JSON shape/version/migration handling in `src/schema` and WebUI loadout shape conversion in `src/webui/loadoutDto.ts`.
- Put Pi command/event registration and adapter wiring in `src/index.ts`/`src/runtime/pluginAdapters.ts`.

## Lightweight layering check

`tests/coreLayering.test.ts` scans core TypeScript imports and fails if:

- domain imports anything outside `src/domain` or any Node/package dependency;
- application imports infrastructure, runtime facades, WebUI, plugin composition, or Node builtins;
- infrastructure imports WebUI, runtime facades, or plugin composition;
- schema imports application, infrastructure, WebUI, or plugin composition;
- `src/native.ts` is restored or root export-star compatibility shims are reintroduced instead of importing focused nested modules.

Run it with the normal suite (`npm test`).

## Validation

Recent validation for the socket-only contract and layout refactor:

- `npm run typecheck` passed.
- `npm test` passed.
- `npm run test:webui` passed.
