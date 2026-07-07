# Investigation: Elena Socket-3 Auto-Plana → Interactive-Plani Materia Resolution Divergence

## Summary

Socket-3 was configured (in the user "Elena" loadout) to bind `Auto-Plana` but the resolved materia at cast time was `Interactive-Plani` (which is `multiTurn: true` and therefore uncompletable by the autonomous agent-controller).

## Root Cause

**The divergence occurred at the loadout authoring level, not in the resolution pipeline.** The Elena loadout's Socket-3 `materia` field was set to `"Interactive-Plani"` instead of `"Auto-Plana"`. The resolution pipeline correctly reads and resolves whatever `materia` string the loadout socket references — there is no bug in the resolution code itself.

## Resolution Path (Verified End-to-End)

The materia resolution path has these steps, all of which were verified correct:

1. **Config loading** (`src/config/config.ts::loadConfig`): Loads 4 layers (default < central < user < project < explicit). The controller's explicit config sets `activeLoadout: "Elena"` but defines no loadouts — loadout definitions come from the user layer.

2. **Active loadout selection** (`src/runtime/pipeline.ts::getEffectivePipelineConfig`): Selects `config.loadouts[config.activeLoadout]`. The explicit layer's `activeLoadout` wins by merge precedence.

3. **Socket resolution** (`src/runtime/pipeline.ts::resolveSocket`): 
   ```typescript
   const socket = getLoadoutSocket(effective.pipeline, id);
   const materia = config.materia[socket.materia];
   ```
   The socket's `materia` field is a string reference (e.g., `"Auto-Plana"`). This is looked up directly in `config.materia`.

4. **Socket detail extraction** (`src/runtime/nativeLifecycle.ts::buildPipelineSocketDetails`):
   ```typescript
   materiaName: resolvedMateriaDisplayName(socket) ?? socketId
   ```
   Where `resolvedMateriaDisplayName` → `resolvedMateriaLabel ?? resolvedMateriaId`, and for agent sockets `resolvedMateriaId` returns `socket.socket.materia` (the loadout socket's `materia` string).

**The `cast_start` event's `socketDetails[].materiaName` directly reflects the loadout socket's `materia` field.** If it shows `"Interactive-Plani"`, the loadout socket's `materia` field is `"Interactive-Plani"`.

## Contributing Factor: Loadout Copy Artifacts

The `"user:rude-copy:850e5b94"` naming artifact indicates a user-initiated loadout copy operation. The default shipped loadouts have different Socket-3 bindings:

| Loadout | Socket-3 Materia | multiTurn |
|---------|-----------------|-----------|
| `Full-Auto` | `Auto-Plan` | false (single-turn) |
| `Planning-Consult` | `Interactive-Plan` | true (multi-turn) |
| `Hojo-Consult` | `Interactive-Plan` | true (multi-turn) |

If the Elena loadout was created by copying a `Planning-Consult`-derived loadout (which uses `Interactive-Plan` / `Interactive-Plani` for Socket-3), the Socket-3 `materia` field would carry over the `Interactive-Plani` reference instead of being updated to `Auto-Plana`.

## Why This Matters for Agent-Controller

The `Interactive-Plani` materia has `multiTurn: true`. Under the `agent-controller` eventing preset, multiTurn agent sockets can never complete because the controller never sends `/materia continue`. This is now caught by the fail-fast guard (work item: "fail-fast on multiTurn agent sockets under agent-controller eventing").

## Recommendations

1. **User-side fix**: Update the Elena loadout's Socket-3 `materia` field from `"Interactive-Plani"` to `"Auto-Plana"`.

2. **Tooling improvement** (follow-up work item): When duplicating/copying a loadout, warn if any socket references a `multiTurn: true` agent materia and the target use-case is autonomous (agent-controller). This prevents the misconfiguration at copy time.

3. **Validation improvement** (follow-up work item): Add a pre-cast validation that cross-references the `activeLoadout`'s socket materia bindings against the intended autonomous-compatible materia set, surfacing a clear diagnostic before the cast starts.

## Evidence

- `src/runtime/pipeline.ts::resolveSocket` — materia lookup is a direct string key lookup, no transformation
- `src/runtime/resolvedMateria.ts::resolvedMateriaId` — returns `socket.socket.materia` for agent sockets
- `src/runtime/nativeLifecycle.ts::buildPipelineSocketDetails` — `materiaName` comes from `resolvedMateriaDisplayName` which uses `socket.socket.materia`
- `config/default.json` — shipped loadouts show `Auto-Plan` vs `Interactive-Plan` distinction on Socket-3
