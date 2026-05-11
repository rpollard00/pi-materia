# Schema and persistence compatibility

Core persistence adapters live in `src/schema/persistence.ts` so external JSON compatibility stays outside the pure domain layer.

- New loadout schema adapters use `sockets` as the canonical persisted terminology.
- Legacy `nodes` input is accepted only as a migration compatibility alias and is normalized to domain `sockets` before domain-facing use.
- The domain/application model is socket-first. `nodes` remains only in the persisted/plugin/WebUI DTO bridge and legacy migration fixtures.
- Loop membership follows the same rule: persisted `loops.*.sockets` is canonical, while legacy `loops.*.nodes` is migration-only input.
- Handoff payload compatibility keeps generated units of work canonical as `workItems`. Legacy `tasks` is not normalized into new domain payloads, and reserved evaluator/flow fields `satisfied`, `feedback`, and `missing` remain owned by routing/evaluation semantics.

Do not add new domain APIs that accept `nodes`; keep legacy spelling isolated to schema/persistence compatibility code.
