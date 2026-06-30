# pi-materia

**Configurable, composable agent workflows for [Pi](https://pi.dev).**  
pi-materia gives you reusable AI agent pipelines — plan, build, evaluate, and iterate — driven by JSON config instead of code. Chain materia (agent roles) together into loadouts (workflow graphs), run them from the chat bar, and watch them execute in Pi's native interface.

<!--
  🎬 MEDIA RESERVED — screen-recorded UI demo
  Replace the placeholder below with an embedded or linked demo video when ready.
  Suggested: a 30-60 second clip showing `/materia cast`, the live status widget,
  and a WebUI loadout editor.
-->
<!--
  🖼️ SCREENSHOT GALLERY RESERVED
  Add 2-4 representative screenshots below (WebUI loadout editor, live status,
  quest board, grid view). Keep them light/dark-theme neutral where possible.
  Example markdown: ![Loadout editor](docs/assets/loadout-editor.png)
-->

## What it does

- **Turn prompts into multi-step pipelines.** A single `/materia cast "add dark mode"` runs through planning → implementation → evaluation → checkpointing automatically.
- **Keep the human in the loop when you want.** Use interactive planning loadouts to refine scope before the agents start coding.
- **Edit workflows visually.** The WebUI (`/materia ui`) gives you a drag-and-drop graph editor for loadouts, a materia role editor, and a quest board.
- **Queue up project work.** `/materia quest` maintains a local ordered task board so you can batch work and let materias chew through it.
- **Stay in Pi's native UI.** Materia turns render as normal assistant/tool messages — no hidden subagents, no second window required.

## Install

pi-materia is a Pi extension distributed as an npm package.

```bash
pi install npm:@rpollard00/pi-materia
```

For local development (run from a checkout while working in another project):

```bash
cd /path/to/your-project
pi -e /path/to/pi-materia/src/index.ts
```

## Quick start

After installing, open any project in Pi and try these commands:

```bash
# See the current workflow graph
/materia grid

# List available loadouts and switch between them
/materia loadout
/materia loadout Planning-Consult

# Run a cast with the active loadout
/materia cast add a dark mode toggle to settings

# Open the visual editor
/materia ui
```

That's it. `/materia grid` shows you the resolved pipeline. `/materia cast <task>` runs it. The WebUI opens a local editor where you can inspect, duplicate, and customize loadouts and materia roles.

### Your first cast in 30 seconds

1. `pi install npm:@rpollard00/pi-materia` — install the extension
2. `/materia cast write a hello world script` — start a cast
3. Watch the status widget as the pipeline advances through planning, building, and evaluation
4. `/materia ui` — open the WebUI to see the loadout graph and live status

## Core concepts

A **materia** is a reusable agent role: it has a prompt, a set of available tools (read-only, coding, custom allowlists), and optional model/thinking settings.

A **loadout** is a directed graph of sockets, each assigned to a materia. Sockets define how output is parsed, where results are assigned in shared state, and which socket runs next. Loadouts can branch, loop, and include deterministic utility sockets for setup steps.

A **cast** is one execution of a loadout graph from its entry socket. Each socket turn generates artifacts under `.pi/pi-materia/<cast-id>/`.

### Default loadouts

pi-materia ships with three loadouts ready to use:

| Loadout | What it does |
|---|---|
| **Full-Auto** | Fully autonomous: plan → build → evaluate → maintain → repeat. No user interaction needed. |
| **Planning-Consult** | Interactive planning first. You refine the plan with natural-language replies, then run `/materia continue` to hand off to automated implementation. |
| **Hojo-Consult** | Combines interactive planning with architecture guidance before entering the build/eval loop. |

Run `/materia loadout <name>` to switch. The bundled defaults are read-only; use the WebUI to duplicate and customize them.

## Common next steps

### Chain materia together on the fly

`/materia link` composes materia and/or loadouts into an ephemeral pipeline without editing config:

```bash
/materia link Planner Build -- Add a small settings page
/materia link loadout:Planning-Consult loadout:Full-Auto -- Plan and implement the next feature
/materia link --from <previous-cast-id> Chain-Context Build -- Continue the prior cast
```

See [link semantics](docs/link-semantics.md) for the full command contract, ambiguity rules, and detailed examples.

### Automate batches of work

The quest board (`/materia quest`) queues up project tasks and runs them back-to-back:

```bash
/materia quest add Add user registration page
/materia quest add --loadout Planning-Consult Refactor the auth module
/materia quest list
/materia quest run          # process all pending quests continuously
/materia quest runonce      # process exactly one pending quest
/materia quest stop         # stop after the current cast finishes
```

Quest state lives in `.pi/pi-materia/quest-board.json`. See [Quest board](docs/quest-board.md) for storage, autonomy, and restart behavior.

### External controllers (agent_router)

When an external controller (such as [agent_router](https://github.com/rpollard00/agent_router)) launches pi-materia autonomously, it sets `CONTROLLER_RUN_ID`, `CONTROLLER_EVENT_URL`, and `CONTROLLER_CONTEXT_DIR`. pi-materia detects the launch and auto-enables the `agent-controller` eventing preset so lifecycle and result events are POSTed back to the controller. A launcher can override the top-level switches with the `PI_MATERIA_EVENTING_*` env vars (e.g. `PI_MATERIA_EVENTING_ENABLED=false` to opt out). See [Runtime Eventing](docs/runtime-eventing.md) for the full env contract, activation diagnostics, and webhook troubleshooting.

### Use the WebUI

`/materia ui` opens a local browser-based editor for:

- **Loadout editor** — drag-and-drop graph editing, loop creation, socket configuration
- **Materia editor** — craft role prompts, assign tool scopes, set per-materia models
- **Quest pane** — inspect the queue, reorder with drag handles, requeue failed quests
- **Live status** — see the current cast position in the graph

The WebUI starts automatically with `/materia cast`, `/materia link`, `/materia recast`, and `/materia revive`. Enable browser auto-open in `~/.config/pi/pi-materia/config.json`:

```json
{ "webui": { "autoOpenBrowser": true } }
```

### Resume and recover

```bash
/materia recast          # resume the most recent failed/aborted cast
/materia recast <id>     # resume a specific cast
/materia revive <id>     # extend the exhausted allowance for same-socket recovery or edge traversal, then recast
/materia casts           # list past casts
/materia status          # show the current cast state
/materia abort           # stop the active cast
```

pi-materia automatically retries safe failures (context-window limits, tool timeouts, and safe generic turn failures) within the same socket before requiring manual intervention. Transient transport errors (WebSocket connection drops, `Stream ended without finish_reason`, and similar provider-stream interruptions) are recorded as warnings but do NOT force cast failure — the cast stays active and the next turn proceeds normally without a `cast_end ok:false` or failed manifest entries.

### Customize your pipelines

Loadout and materia configuration is layered JSON (defaults → user profile → project file → env/cli overrides). Full customization details live in the docs:

- [Handoff contract](docs/handoff-contract.md) — the JSON contract agent sockets use to pass work items between materia
- [Graph semantics](docs/graph-semantics.md) — edge conditions, branching, loops, and structured iteration
- [Loop semantics](docs/loop-semantics.md) — generator-driven loop configuration and exit routing
- [Utility materia](docs/utility-materia.md) — deterministic pre/post-processing sockets (no LLM turn)
- [Loadout ownership & locking](docs/loadout-ownership-locking.md) — how defaults, duplicates, and locking work

Minimal hello-world config to get started writing your own:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Hello",
  "loadouts": {
    "Hello": {
      "entry": "hello",
      "sockets": {
        "hello": { "materia": "echoer", "edges": [{ "when": "always", "to": "end" }] }
      }
    }
  },
  "materia": {
    "echoer": { "tools": "none", "prompt": "Say exactly: HELLO WORLD" }
  }
}
```

Save this as `.pi/pi-materia.json` in your project, or pass it with `--materia-config`.

## Reference

### All commands

| Command | Description |
|---|---|
| `/materia cast <task>` | Run a cast with the active loadout |
| `/materia autocast <loadout\|materia:name> <prompt>` | Run a cast with a temporary loadout or single-materia virtual loadout |
| `/materia link [--from <id>] <target> ... -- <prompt>` | Chain materia/loadouts into an ephemeral pipeline |
| `/materia grid` | Show the resolved pipeline graph |
| `/materia loadout [name]` | List or switch active loadouts |
| `/materia ui` | Open the WebUI editor |
| `/materia quest status` | Show quest board status |
| `/materia quest add [--loadout <name>] <prompt>` | Append a pending quest |
| `/materia quest list [pending\|all\|succeeded\|failed]` | List quests |
| `/materia quest run [id]` | Process quests continuously |
| `/materia quest runonce [id]` | Process exactly one quest |
| `/materia quest stop` | Stop the quest runner |
| `/materia quest move <id> --first\|--before\|--onto <target>` | Reorder pending quests |
| `/materia quest requeue <id>` | Return a failed/blocked quest to the queue |
| `/materia quest default-loadout [name\|--clear]` | Set or clear the quest default loadout |
| `/materia recast [id]` | Resume a failed/aborted cast |
| `/materia revive [id]` | Extend allowance for a same-socket or edge-traversal exhausted cast |
| `/materia casts` | List past casts |
| `/materia status` | Show active cast state |
| `/materia continue` | Finalize a paused multi-turn planning socket |
| `/materia abort` | Stop the active cast |

### Configuration layering

Config is merged from lowest to highest precedence:

1. Bundled defaults (`config/default.json`)
2. User profile (`~/.config/pi/pi-materia/materia.json`)
3. Project file (`.pi/pi-materia.json`)
4. `MATERIA_CONFIG` environment variable
5. `--materia-config` CLI flag

### Artifacts

Each cast writes a timestamped directory:

```
.pi/pi-materia/<cast-id>/
  config.resolved.json
  events.jsonl
  usage.json              # token/cost totals
  manifest.json
  sockets/<socket-id>/<visit>.md
  sockets/<socket-id>/<visit>.json
  contexts/<socket-id>-<visit>.md
```

## Development

Install dependencies with npm. Use [Bun](https://bun.sh) for the test suite:

```bash
npm install
npm run typecheck
npm test                 # bun test
npm run test:webui       # Vitest client tests
```

The WebUI lives under `src/webui/` (Vite + React + Tailwind client, TypeScript Node server):

```bash
npm run dev:webui          # Vite dev server
npm run dev:webui:server   # Node server in watch mode
npm run build:webui        # Production build
```

WebUI development notes for future work: [WebUI integration notes](docs/webui-integration-notes.md). Manual smoke test coverage: [WebUI smoke tests](docs/webui-smoke-tests.md).

## License

MIT
