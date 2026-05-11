# Schema and persistence compatibility

Core persistence adapters live in `src/schema/persistence.ts` so external JSON compatibility stays outside the pure domain layer.

- New loadout schema adapters use `sockets` as the canonical persisted terminology.
- Legacy `nodes` input is accepted only as a migration compatibility alias and is normalized to domain `sockets` before domain-facing use.
- The domain/application model is socket-first. `nodes` remains only in the persisted/plugin/WebUI DTO bridge, the compatibility accessors (`src/loadoutAccessors.ts`, `src/castStateAccessors.ts`), and legacy migration fixtures/tests.
- Loop membership follows the same rule: persisted `loops.*.sockets` is canonical, while legacy `loops.*.nodes` is migration-only input.
- Handoff payload compatibility keeps generated units of work canonical as `workItems`. Legacy `tasks` is not normalized into new domain payloads, and reserved evaluator/flow fields `satisfied`, `feedback`, and `missing` remain owned by routing/evaluation semantics.
- Stable external surfaces may still spell socket ids as `node`/`nodes` (saved casts, manifest events, artifact paths, usage buckets, and WebUI monitor DTOs). Treat those as external compatibility seams, not canonical internal terminology.

Do not add new domain or application APIs that accept `nodes`; keep legacy spelling isolated to schema/persistence compatibility code or the documented DTO/accessor bridge.
