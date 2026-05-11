# Schema and persistence compatibility

Core persistence adapters live in `src/schema/persistence.ts` so external JSON compatibility stays outside the pure domain layer.

- New loadout schema adapters use `sockets` as the canonical persisted terminology.
- Legacy loadout-level `nodes` input is rejected at config and persistence boundaries with an error that tells users to use `sockets` instead.
- The domain/application model is socket-first. Loadout `nodes` remains only in negative tests and TypeScript DTO fields that let those rejection paths type-check.
- Loop membership follows the same rule: persisted `loops.*.sockets` is canonical, while legacy `loops.*.nodes` is rejected with an actionable `sockets` error.
- Handoff payload compatibility keeps generated units of work canonical as `workItems`. Legacy `tasks` is not normalized into new domain payloads, and reserved evaluator/flow fields `satisfied`, `feedback`, and `missing` remain owned by routing/evaluation semantics.
- Stable external surfaces may still spell socket ids as `node`/`nodes` (saved casts, manifest events, artifact paths, usage buckets, and WebUI monitor DTOs). Treat those as external compatibility seams, not canonical internal terminology.

Do not add new domain, application, config, persistence, or WebUI APIs that accept loadout topology as `nodes`; use `sockets` in saved loadouts and WebUI payloads.
