# Core plugin layering

The core refactor uses a small dependency-inversion boundary around materia/loadout behavior:

- **Domain (`src/domain`)**: pure materia/loadout concepts and invariants. It must not import Pi plugin APIs, WebUI code, filesystem/process/network modules, provider/runtime modules, or persistence implementations.
- **Application (`src/application`)**: workflow use cases plus small ports (`ConfigRepository`, `PipelinePresenter`, `CastStateRepository`, `ArtifactCatalog`, `CastRuntime`, `EnvironmentLookup`, and optional `Logger`). Application code depends on domain/core DTOs and these ports, not concrete adapters. Ports are retained only when a use case consumes them; speculative ports such as clock/id/VCS helpers should be added only when a workflow needs them.
- **Infrastructure (`src/infrastructure`)**: concrete implementations of application ports for config persistence, pipeline presentation, artifact/cast-list filesystem access, process environment lookup, console-backed logging, and the native Pi cast runtime/state APIs. Infrastructure may import application port types and existing runtime modules.
- **Plugin composition (`src/index.ts`)**: the Pi extension entrypoint. It registers flags/events/commands, creates infrastructure adapters with `createMateriaPluginAdapters`, constructs application use cases, and translates Pi UI/command events to use-case calls. Composition code may use Pi APIs directly for registration and UI response handling; reusable IO/runtime behavior belongs in infrastructure adapters.

Dependency direction should remain:

`plugin composition -> infrastructure adapters -> application ports/use cases -> domain`

Schema/persistence compatibility remains an edge concern: external JSON and legacy `nodes` payloads are normalized by schema/persistence adapters before reaching canonical application/domain workflows. WebUI contracts should be preserved; WebUI-specific refactors are out of scope for the core layering work.

`CastRuntime` is intentionally a narrow facade over the existing native/plugin runtime for the cast-execution workflow. If future work needs provider/model access outside that workflow, introduce a smaller use-case-specific port instead of expanding this facade. VCS detection currently lives in the built-in utility registry rather than application use cases, so it is not exposed as an application port until a core workflow consumes it.
