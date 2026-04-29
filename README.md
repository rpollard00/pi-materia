# pi-materia

pi-materia is a [Pi](https://pi.dev) extension for configurable, materia-themed agent pipelines.

The current default Materia Grid is:

```text
planner -> builder -> evaluator
                      | passed -> maintainer
                      | failed  -> builder
```

The planner breaks a high-level request into tasks, the builder implements each task, the evaluator checks the result, and the maintainer can create a VCS checkpoint when the work is accepted. Materia now drives the normal Pi session as a state machine, so role turns render with Pi's native assistant/tool UI instead of hidden subagents.

## Current status

pi-materia is early and intentionally small. The current runtime supports the default sequential grid shape above, with configurable roles and prompts. The bundled default loadout uses a `jj` maintainer role by default.

Phase 3 native orchestration is the default runtime: casts persist state in the active Pi session, advance automatically after each Pi agent turn, isolate model context per Materia role, write structured artifacts, stream a live status widget, track Pi-native usage where available, and expose `/materia grid`.

## Install or run

Install from npm once published:

```bash
pi install npm:@rpollard00/pi-materia
```

For local development, run the extension directly from this repo while working in a target project:

```bash
cd /path/to/target-project
pi -e /path/to/pi-materia/src/index.ts
```

## Usage

Inspect the loaded grid/config:

```text
/materia grid
```

Start a cast:

```text
/materia cast implement the next small feature
```

List recent casts:

```text
/materia casts
```

Inspect or control an active cast:

```text
/materia status
/materia continue
/materia abort
```

pi-materia reports the config source, artifact directory, resolved grid, live status, and end-of-run token/cost totals when available. The visible transcript stays native, but full role prompts are hidden behind compact Materia cast messages, and each role turn receives a curated Materia context instead of the full previous conversation.

## Configuration

pi-materia resolves its loadout/config in this order:

1. `--materia-config /path/to/config.json`
2. `MATERIA_CONFIG=/path/to/config.json`
3. target project `.pi/pi-materia.json`
4. bundled default loadout at `config/default.json`

Example:

```bash
pi -e /path/to/pi-materia/src/index.ts --materia-config ./my-loadout.json
```

Runtime artifacts are written to `.pi/pi-materia/<timestamp>/` by default. Override with:

```json
{
  "artifactDir": ".pi/my-materia-runs"
}
```

Budget limits can be configured:

```json
{
  "budget": {
    "maxTokens": 200000,
    "maxCostUsd": 5,
    "warnAtPercent": 75,
    "stopAtLimit": true
  }
}
```

## Artifacts

Each cast writes enough information to debug the run after the fact:

```text
.pi/pi-materia/<cast-id>/
  config.resolved.json
  events.jsonl
  usage.json
  manifest.json
  plan.json
  tasks/<task-id>/build-<attempt>.md
  tasks/<task-id>/eval-<attempt>.json
  maintenance/final.md
  contexts/planner.md
  contexts/builder-<task-id>-attempt-<n>.md
  contexts/evaluator-<task-id>-attempt-<n>.md
  contexts/maintainer.md
```

## Default loadout

The bundled default loadout lives at `config/default.json`. It includes:

- `planner`
- `builder`
- `evaluator`
- `jjMaintainer`
- `gitMaintainer`

The default pipeline currently uses `jjMaintainer`. To use Git instead, copy `config/default.json` to your target project as `.pi/pi-materia.json` and change the maintainer slot role from `jjMaintainer` to `gitMaintainer`.
