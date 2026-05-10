# Schema and persistence compatibility

Core persistence adapters live in `src/schema/persistence.ts` so external JSON compatibility stays outside the pure domain layer.

- New loadout schema adapters use `sockets` as the canonical persisted terminology.
- Legacy `nodes` input is accepted only as a migration compatibility alias and is normalized to domain `sockets` before domain-facing use.
- The current runtime/application DTO still exposes `nodes`; the schema adapter contains the temporary bridge from domain `sockets` back to that DTO until the later internal terminology migration.
- Loop membership follows the same rule: persisted `loops.*.sockets` is canonical, while legacy `loops.*.nodes` is migration-only input.
- Handoff payload compatibility keeps generated units of work canonical as `workItems`. Legacy `tasks` is not normalized into new domain payloads, and reserved evaluator/flow fields `satisfied`, `feedback`, and `missing` remain owned by routing/evaluation semantics.

Do not add new domain APIs that accept `nodes`; keep legacy spelling isolated to schema/persistence compatibility code.
