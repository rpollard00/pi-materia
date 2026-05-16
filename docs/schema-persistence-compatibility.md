# Schema and persistence compatibility

Core persistence adapters live in `src/schema/persistence.ts` so external JSON compatibility stays outside the pure domain layer.

- Loadout schema adapters use `sockets` as the canonical persisted topology terminology.
- Persisted loop membership uses `loops.*.sockets`.
- The domain/application model is socket-first; config, persistence, and WebUI payloads should not expose alternate topology aliases.
- Handoff payloads keep generated units of work canonical as `workItems`; reserved evaluator/flow fields `satisfied`, `feedback`, and `missing` remain owned by routing/evaluation semantics.
- Newly written saved casts, manifests, artifacts, usage reports, and monitor DTOs use socket terminology (`currentSocketId`, `socketState`, `socket_*` event/artifact kinds, `sockets/` artifact paths, and `bySocket` buckets).

## Loop routing compatibility boundary

Newly materialized loop loadouts encode post-loop routing in canonical `loops.<id>.exits` route metadata. `advance` remains cursor/exhaustion detection; new materialization does not rely on `advance.done` as the post-loop route. The detailed shim inventory, warning-to-error policy, detection rules, and test sunset plan live in [Loop compatibility and sunset plan](loop-compatibility-sunset.md).

Existing persisted or UI-authored loadouts may still contain old-model routing scaffolding:

- `loops.<id>.exit` is legacy descriptive/materialization metadata. When it points to a socket target, the load/prepare compatibility boundary mirrors it into `loops.<id>.exits`; when it points to `end`, absence of a canonical route already means terminal fallback.
- Loop-member `advance.done` values are accepted as migration-only input. Socket-valued targets are mirrored into canonical `loops.<id>.exits` by `normalizeLegacyLoopRoutingCompatibilityInPlace`; terminal `end` remains a fallback sentinel and is not treated as a socket route.
- Back-edges inside loop regions are detected as old runtime scaffolding/normal same-item flow and are not inferred as post-loop exits.
- Existing `satisfied` and `not_satisfied` socket edges remain normal control-flow edges. UI descriptive graph metadata is preserved unless it is explicitly represented in `loops.<id>.exits`.

This compatibility boundary is non-destructive: it preserves legacy fields and UI metadata while adding canonical route metadata on cloned/normalized loadout values. Persisted user-authored loadouts are not destructively rewritten unless a save or future explicit migration path writes a prepared config.

A prepared config can be treated as new-model or normalized when socket-valued legacy `loop.exit.to` and loop-member `advance.done` routes have equivalent `loops.<id>.exits` entries, `advance.done: "end"` is understood only as terminal compatibility, and loop back-edges/descriptive UI runes are preserved without being inferred as exits. Unknown non-sentinel targets and incompatible parse/advance conflicts should remain errors; mirrorable legacy route fields can become warnings after a migration command or save rewrite exists, and errors after a documented warning release.

Do not add new domain, application, config, persistence, or WebUI APIs that accept loadout topology under any non-`sockets` field.

## Tool scope compatibility boundary

The canonical persisted granular tool scope is `{ "type": "custom", "tools": string[] }`. Persistence keeps those configured names portable: a saved custom allowlist may include built-in tools, extension tools, or tool names that are not registered in the current Pi session.

Validation rejects malformed scope shapes, unknown scope types, non-array `tools`, non-string entries, and blank tool names. Availability is a separate runtime concern. When a cast starts, pi-materia intersects a valid custom allowlist with the tools currently registered by Pi, enables only that active intersection, and reports unavailable configured names as warnings. Unavailable names are not removed from persisted config and do not widen access to a preset.

Older strict rejection of syntactically valid but unavailable custom tool names is migration-only compatibility for historical data paths. It is not the canonical save or runtime model for new configs.

## Loadout ownership and migrations

Loadout ownership, default immutability, lock/edit mode, duplicate-name collision handling, migration registry rules, and command-layer mutation guard expectations are documented in [Loadout ownership, locking, and migration](loadout-ownership-locking.md). Keep persistence compatibility changes aligned with that contract: stable loadout ids are canonical, display names are not ownership, shipped default names are preserved, and migration metadata is audit-only.
