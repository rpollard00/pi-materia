# pi-materia

pi-materia is a [Pi](https://pi.dev) extension for configurable, materia-themed agent pipelines.

The current default pipeline is:

```text
planner -> builder -> evaluator
                      | passed -> maintainer
                      | failed  -> builder
```

The planner breaks a high-level request into tasks, the builder implements each task, the evaluator checks the result, and the maintainer can create a VCS checkpoint when the work is accepted.

## Current status

pi-materia is early and intentionally small. The current runtime supports the default sequential grid shape above, with configurable roles and prompts. The bundled default loadout uses a `jj` maintainer role by default.

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

Start a cast with:

```text
/materia run implement the next small feature
```

pi-materia will report the config source, artifact directory, and resolved grid at the start of the run.

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

## Default loadout

The bundled default loadout lives at `config/default.json`. It includes:

- `planner`
- `builder`
- `evaluator`
- `jjMaintainer`
- `gitMaintainer`

The default pipeline currently uses `jjMaintainer`. To use Git instead, copy `config/default.json` to your target project as `.pi/pi-materia.json` and change the maintainer slot role from `jjMaintainer` to `gitMaintainer`.
