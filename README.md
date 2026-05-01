# pi-materia

pi-materia is a [Pi](https://pi.dev) extension for configurable, materia-themed agent workflows. A Materia Grid is a data-driven graph: each slot renders a prompt, exposes a configured tool scope, optionally parses output, assigns state, and follows configured links.

The bundled default loadout is a software-development workflow, but the engine itself is generic. You can replace the grid with a single slot that says `HELLO WORLD`, or with any arbitrary sequence/loop of role turns.

## Current status

pi-materia is early and intentionally small. The native runtime drives the active Pi session, so role turns render with Pi's normal assistant/tool UI instead of hidden subagents. Casts persist state in the session, isolate model context per role, write structured artifacts, stream a live status widget, track Pi-native usage where available, and expose `/materia grid`.

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

## Development

This package keeps npm compatibility (`package-lock.json` is retained). Install dependencies with npm, and install [Bun](https://bun.sh) to run the local test suite:

```bash
npm run typecheck
npm test        # equivalent to: bun test
bun test --watch
```

Tests use a fake Pi harness and do not require provider/API access or a real Pi session.

## Usage

```text
/materia grid
/materia cast implement the next small feature
/materia casts
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

Minimal hello-world grid:

```json
{
  "artifactDir": ".pi/pi-materia",
  "pipeline": {
    "entry": "hello",
    "nodes": {
      "hello": {
        "type": "agent",
        "role": "echoer",
        "prompt": "Say exactly: HELLO WORLD",
        "next": "end"
      }
    }
  },
  "roles": {
    "echoer": {
      "tools": "none",
      "systemPrompt": "Follow the prompt exactly."
    }
  }
}
```

Generic node mechanics:

- `prompt`: template rendered for an agent role turn
- `parse`: `"text"` or `"json"`
- `assign`: copy parsed output/state values into generic cast state
- `edges`: condition-driven links, e.g. `$.passed == true`
- `next`: fallback link when no edge matches
- `foreach`: iterate a node over an array in state
- `advance`: advance a configured cursor
- `limits`: node/edge cycle safety

For deterministic local steps that should run without an LLM turn, see [Utility Materia](docs/utility-materia.md).

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
  nodes/<node-id>/<visit>.md
  nodes/<node-id>/<visit>.json
  contexts/<node-id>-<visit>.md
```

## Default loadout

The bundled default loadout lives at `config/default.json`. It defines its software-development workflow entirely as config using generic prompts, JSON parsing, state assignment, conditional edges, foreach cursors, and checkpoint roles.
