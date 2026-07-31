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

#### Inspect or update a cast budget

Use `/materia budget` to inspect the selected cast's consumed tokens and current token limit. It targets the active cast first; when no cast is active, it falls back to the latest resumable failed or aborted cast. Completed casts are not selected implicitly.

Use `/materia budget <tokens>` to update that cast's limit. The command is non-blocking, so it can raise the limit of an in-flight cast without recasting. Updates are persisted only in that cast's resolved configuration; global, user, and project configuration remain unchanged. The requested value must be a non-negative safe whole number at least as large as the cast's consumed token count, so equality is allowed but lowering the limit below consumed tokens is rejected.

Budget warnings use only `usage.tokens.total` and `warnAtPercent`. The token limit is an unconditional hard stop when `usage.tokens.total >= maxTokens`. Cost remains available in usage telemetry and displays, but never controls warnings or enforcement.

#### Recast vs Revive

pi-materia provides two ways to restart a failed cast:

| Command | Purpose |
|---|---|
| `/materia recast [id]` | **Re-send the same prompt.** Use for ordinary failures — reuses the active prompt or re-starts the socket, dispatching a new materia turn immediately. |
| `/materia revive [id]` | **Restore without necessarily re-sending.** Passive path normalizes state and awaits a nudge without inference. Exhaustion-extending paths extend the recovery budget then resume. For quest-linked casts with active work, queues the quest for later same-cast resumption. |

See [Resilient Inference and Revival](docs/resilient-inference-and-revival.md) for the full design.

```bash
/materia recast          # resume the most recent failed/aborted cast
/materia recast <id>     # resume a specific cast
/materia revive <id>     # passive revive if ordinary failure, or extend exhausted recovery allowance
/materia casts           # list past casts
/materia status          # show the current cast state
/materia abort           # stop the active cast
```

#### Automatic resilience

pi-materia handles several classes of failures without requiring manual intervention:

**Provision agent errors** — When the model reports a `stopReason: "error"` or a provider/event-level failure occurs, pi-materia records a bounded `inferenceInterruption` metadata object but keeps the cast active and awaiting a response. The cast stays in `awaiting_agent_response` state with no `cast_end ok:false`, no failed manifest entry, and no quest settlement. Pi's native retry, compaction, and follow-up mechanisms operate normally.

**agent_settled nudge** — If Pi settles while an unresolved inference interruption exists, pi-materia detects this via the `agent_settled` event, keeps the cast active, appends an `inference_interruption_settled` event with `nudgeNeeded: true`, and notifies the user to nudge. A subsequent user turn restores tool scope and completes normally.

**Transient transport errors** — WebSocket connection drops, `Stream ended without finish_reason`, and similar provider-stream interruptions are recorded as `transient_transport_turn_failure` warnings but do NOT force cast failure. The cast stays active and the next turn proceeds normally.

**Same-socket bounded recovery** — JSON parse failures, handoff validation errors, tool timeouts, and context-window limits trigger automatic retries within the same socket visit. Compaction is applied before context-window retries. The default allowance is one retry; exhausted casts can be revived to extend the budget.

#### Queued same-cast quest resumption

When you revive a quest-linked cast while another cast is active, pi-materia does not interrupt the active work. Instead:

1. The quest is unfailed to `pending` at the back of the queue with `resumeCastId` set to the target cast ID.
2. The target cast is marked dormant (`data.questQueuedResurrection`) so it no longer appears as revivable.
3. When the quest runner picks it up, it calls `reactivateQueuedCast` to restore the same cast at its preserved socket without dispatching a new prompt and without incrementing the quest's attempt count.

Run `/materia quest run` after reviving to consume the queued quest.

### Quick reference

| Failure class | Behaviour | Recovery |
|---|---|---|
| Provider error (stopReason error, event error) | `inferenceInterruption` set, cast stays active/awaiting | Pi native retry, then user nudge on agent_settled |
| Transient transport (WebSocket drop, stream-ended) | `transient_transport_turn_failure` warning, cast stays active | Next turn proceeds normally |
| JSON parse / handoff validation error | Same-socket retry (up to allowance) | `/materia revive` if exhausted |
| Tool timeout | Same-socket retry with timeout hint | `/materia revive` if exhausted |
| Context window exceeded | Compaction + same-socket retry | `/materia revive` if exhausted |
| Edge traversal exhausted | Cast failed with exhaustion metadata | `/materia revive` — extends allowance, advances to blocked target |
| Ordinary failure (no exhaustion) | Cast failed with `failedReason` | `/materia recast` (re-send prompt) or `/materia revive` (passive, no prompt)

### Customize your pipelines

Loadout and materia configuration is layered JSON (defaults → user profile → project file → env/cli overrides). Full customization details live in the docs:

- [Handoff contract](docs/handoff-contract.md) — the JSON contract agent sockets use to pass work items between materia
- [Finalization configuration and migration](docs/finalization-configuration.md) — direct JSON, qualified tool-backed submission, fallback, and rollout guidance
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

## Central control plane

pi-materia can run **central-connected**: a standalone central control-plane server hosts a shared catalog of loadouts/materia, model policy, and aggregated telemetry, while your local Pi instance keeps executing casts locally. Local-only mode is the default and loses nothing — nothing central happens until you configure a connection. Central definitions slot into config precedence between bundled defaults and your files (`default < central < user < project < explicit`), so local files always win and central never overwrites them.

### Start the server

From a pi-materia checkout:

```bash
# Optional: build the browser console (once, or after UI changes)
npm run build:webui

# Development mode: built-in tokens, fixed port 4600, SQLite state under ./data/
./scripts/dev-central-server.sh
```

The script just exports `MATERIA_CENTRAL_AUTH_MODE=development` and `MATERIA_CENTRAL_PORT=4600` before running `npm run start:central` — override either by exporting it first.

Verify it's up:

```bash
curl http://127.0.0.1:4600/api/health
```

Development mode enables three built-in bearer tokens:

| Token | Role |
|---|---|
| `dev-token-reader` | Read catalog, policy, telemetry, status |
| `dev-token-admin` | Reader + catalog/policy writes, admin metadata |
| `dev-token-sink` | Telemetry ingestion only |

State persists to `data/pi-materia-central.sqlite` (override with `MATERIA_CENTRAL_DATABASE_PATH`; delete the file to reset). Open the admin console at `http://127.0.0.1:4600/` and sign in with `dev-token-admin` to browse the catalog, publish definitions, and watch aggregate telemetry.

### Seed the catalog

Publish a loadout to the central catalog (writes use the admin token):

```bash
curl -X POST http://127.0.0.1:4600/api/catalog \
  -H "Authorization: Bearer dev-token-admin" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "central-echo",
    "kind": "loadout",
    "name": "Central-Echo",
    "description": "Seeded from the central catalog",
    "content": {
      "definition": {
        "entry": "Socket-1",
        "sockets": {
          "Socket-1": {
            "socketKind": "entry",
            "materia": "Narrate",
            "edges": [{ "when": "always", "to": "end" }]
          }
        }
      }
    }
  }'
```

### Connect your local Pi

Point your project at the server in `.pi/pi-materia.json`:

```json
{
  "central": { "apiUrl": "http://127.0.0.1:4600" }
}
```

Credentials come from the environment — never the profile file — so launch Pi through the connect wrapper, which exports the dev tokens (and a default `MATERIA_CENTRAL_API_URL`) for you:

```bash
cd /path/to/your-project
/path/to/pi-materia/scripts/dev-central-connect.sh                      # launches pi
/path/to/pi-materia/scripts/dev-central-connect.sh pi -e /path/to/pi-materia/src/index.ts
```

Or set the variables yourself: `MATERIA_CENTRAL_READ_TOKEN=dev-token-reader` and `MATERIA_CENTRAL_TELEMETRY_TOKEN=dev-token-sink`, then launch Pi normally.

`/materia loadout` now lists `Central-Echo` alongside your local loadouts, and every cast fans telemetry out to the server best-effort. If the server is unreachable, casts continue normally: catalog reads degrade to a last-known snapshot and telemetry drops with a diagnostic. Optionally set `MATERIA_CENTRAL_RUNTIME_ID` to give this runtime a stable identity in the monitoring views.

### Watch telemetry arrive

```bash
# Aggregated status across runtimes
curl -H "Authorization: Bearer dev-token-reader" http://127.0.0.1:4600/api/status

# Raw ingested events (filter with ?runtimeId=, ?castId=, ?limit=)
curl -H "Authorization: Bearer dev-token-reader" "http://127.0.0.1:4600/api/telemetry/events?limit=50"
```

### Production posture

Omit `MATERIA_CENTRAL_AUTH_MODE=development` (production is the default) and set `MATERIA_CENTRAL_READ_TOKEN`, `MATERIA_CENTRAL_ADMIN_TOKEN`, and `MATERIA_CENTRAL_TELEMETRY_TOKEN` to three distinct values; each also supports a `_FILE` variant (e.g. `MATERIA_CENTRAL_ADMIN_TOKEN_FILE`) for mounted secrets. Startup refuses to bind without them. The full deployment/settings contract is in [docs/enterprise-control-plane.md](docs/enterprise-control-plane.md).

## Reference

### All commands

| Command | Description |
|---|---|
| `/materia cast <task>` | Run a cast with the active loadout |
| `/materia budget [<tokens>]` | Show the selected cast's consumed tokens and token limit, or update its cast-local limit |
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
| `/materia recast [id]` | Resume a failed/aborted cast — re-sends the prompt on the same socket immediately |
| `/materia revive [id]` | Passive revival (no prompt) for failed casts; extends recovery allowance and resumes for exhausted casts; queues quest-linked casts for later same-cast resumption |
| `/materia casts` | List past casts |
| `/materia status` | Show active cast state |
| `/materia continue` | Finalize a paused multi-turn planning socket; also used to nudge a reactivated cast forward |
| `/materia abort` | Stop the active cast |

### Configuration layering

Config is merged from lowest to highest precedence:

1. Bundled defaults (`config/default.json`)
2. User profile (`~/.config/pi/pi-materia/materia.json`)
3. Project file (`.pi/pi-materia.json`)
4. `MATERIA_CONFIG` environment variable
5. `--materia-config` CLI flag

### Token budget configuration

Configure the token warning threshold and hard limit with the top-level `budget` object:

```json
{
  "budget": {
    "maxTokens": 200000,
    "warnAtPercent": 75
  }
}
```

`maxTokens` and `warnAtPercent` are evaluated from the cast's token usage only. A warning is emitted when `usage.tokens.total` reaches the configured percentage, and the cast always hard-stops when `usage.tokens.total` reaches or exceeds `maxTokens`. There are no monetary or soft-stop budget controls; cost values are retained as usage telemetry only.

`/materia budget` reads the active cast, or the latest resumable failed/aborted cast when there is no active cast. `/materia budget <tokens>` persists a cast-local limit without rewriting source configuration or automatically recasting. Values must be non-negative safe whole numbers and cannot be below the selected cast's consumed token count.

### Artifacts

Each cast writes a timestamped directory:

```
.pi/pi-materia/<cast-id>/
  config.resolved.json
  events.jsonl
  usage.json              # token totals and cost telemetry
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
