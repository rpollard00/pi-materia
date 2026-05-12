# `/materia link` data model and boundaries

This document records the internal seam for `/materia link` before parser, graph composition, and runtime launch are wired together. The typed source of truth is `src/link/types.ts`.

## Module boundaries

- `src/link/parser.ts`: tokenizes and validates `/materia link [--from <castId>] <target> [<target> ...] -- <prompt>` only.
- `src/link/resolver.ts`: resolves ordered `LinkTargetRef` values to materia/loadout identities without mutating active/default loadout state.
- `src/link/planner.ts`: creates serializable `LinkPlan` and `LinkLineage` metadata from parser/resolver output.
- `src/link/compiler.ts`: expands targets into an ephemeral `VirtualLoadoutSpec`, remaps socket ids, and records deterministic stitching metadata.
- `src/link/contextLoader.ts`: validates and loads bounded previous-cast state for `--from` as transient runtime context.
- `src/link/commandAdapter.ts`: thin orchestration boundary that will call the modules above and then launch the normal cast runtime.

## Persisted metadata

The following fields are designed to be safe to write to cast artifacts/state:

- `LinkCommandInvocation`: command name, normalized arguments, and optional raw command text.
- `LinkTargetRef`: target order, original requested text, parsed prefix, and parsed name.
- `ResolvedLinkTarget`: target order, requested target ref, resolved kind, resolved id, and optional display name.
- `LinkPlan`: schema version, invocation, prompt, optional `fromCastId`, ordered targets, and lineage.
- `LinkLineage`: optional previous cast id, linked cast id when known, target sequence, invocation, and virtual loadout metadata.
- `VirtualLoadoutMetadata`: virtual id/name, version, target sequence, socket remappings, and stitching decisions.
- `LinkCastStateData`: persisted cast-state envelope under `data.link` containing the plan and virtual loadout metadata.

`VirtualLoadoutMetadata` is intentionally independent from persisted loadout configuration. v1 records enough to inspect a linked cast but does not save the virtual loadout as a named, active, or default loadout.

## Transient runtime-only data

The following values are runtime inputs and should not be persisted wholesale:

- `VirtualLoadoutSpec.loadout`: expanded executable graph object for one cast.
- `PreviousCastContext`: bounded previous-cast request/handoff/artifact previews loaded for opt-in materia/loadouts.
- `PreviousCastArtifactSummary.content`: bounded preview text; retain truncation metadata rather than storing unbounded artifact contents.
- Registry/loadout lookup handles and any other resolver/compiler implementation handles.

Previous-cast context is structured state. It is not automatically prepended to every prompt, and it is not coupled to `Chain-Context`.
