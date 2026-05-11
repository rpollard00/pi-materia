# Schema and persistence compatibility

Core persistence adapters live in `src/schema/persistence.ts` so external JSON compatibility stays outside the pure domain layer.

- Loadout schema adapters use `sockets` as the canonical persisted topology terminology.
- Persisted loop membership uses `loops.*.sockets`.
- The domain/application model is socket-first; config, persistence, and WebUI payloads should not expose alternate topology aliases.
- Handoff payloads keep generated units of work canonical as `workItems`; reserved evaluator/flow fields `satisfied`, `feedback`, and `missing` remain owned by routing/evaluation semantics.
- Newly written saved casts, manifests, artifacts, usage reports, and monitor DTOs use socket terminology (`currentSocketId`, `socketState`, `socket_*` event/artifact kinds, `sockets/` artifact paths, and `bySocket` buckets).

Do not add new domain, application, config, persistence, or WebUI APIs that accept loadout topology under any non-`sockets` field.
