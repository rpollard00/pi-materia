# Loadout ownership and locking

This document records the user-facing loadout behavior and the developer guardrails that keep shipped defaults immutable. Keep it aligned with `src/domain/loadout.ts`, `src/loadout/loadoutNames.ts`, and the WebUI loadout draft/mutation controllers.

## User-facing behavior

### Shipped defaults are immutable

Bundled default loadouts are owned by the `default` source and are read-only by policy. They cannot be unlocked through normal user actions, and saving a default must never create a hidden user-profile shadow copy.

To change a shipped default, the user must use **Duplicate** first. Duplicating a default creates a user-owned loadout with:

- a new stable `id`,
- a unique display name generated with the shared duplicate-name helper,
- copied graph content,
- `source: "user"`,
- `lockState: "unlocked"`, and
- `originDefaultId` when the source default has a stable id.

After duplication, the duplicate is the editable loadout. The default remains visible and unchanged.

### User lock/edit mode

User, project, and explicit/imported loadouts may be editable when their policy allows it. User-owned loadouts persist `lockState` as the user's edit-mode toggle:

- `lockState: "unlocked"` means graph mutations are allowed.
- `lockState: "locked"` means the loadout is usable for inspection/monitoring but graph mutations are blocked until unlocked.

Locked/read-only mode must still allow safe non-mutating interactions such as selection, inspection, panning/zooming, copying details, searching, and active-socket monitoring. It must not enable dragging sockets or materia, changing edges, deleting nodes, renaming mutable graph elements, or other persisted graph mutations.

### Deleting user copies of defaults

Deleting a user-created duplicate or local copy of a default deletes only that user-owned loadout. It must not delete, hide, or mutate the shipped default.

If the deleted loadout is active and has `originDefaultId`, the active loadout falls back to the shipped default with the matching stable id when that default is present. If no matching default is available, the draft behavior falls back to another remaining loadout. The UI should make the resulting active loadout clear to the user rather than recreating a deleted local copy.

## Identity and ownership model

Stable loadout ids are canonical identity. Display names are labels and stability hints only; they must not be used to infer ownership or to decide whether a loadout is a shipped default.

Current source values are:

- `default` for bundled shipped defaults,
- `user` for profile-owned loadouts,
- `project` for target-project loadouts, and
- `explicit` for explicitly loaded/imported configuration where applicable.

Default display names are preserved. When another scope collides with a default name, save/import paths must rename the non-default loadout rather than renaming the shipped default. `originDefaultId` is optional provenance for duplicates and fallback behavior; it is not a replacement for stable ids.

## Duplicate-name and save/import guardrails

Use `makeDuplicateLoadoutName` from `src/loadout/loadoutNames.ts` anywhere a loadout duplicate or collision rename is created. This includes duplicate-from-default, duplicate user loadout, and import collision paths.

Before persistence, save/import paths must reject or rename duplicate-name ownership across scopes. Do not allow the same display name to be owned by more than one scope unless a future namespaced UI explicitly supports that distinction.

## Edit policy and mutation guards

Use `getLoadoutEditPolicy(loadout)` from `src/domain/loadout.ts` as the single policy helper for `canEdit`, `readonly`, policy/user lock state, reason codes, and user-facing blocked-edit reasons.

UI disabled states are not sufficient enforcement. Route graph edits, keyboard shortcuts, context menus, toolbar actions, autosave side effects, and programmatic save/delete/mutation commands through command-layer guards that check the same edit policy. In the WebUI, guarded update boundaries such as `updateLoadoutDraft`, `updateLoadoutLayout`, and `useLoadoutGraphMutationController` should remain the enforcement points for persisted graph mutations.

Monitoring visuals, including the active-socket indicator, are transient presentation state. Do not persist session activity into loadout graph data and do not couple monitoring indicators to editability.

## Relevant commands

Useful checks for this area:

```bash
npm run typecheck
npm run test:webui -- webui/features/loadout/LoadoutListPanel.vitest.tsx webui/features/loadout/LoadoutGraphPanel.vitest.tsx webui/features/loadout/loadoutDraft.vitest.ts
bun test tests/domainModel.test.ts tests/loadoutAccessors.test.ts
```

Use the targeted commands above while changing loadout ownership, locking, or WebUI mutation behavior; run the broader suite with `npm test` when changing shared domain/config code.
