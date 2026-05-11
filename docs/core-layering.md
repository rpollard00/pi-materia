# Core plugin layering

The core refactor uses a small dependency-inversion boundary around materia/loadout behavior. WebUI code is intentionally out of scope; preserve its DTO/API contracts rather than reshaping it as part of core work.

## Layers and responsibilities

- **Domain (`src/domain`)**: pure materia/loadout concepts and invariants: loadouts, sockets, handoff/work-item shape, routing outcomes, prompt intent, and small result/validation helpers. Domain modules must not import Pi plugin APIs, WebUI code, filesystem/process/network modules, provider/runtime modules, persistence implementations, or package dependencies.
- **Application (`src/application`)**: workflow use cases plus small ports (`ConfigRepository`, `PipelinePresenter`, `CastStateRepository`, `ArtifactCatalog`, `CastRuntime`, `EnvironmentLookup`, and optional `Logger`). Application code depends on domain/core DTOs and these ports, not concrete adapters. Ports are retained only when a use case consumes them; speculative ports such as clock/id/VCS helpers should be added only when a workflow needs them.
- **Infrastructure (`src/infrastructure`)**: concrete implementations of application ports for config persistence, pipeline presentation, artifact/cast-list filesystem access, process environment lookup, console-backed logging, and the native Pi cast runtime/state APIs. Infrastructure may import application port types and existing runtime modules, but not WebUI internals or plugin composition.
- **Schema/compatibility (`src/schema`, `src/loadoutAccessors.ts`, `src/castStateAccessors.ts`)**: anti-corruption adapters for persisted/plugin/WebUI DTO seams. New code should use canonical socket terminology; these modules are where remaining legacy DTO spellings are normalized or read.
- **Plugin composition (`src/index.ts`)**: the Pi extension entrypoint. It registers flags/events/commands, creates infrastructure adapters with `createMateriaPluginAdapters`, constructs application use cases, and translates Pi UI/command events to use-case calls. Composition code may use Pi APIs directly for registration and UI response handling; reusable IO/runtime behavior belongs in infrastructure adapters.

Dependency direction should remain:

`plugin composition -> infrastructure adapters -> application ports/use cases -> domain`

Schema compatibility is an edge concern: external JSON and legacy `nodes` payloads are normalized by schema/persistence adapters before reaching canonical application/domain workflows. WebUI contracts should be preserved; WebUI-specific refactors are out of scope for the core layering work.

`CastRuntime` is intentionally a narrow facade over the existing native/plugin runtime for the cast-execution workflow. If future work needs provider/model access outside that workflow, introduce a smaller use-case-specific port instead of expanding this facade. VCS detection currently lives in the built-in utility registry rather than application use cases, so it is not exposed as an application port until a core workflow consumes it.

## Compatibility policy

- `sockets` is canonical for new core/domain/application code and newly written loadout JSON.
- Legacy `nodes` fields remain accepted for persisted loadouts, saved casts, event/artifact paths, and WebUI DTOs that still expose those names. Treat the field values as socket ids.
- `maxSocketVisits` is canonical. `maxNodeVisits` is read only as a legacy config fallback.
- Generated units of work are `workItems`. Legacy `tasks` wording in prompts or adapter metadata must not become a runtime output alias.
- Do not add new public domain/application APIs with node terminology. If old data must be accepted, normalize it in `src/schema/persistence.ts` or the small compatibility accessors listed above.

## Where new code should go

- Put deterministic invariants, parsers, and state-transition helpers in `src/domain`.
- Put user-facing workflows and orchestration in `src/application`, depending on explicit ports for IO/runtime work.
- Put filesystem, environment, cast runtime, and other concrete adapters in `src/infrastructure` or existing runtime modules that are then wrapped by infrastructure ports.
- Put saved JSON shape/version/migration handling in `src/schema`.
- Put Pi command/event registration and adapter wiring in `src/index.ts`.
- Do not move WebUI implementation code as part of core changes unless required to preserve an existing DTO/import contract.

## Lightweight layering check

`tests/coreLayering.test.ts` scans core TypeScript imports and fails if:

- domain imports anything outside `src/domain` or any Node/package dependency;
- application imports infrastructure, WebUI, plugin composition, or Node builtins;
- infrastructure imports WebUI or plugin composition;
- schema compatibility imports application, infrastructure, WebUI, or plugin composition.

Run it with the normal suite (`npm test`). For review, also check that new legacy-terminology support is limited to `src/schema/persistence.ts`, `src/loadoutAccessors.ts`, `src/castStateAccessors.ts`, persisted DTO types, tests/fixtures, or explicit external compatibility notes.

## Validation and follow-up debt

Validation for core-refactor-08 (2026-05-10):

- `npm run typecheck` passed.
- `npm test` passed (333 tests).

Known follow-up debt that does not block this refactor:

- Saved casts, WebUI monitor DTOs, event data, and artifact paths still expose stable `node`/`nodes` names for compatibility. Renaming those external surfaces requires a separate migration/contract plan.
- The `sameNodeRecoveryNative` test file name still reflects historical terminology, but test imports and runtime APIs now use same-socket naming.
