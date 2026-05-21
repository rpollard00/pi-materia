# Quest board

The quest board is pi-materia's native outer-loop queue for project work. Instead of integrating directly with an external ticket system, `/materia quest` stores ordered work items locally and starts normal pi-materia casts for them. This keeps the first vertical slice loosely coupled: future adapters can import/export to external services, but the runner itself only depends on the board abstraction.

## Storage

The board is stored per project at:

```text
.pi/pi-materia/quest-board.json
```

It is intentionally outside timestamped cast artifact directories so future `/materia quest` commands can inspect and update one stable queue across casts and loadouts. Changing the active/default loadout does not move the board.

The file-backed repository creates `.pi/pi-materia/` and an empty board when the file is absent. Existing files are parsed and validated before use; malformed or schema-invalid JSON is reported with the file path and validation paths and is not overwritten implicitly.

Writes use a temporary file in the same directory followed by rename. This is atomic-enough for the initial vertical slice, but there is no inter-process lock: run only one Pi session that writes a project's quest board at a time. Concurrent sessions may race and the last rename may win.

## WebUI workflow

The WebUI **Quests** pane is another interface over this same project-local board, not a separate queue. Its quest log shows the active/running quest first, then pending quests in execution order; succeeded quests are grouped in a separate completed section, and failed or blocked quests are hidden from the default log.

Use the WebUI add form to append a pending quest with a prompt and optional loadout override. WebUI-added quests are saved to `.pi/pi-materia/quest-board.json`; they do not change active/default loadout preferences and do not by themselves enable, disable, or force-wake the runner. An enabled runner will pick them up on its next normal wake or after the current quest settles; otherwise use the CLI quest commands below when you are ready to launch queued work.

When a failed or blocked quest is selected in the WebUI, its detail view can requeue it back to pending. Like the CLI command, this is only valid for failed/blocked quests and preserves attempts plus historical result/error metadata.

Pending quests can also be reordered directly in the WebUI sidebar by dragging the `⋮⋮` handle next to a pending quest. The active/running quest remains pinned at the top and is not draggable; succeeded, failed, and blocked quests are not part of the pending order. Drop above the first pending quest to make the dragged quest the next pending item, or drop before/after another pending quest to place it relative to that target. The WebUI saves through the same reorder API as the CLI and reconciles from the canonical board response.

The single-writer limitation above still applies when using the WebUI: avoid writing the same project's quest board from multiple Pi sessions at once.

## Commands

```text
/materia quest
/materia quest status
/materia quest list [pending|all|succeeded|failed] [--limit <n>]
/materia quest default-loadout [<name-or-id>|--clear]
/materia quest add [--loadout <name-or-id>] <prompt>
/materia quest move <quest-id-or-prefix> --first|--before <target>|--onto <target>
/materia quest requeue <quest-id-or-prefix>
/materia quest unblock <quest-id-or-prefix>
/materia quest unfail <quest-id-or-prefix>
/materia quest run [quest-id]
/materia quest runonce [quest-id]
/materia quest start [quest-id]
/materia quest stop
```

- `quest` / `quest status` show runner state, the active quest if any, pending counts, recent results, the storage path, and short help.
- `quest list` shows quests from the board. With no filter it shows pending quests, ordered with the next scheduled quest first, and limits output to 10 quests. Use `pending`, `all`, `succeeded`, or `failed` to choose a filter, and `--limit <n>` to show a different positive number. `all` includes every stored status, including running and blocked quests; `failed` shows only failed quests.
- `quest default-loadout` shows the separate quest default loadout preference. `quest default-loadout <name-or-id>` sets it using normal exact loadout name/id resolution. `quest default-loadout --clear` stores an explicit cleared value; it does not change the active loadout or the regular cast default.
- `quest add` appends a pending quest. The first slice derives a concise title from the prompt.
- `quest move` reorders pending quests in the canonical board order. Use `--first` to make a pending quest the next pending item below any active/running quest, `--before <target>` to place it before another pending quest, or `--onto <target>` to place it after/onto another pending quest. Exactly one placement option is accepted, and source/target references must resolve to pending quests.
- `quest requeue <quest-id-or-prefix>` changes a failed or blocked quest back to `pending` so it can run again. It rejects pending, running, and succeeded quests, preserves attempts plus historical result/error metadata, and clears stale running-only state. `quest unblock` and `quest unfail` are discoverability aliases for the same requeue operation.
- `quest run` enables the project-local continuous runner and starts the requested quest, or the next pending quest. While enabled, the runner drains pending quests back-to-back until the queue is empty, an active cast is waiting, a launch fails, or `quest stop` is issued.
- `quest run` with no pending quest still enables the runner and reports that it is waiting; a later wakeup can start the next pending quest without another `run` command.
- `quest runonce` starts only the requested quest, or the next pending quest, and leaves the runner enabled/stopped flag unchanged. With no pending quest, it reports that no pending quest is available.
- `quest start` is a compatibility/legacy alias for `quest run`; it enables the same continuous runner behavior.
- `quest stop` disables future quest launches. It is graceful: it does not abort or interrupt the currently active cast, and the stop takes effect after that quest records completion or failure.

Quest commands that accept quest references accept full quest IDs and unambiguous ID prefixes. Exact matches win over prefix matches; ambiguous or missing prefixes fail without modifying the board and include matching IDs when useful.

Examples:

```text
/materia quest add Add tests for the parser
/materia quest default-loadout Full-Auto
/materia quest default-loadout --clear
/materia quest add --loadout Full-Auto Implement the CLI help
/materia quest list                # pending quests, next scheduled first, max 10 by default
/materia quest list all --limit 20 # show up to 20 quests of any stored status
/materia quest move abc123 --first # move a pending quest to the first pending position
/materia quest move abc123 --before def456 # move before another pending quest
/materia quest move abc123 --onto def456   # move after/onto another pending quest
/materia quest requeue abc123      # set a failed/blocked quest back to pending
/materia quest unblock abc123      # alias for requeue
/materia quest unfail abc123       # alias for requeue
/materia quest run                 # continuous runner; drains pending quests until stopped
/materia quest runonce             # launch one pending quest only
/materia quest start               # compatibility alias for continuous run
/materia quest stop                # stop after the current quest cast settles
```

## Quest default loadout and overrides

Quest launches use loadouts in this order:

1. a per-quest `--loadout <name-or-id>` override;
2. the persisted **quest default loadout** preference;
3. the current active loadout as a safe fallback.

The quest default is separate from the regular cast default loadout so interactive casts can keep a planning-oriented default while the quest runner stays autonomous. New profiles and migrated profiles that do not yet have `questDefaultLoadoutId` are initialized to the built-in `Full-Auto` stable id when that loadout is resolvable. Setting `/materia quest default-loadout --clear` stores `null` as an explicit cleared value; pi-materia preserves that clear and uses the active loadout fallback instead of repopulating `Full-Auto`.

`--loadout` remains per-cast and has highest precedence. pi-materia resolves the override using normal loadout name/id semantics before starting the quest cast, then creates an in-memory loaded config for that cast only. It does not call active-loadout, regular-default, or quest-default persistence and does not mutate project, user, or explicit config files. Quest result metadata records the requested/effective loadout when available.

The quest board file remains backward compatible: existing `.pi/pi-materia/quest-board.json` records do not need a quest default field, and the preference lives in the profile/config state rather than on each quest record.

## Autonomous loadouts

The runner can only progress autonomously through casts that can finish without mandatory user approval. Loadouts containing multi-turn materia that pause for `/materia continue` will still pause inside the active cast for materia/user interaction. Use a fully autonomous loadout for unattended quest queues.

## Completion, auto-advance, and restart behavior

Quest success is based on cast lifecycle status, not on handoff fields such as `satisfied`:

- completed casts mark quests `succeeded`;
- failed or aborted casts mark quests `failed`;
- stale running quests discovered on session start are conservatively marked `blocked`.

When the continuous runner is enabled and no cast/quest is active, pi-materia auto-starts the next pending quest after a quest-launched cast settles. The runner is event-driven and project-local: it wakes from quest commands and quest-cast settlement; it is not a daemon and it does not add inter-process locking beyond the single-writer board convention above. If no pending quest exists when `quest run` is issued, the runner remains enabled and waiting instead of stopping.

If `/materia quest stop` was run while a quest cast was active, that cast may still complete or fail and record its result, but no next quest starts. The current cast is not interrupted by `quest stop`.

On Pi session start, pi-materia reconciles stale running quests and warns the user instead of spawning surprise work. Check `/materia quest status` and explicitly run the runner again when ready; `quest start` is still accepted as a compatibility alias for `quest run`.

## Verification

The quest board behavior is covered by focused unit and command tests. Run:

```text
npm run typecheck
npm run test
npm run test:webui
```
