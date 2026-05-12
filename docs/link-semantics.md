# `/materia link` semantics

`/materia link` is the v1 command contract for chaining materia and/or loadouts into a single immediate cast. It composes execution graphs through an ephemeral virtual loadout; it is not prompt concatenation, and it does not save or switch the active loadout.

## Command grammar

```text
/materia link [--from <castId>] <target> [<target> ...] -- <prompt>
```

- `--from <castId>` is optional. When present, the new cast records lineage to a previous cast and exposes bounded previous-cast context as structured state for materia/loadouts that opt in to consume it.
- `<target>` is one materia or one loadout reference. At least one target is required.
- `--` is required and separates the target list from the user prompt.
- `<prompt>` is required and is passed as the prompt for the linked cast.

## Target references and resolution

Targets are resolved in the order supplied. Each target may use an explicit namespace prefix:

- `materia:<name>` resolves only a top-level materia.
- `loadout:<name>` resolves only a named loadout.
- `<name>` without a prefix is accepted only when it resolves unambiguously to exactly one materia or exactly one loadout.

If an unprefixed target name matches both a materia and a loadout, the command fails before starting a cast and asks the user to choose an explicit prefix, for example `materia:Build` or `loadout:Build`. Missing targets and unknown prefixed targets also fail before a cast starts.

`Chain-Context` is not a parser keyword. It resolves like any other materia. Include it only when you want an ordinary materia to transform structured previous-cast state into concise downstream context.

## Examples

Materia to materia:

```text
/materia link Planner Build -- Add a small settings page.
```

Loadout to loadout:

```text
/materia link loadout:Planning-Consult loadout:Full-Auto -- Design and implement the next feature.
```

Mixed materia and loadout chain:

```text
/materia link materia:Context-Check loadout:Planning-Consult Build -- Audit the request, plan, then implement.
```

Previous-cast continuation with explicit context transformation:

```text
/materia link --from <castId> Chain-Context Hojo-Consult -- Continue from the previous cast and refine the design.
```

Previous-cast continuation without `Chain-Context`:

```text
/materia link --from <castId> loadout:Full-Auto -- Continue the implementation.
```

The second form still records lineage and exposes previous-cast state, but no previous context is injected into every prompt automatically. Downstream materia/loadouts must explicitly consume that state.

## Immediate-run behavior

After successful parsing, resolution, previous-cast validation, and graph compilation, `/materia link` starts one cast immediately using the compiled virtual loadout. If any validation or compilation step fails, no partial linked cast is started.

The command does not mutate the active loadout, default loadout, or saved loadout configuration. Future `/materia cast` runs continue to use the active loadout selected by normal `/materia loadout` behavior.

## Ephemeral virtual loadout behavior

A linked sequence is compiled into an ephemeral virtual loadout for that one cast:

- individual materia targets are wrapped as executable graph fragments;
- loadout targets keep their internal graph, routing, evaluators, socket adapters, parse/assign behavior, and loop semantics;
- node and socket identities are remapped deterministically so fragments do not collide;
- metadata sufficient to inspect the linked run is recorded with the cast, including the command invocation, resolved target sequence, virtual loadout id/name, and optional `fromCastId`.

The virtual loadout is runtime input and cast metadata, not a persisted named loadout. v1 has no flag that saves linked chains as reusable loadouts.

## Socket remapping and terminal stitching

When adjacent targets are composed, pi-materia stitches terminal outputs from the earlier target to entry inputs of the later target.

In v1, implicit stitching is allowed only when there is exactly one compatible terminal output and exactly one compatible entry input between the adjacent targets. If there are zero compatible pairs or multiple possible pairs, the command fails before starting a cast. The diagnostic should name the relevant terminal/entry sockets where possible and indicate that explicit socket mapping is future work rather than guessing.

This rule protects users from silent misrouting. `/materia link` does not guess between multiple terminal sockets, multiple entry sockets, or incompatible socket shapes.

## Previous-cast context

`--from <castId>` validates that the referenced cast exists before a new cast starts. When valid, the new cast records lineage and makes bounded prior-cast information available as structured state. That state may include canonical handoff JSON, text artifacts, prior request/summary data, decisions, risks, `workItems`, `satisfied`, `feedback`, and `missing` when available.

Previous-cast context is not automatically prepended to every prompt. Context transformation belongs to ordinary materia or loadouts that opt in. The stock `Chain-Context` materia is intended to summarize previous-cast state for downstream targets, but `/materia link --from` does not require it.

If `Chain-Context` is used without available previous-cast context, it should fail or degrade with a clear diagnostic rather than inventing lineage.

## User-visible error cases

- **Missing target sequence**: `/materia link -- <prompt>` fails because at least one materia or loadout target is required.
- **Missing prompt delimiter**: `/materia link Build implement this` fails because `--` is required between targets and prompt text.
- **Missing prompt text**: `/materia link Build --` fails because prompt text after `--` is required.
- **Ambiguous target name**: `/materia link Build -- <prompt>` fails when both a materia and a loadout named `Build` exist; use `materia:Build` or `loadout:Build`.
- **Unknown target**: prefixed or unprefixed targets that cannot be found fail before cast creation.
- **Missing previous cast id**: `/materia link --from <missingCastId> Build -- <prompt>` fails before cast creation and reports that the referenced cast could not be found.
- **Ambiguous terminal stitching**: adjacent targets with multiple compatible terminal/entry socket pairs fail before cast creation; v1 does not guess.
- **Invalid composed graph**: unsupported cycles, invalid socket shapes, or remapping conflicts introduced by composition fail before cast creation.

## v1 non-goals

The v1 contract intentionally does not include:

- persisting linked chains as named loadouts;
- guessing ambiguous terminal-to-entry socket mappings;
- requiring `Chain-Context` for all previous-cast continuations;
- adding a `/materia chaincast` alias;
- implementing explicit socket mapping syntax before the base composition model is stable;
- dry-run/planning commands for link graphs.

Future work may add explicit socket mapping syntax, saved linked loadouts, dry-run planning, optional implicit-end policies, or a deliberate alias, but those are not available in v1.
