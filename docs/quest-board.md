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

## Commands

```text
/materia quest
/materia quest status
/materia quest add [--loadout <name-or-id>] <prompt>
/materia quest run [quest-id]
/materia quest start [quest-id]
/materia quest stop
```

- `quest` / `quest status` show runner state, the active quest if any, pending counts, recent results, the storage path, and short help.
- `quest add` appends a pending quest. The first slice derives a concise title from the prompt.
- `quest run` starts the requested quest, or the next pending quest, once. It does **not** enable future auto-advance.
- `quest start` enables the runner and starts the requested quest, or the next pending quest. When that quest completes, the runner starts the next pending quest while it remains enabled.
- `quest stop` disables future auto-advance. It does not abort the currently active cast; use `/materia abort` if you want to stop that cast.

Examples:

```text
/materia quest add Add tests for the parser
/materia quest add --loadout Full-Auto Implement the CLI help
/materia quest run
/materia quest start
/materia quest stop
```

## Loadout overrides

`--loadout` is per-cast. pi-materia resolves the override using normal loadout name/id semantics before starting the quest cast, then creates an in-memory loaded config for that cast only. It does not call active-loadout persistence and does not mutate project, user, or explicit config files. Quest result metadata records the requested/effective loadout when available.

## Autonomous loadouts

The runner can only progress autonomously through casts that can finish without mandatory user approval. Loadouts containing multi-turn materia that pause for `/materia continue` will still pause. Use a fully autonomous loadout for unattended quest queues.

## Completion, auto-advance, and restart behavior

Quest success is based on cast lifecycle status, not on handoff fields such as `satisfied`:

- completed casts mark quests `succeeded`;
- failed or aborted casts mark quests `failed`;
- stale running quests discovered on session start are conservatively marked `blocked`.

When the runner is enabled and no cast/quest is active, pi-materia auto-starts the next pending quest after a quest-launched cast settles. If `/materia quest stop` was run while a quest cast was active, that cast may still complete and record its result, but no next quest starts.

On Pi session start, pi-materia reconciles stale running quests and warns the user instead of spawning surprise work. Check `/materia quest status` and explicitly run or start the runner again when ready.

## Verification

The quest board behavior is covered by focused unit and command tests. Run:

```text
npm run typecheck
npm run test
```
