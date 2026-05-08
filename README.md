# pi-materia

pi-materia is a [Pi](https://pi.dev) extension for configurable, materia-themed agent workflows. A Materia Grid is a data-driven graph: each socket/node renders a reusable materia behavior, exposes a configured tool scope, optionally parses output, assigns state, and follows configured links.

The bundled default loadout is a software-development workflow, but the engine itself is generic. Materia are reusable behaviors/skills; nodes and sockets are placement adapters that decide parse mode, assignment, routing, and iteration. You can replace the grid with a single socket that says `HELLO WORLD`, or with any arbitrary sequence/loop of materia turns.

## Current status

pi-materia is early and intentionally small. The native runtime drives the active Pi session, so materia turns render with Pi's normal assistant/tool UI instead of hidden subagents. Casts persist state in the session, isolate model context per materia, write structured artifacts, stream a live status widget, track Pi-native usage where available, and expose `/materia grid`.

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

### WebUI development scaffold

The `/materia ui` WebUI scaffold lives under `src/webui/`:

- `src/webui/client/` is a Vite + React + Tailwind app.
- `src/webui/server/` is a TypeScript Node HTTP server that serves the built client and exposes a health endpoint.

Useful commands:

```bash
npm run dev:webui          # Vite client dev server
npm run dev:webui:server   # Node server in watch mode
npm run build:webui        # build client and server into dist/webui/
npm run test:webui         # Vitest client smoke tests
npm run typecheck          # extension, client, and server type checks
```

WebUI implementation inspection notes for future `/materia ui` work live in [docs/webui-integration-notes.md](docs/webui-integration-notes.md). Manual regression coverage for the shipped UI is documented in [docs/webui-smoke-tests.md](docs/webui-smoke-tests.md). Canonical edge conditions, generator materia, loop-consumer regions, utility materia, migration notes, and affected check commands are documented in [docs/graph-semantics.md](docs/graph-semantics.md).

## Usage

```text
/materia grid
/materia loadout
/materia loadout Planning-Consult
/materia ui
/materia cast implement the next small feature
/materia casts
/materia status
/materia abort
```

pi-materia reports the config source, artifact directory, active loadout, resolved grid, live status, and end-of-run token/cost totals when available. The visible transcript stays native, but full materia prompts are hidden behind compact Materia cast messages, and each materia turn receives a curated Materia context instead of the full previous conversation.

Use `/materia ui` to start or reuse a background WebUI server scoped to the current Pi session. It prints a clickable local URL. Browser auto-open is disabled by default and can be enabled in `~/.config/pi/pi-materia/config.json` with `{ "webui": { "autoOpenBrowser": true } }`; `preferredPort` and `host` are also supported.

In the WebUI loadout editor, create generator-driven loops by selecting the sockets that form a cycle with shift-click or a drag-selection box, then clicking **Create Loop**. The selected cycle must have exactly one inbound edge from a materia that declares `generates`; see [Graph semantics](docs/graph-semantics.md#generator-and-loop-consumer-regions) for the configuration contract and legacy iterator migration notes.

In the WebUI materia editor, the **Generate role prompt from brief** panel can draft prompt instructions for a prompt materia. Enter a short description of the role, click **Generate**, review the generated preview, then either **Regenerate**, **Discard**, or explicitly **Apply to prompt field**. Generation calls `POST /api/generate/materia-role` from the session-scoped WebUI server and uses an isolated in-memory context, so it does not append to or mutate the active Pi chat. Existing prompt text is not overwritten until you choose Apply.

Use `/materia loadout` to list configured graph loadouts and mark the active one. Use `/materia loadout <name>` to switch the active graph for future casts, for example `/materia loadout Planning-Consult`. Loadout names may contain hyphens.

### Metrics semantics

Usage costs are reported in USD from Pi assistant-message usage metadata. When Pi provides a total cost, Materia preserves that total; otherwise it sums the available input/output/cache cost components.

Attempt counts are per exact Materia work-item identity: the node id plus the current `foreach` item key, or a singleton key for non-`foreach` nodes. A retry/self-loop of the same node/item increments the attempt; moving to a different `foreach` item or another node starts at attempt 1. Node visit counts are still used for visit limits and artifact file names.

## Configuration

pi-materia layers config from lowest to highest precedence:

1. bundled default config at `config/default.json`
2. user assets at `~/.config/pi/pi-materia/materia.json`
3. target project `.pi/pi-materia.json`
4. `MATERIA_CONFIG=/path/to/config.json`
5. `--materia-config /path/to/config.json`

The user profile directory and `~/.config/pi/pi-materia/config.json` are created on demand for WebUI/profile preferences such as `webui.autoOpenBrowser`, `webui.preferredPort`, and `defaultSaveTarget`. Set `PI_MATERIA_PROFILE_DIR` to override the profile directory. Optional `roleGeneration` preferences are normalized safely before use: `enabled` (default `true`), `model`, `provider`, `api`, `thinking`, `extraInstructions`, and `useReadOnlyProjectContext` (default `false`). Invalid role-generation fields are ignored with a warning. Omit `model`/`provider`/`api`/`thinking` to use Pi's active generation settings; set them to make isolated Materia role prompt generation use a specific profile override.

Example profile config (`~/.config/pi/pi-materia/config.json`):

```json
{
  "webui": { "autoOpenBrowser": false, "preferredPort": 4317 },
  "defaultSaveTarget": "user",
  "roleGeneration": {
    "enabled": true,
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "thinking": "medium",
    "extraInstructions": "Prefer concise operational instructions for generated Materia roles.",
    "useReadOnlyProjectContext": false
  }
}
```

You can also use a provider-qualified model string, such as `"model": "openai-codex/gpt-5.5"`; in that case `provider` is optional.

CLI config example:

```bash
pi -e /path/to/pi-materia/src/index.ts --materia-config ./my-loadout.json
```

Minimal hello-world loadout:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Hello",
  "loadouts": {
    "Hello": {
      "entry": "hello",
      "nodes": {
        "hello": {
          "type": "agent",
          "materia": "echoer",
          "next": "end"
        }
      }
    }
  },
  "materia": {
    "echoer": {
      "tools": "none",
      "prompt": "Follow the prompt exactly. Say exactly: HELLO WORLD"
    }
  }
}
```

Configs can also define named `loadouts` that share the top-level `materia`, `limits`, `budget`, `compaction`, and `artifactDir`. Set `activeLoadout` to choose which graph `/materia cast` runs:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Full-Auto",
  "loadouts": {
    "Full-Auto": {
      "entry": "planner",
      "nodes": {
        "planner": { "type": "agent", "materia": "planner", "next": "Build" },
        "Build": { "type": "agent", "materia": "Build", "next": "end" }
      }
    },
    "Planning-Consult": {
      "entry": "planner",
      "nodes": {
        "planner": { "type": "agent", "materia": "interactivePlan", "next": "Build" },
        "Build": { "type": "agent", "materia": "Build", "next": "end" }
      }
    }
  },
  "materia": {
    "planner": { "tools": "readOnly", "prompt": "Plan automatically." },
    "interactivePlan": { "tools": "readOnly", "multiTurn": true, "prompt": "Collaborate, then finalize only after /materia continue." },
    "Build": { "tools": "coding", "prompt": "Implement exactly the adapter-provided current workItem." }
  }
}
```

When switching with `/materia loadout <name>`, pi-materia persists only the `activeLoadout` override to the active writable config path: the explicit `--materia-config`/`MATERIA_CONFIG` file when one is used, otherwise the target project's `.pi/pi-materia.json`. If you are using the bundled defaults, switching creates or updates `.pi/pi-materia.json`; it does not modify `config/default.json`. WebUI saves default to the user asset store at `~/.config/pi/pi-materia/materia.json` and only write `.pi/pi-materia.json` when the UI explicitly requests project scope.

### Proactive compaction thresholds

By default, pi-materia proactively compacts at 75% for context windows below 128k tokens, 65% for 128k through 199,999 tokens, and 55% for 200k tokens and above. Threshold resolution uses the active/effective Pi model context window; if model/context-window metadata is missing or invalid, pi-materia falls back to the conservative 55% threshold to compact earlier and reduce provider-side context-window failures. You can override this with a backward-compatible single percentage:

```json
{ "compaction": { "proactiveThresholdPercent": 60 } }
```

If `proactiveThresholdPercent` is present, it takes precedence even if tiered thresholds are also present (useful for layered config overrides). Or configure ordered min-inclusive/max-exclusive tiers. Tiers must start at `0`, have no gaps or overlaps, and the final tier must omit `maxContextWindow`:

```json
{
  "compaction": {
    "proactiveThresholdTiers": [
      { "id": "small", "minContextWindow": 0, "maxContextWindow": 128000, "thresholdPercent": 70 },
      { "id": "medium", "minContextWindow": 128000, "maxContextWindow": 200000, "thresholdPercent": 60 },
      { "id": "large", "minContextWindow": 200000, "thresholdPercent": 50 }
    ]
  }
}
```

### Per-materia model and thinking settings

Materia configs may optionally set `model` and `thinking` alongside `tools` and `prompt`. If a materia omits `model`, pi-materia does not switch models for that turn; it preserves Pi's currently active model as the default behavior. If a materia omits `thinking`, pi-materia likewise preserves Pi's active thinking level.

Use `provider/model-id` (or an unambiguous model id from Pi's model registry) for `model`. Supported `thinking` strings are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh` when the active Pi runtime/provider supports thinking controls.

Example loadout excerpt where planner and evaluator materia use a cheaper model, while Build uses a stronger coding model:

```json
{
  "materia": {
    "planner": {
      "tools": "readOnly",
      "model": "openai/gpt-4o-mini",
      "thinking": "low",
      "prompt": "Return the generic handoff envelope with ordered workItems."
    },
    "Build": {
      "tools": "coding",
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "high",
      "prompt": "Implement exactly the adapter-provided current workItem."
    },
    "Auto-Eval": {
      "tools": "readOnly",
      "model": "openai/gpt-4o-mini",
      "thinking": "medium",
      "prompt": "Verify the current workItem strictly and return the generic evaluator envelope JSON with satisfied, feedback, and missing."
    },
    "Maintain": {
      "tools": "coding",
      "prompt": "Checkpoint accepted work."
    }
  }
}
```

In this example, `Maintain` intentionally has no `model` or `thinking`, so it falls back to whatever model and thinking level are active in Pi at that point. The bundled default loadouts leave materia model-free, so installing pi-materia does not pin or override your active Pi model.

Run `/materia grid` to verify the resolved materia settings before casting. Agent slots show `model=<configured value>` and `thinking=<configured value>` for explicit settings, or labels such as `model=active Pi model` and `thinking=active Pi thinking` for fallback materia.

Provider/runtime limitations: explicit model switching requires Pi's runtime to expose model switching and the requested model must exist in Pi's registry with usable credentials. Explicit thinking requires Pi's runtime to expose thinking-level controls, and individual providers/models may ignore or map levels differently. pi-materia raises a clear materia-specific error when an explicit `model` or `thinking` setting is unsupported; fallback materia continue to use Pi's active settings without attempting a switch.

Generic node mechanics:

- `materia`: named top-level materia assigned to an agent node
- `parse`: `"text"` or `"json"`; JSON-parsed node outputs follow the canonical [materia handoff JSON contract](docs/handoff-contract.md)
- `assign`: copy parsed output/state values into generic cast state
- `edges`: ordered condition-driven links using canonical conditions such as `satisfied`, `not_satisfied`, or `always`; runtime selects the first edge whose guard matches, so repeated guarded predicates are allowed, while edges after an unconditional edge are invalid because they are unreachable. The WebUI's **Flow** label is the `always` condition, not a separate edge model.
- `next`: fallback link when no edge matches
- `foreach`: iterate a node over an array in state
- `advance`: advance a configured cursor
- `limits`: node/edge cycle safety

Materia graphs are workflow state machines, not DAGs. Loops such as `Socket-4 (Build) -> Socket-5 (Auto-Eval) -> Socket-6 (Maintain) -> Socket-4 (Build)` are valid and model repeated work-item sections/retry paths; runtime node-visit and edge-traversal limits bound execution instead of config validation rejecting cycles. Prefer declaring a top-level generator materia with `generates: { output: "workItems", listType: "array", itemType: "workItem", ... }`, wiring its JSON node with `parse: "json"` and an assign entry that maps the output key from the matching JSON handoff path (for example `"workItems": "$.workItems"`), then adding a loadout-level `loops` region with `consumes: { from, output }`. pi-materia derives the loop consumer iterator path from that generator declaration (defaulting to `state.${output}`) instead of tagging arbitrary loop members as iterators. Generated units of work intentionally use `workItems`; pi-materia does not retain a `tasks` compatibility output for new generated work units. See [docs/handoff-contract.md](docs/handoff-contract.md), [docs/graph-semantics.md](docs/graph-semantics.md), and [examples/graph-semantics-loadout.json](examples/graph-semantics-loadout.json).

Top-level materia define agent capabilities and behavior with `tools`, `prompt`, optional `model`, optional `thinking`, optional `multiTurn`, and optional `generates` metadata for list-producing materia. Set `"multiTurn": true` on a materia to let any agent node using that materia pause for interactive refinement until the user runs `/materia continue`.

### Multi-turn planner materia

Agent nodes are single-turn by default: after the assistant responds, pi-materia parses/assigns the output and follows edges or `next` automatically. Add `"multiTurn": true` to an agent materia when you want nodes using that materia to run a manual refinement loop. A multi-turn materia records each assistant response as a refinement artifact, keeps the cast active at the current node, and treats ordinary user replies as refinement instructions instead of finalization.

Examples of refinement replies that do **not** finalize or advance the node:

- `Let's do a full CRT-inspired shader with phosphor glow.`
- `Add rollback steps before we continue.`
- `Can you split the bootstrap work into its own work item?`
- `Continue refining the risk section.`

Natural-language replies never finalize or advance the node, even when they say things like `ready to continue`, `looks good, proceed`, or `finalize`. When the latest draft is ready, run `/materia continue`; this command is the only supported way to finalize a paused multi-turn node.

Only after `/materia continue` does pi-materia request the final assistant output and process it using the node's normal `parse`, `assign`, `edges`, and `next` behavior. For JSON-parsed multi-turn nodes, refinement turns should stay conversational: the agent should not emit final structured JSON, and pi-materia should not parse final JSON, until the command-triggered finalization turn.

The bundled config wires the `interactivePlan` materia, which has `multiTurn: true`, into the `Planning-Consult` loadout. To customize that behavior, create a project `.pi/pi-materia.json` or pass `--materia-config` with named `loadouts` and `activeLoadout` like this excerpt:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Custom",
  "loadouts": {
    "Custom": {
      "entry": "ensureArtifactsIgnored",
      "nodes": {
        "ensureArtifactsIgnored": {
          "type": "utility",
          "utility": "project.ensureIgnored",
          "parse": "json",
          "params": { "patterns": [".pi/pi-materia/"] },
          "assign": { "artifactIgnore": "$" },
          "next": "detectVcs"
        },
        "detectVcs": {
          "type": "utility",
          "utility": "vcs.detect",
          "parse": "json",
          "assign": { "vcs": "$" },
          "next": "interactivePlan"
        },
        "interactivePlan": {
          "type": "agent",
          "materia": "interactivePlan",
          "parse": "json",
          "assign": { "workItems": "$.workItems", "guidance": "$.guidance" },
          "next": "Build"
        },
        "Build": { "type": "agent", "materia": "Build", "foreach": { "items": "state.workItems", "as": "workItem", "cursor": "workItemIndex", "done": "end" }, "next": "end" }
      }
    }
  },
  "materia": {
    "interactivePlan": { "tools": "readOnly", "multiTurn": true, "prompt": "Collaboratively refine an implementation plan for this request. Do not emit final JSON during refinement. Only after the user runs /materia continue, return the generic handoff envelope with shape: { \"summary\": string, \"workItems\": [{ \"id\": string, \"title\": string, \"description\": string, \"acceptance\": string[], \"context\": { \"architecture\": string, \"constraints\": string[], \"dependencies\": string[], \"risks\": string[] } }], \"guidance\": {}, \"decisions\": [], \"risks\": [], \"satisfied\": true, \"feedback\": \"\", \"missing\": [] }. Use workItems, not tasks. Request: {{request}}" },
    "Build": { "tools": "coding", "prompt": "Implement exactly the assigned workItem using adapter-provided guidance." }
  }
}
```

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
  usage.json       # token totals and USD cost totals/breakdowns from Pi usage metadata
  manifest.json
  nodes/<node-id>/<visit>.md
  nodes/<node-id>/<visit>.json
  contexts/<node-id>-<visit>.md
```

## Default loadouts

The bundled defaults live at `config/default.json` and set `activeLoadout` to `Full-Auto`.

- `Full-Auto`: the autonomous software-development workflow. The `planner` materia immediately produces a generic handoff envelope with structured `workItems` from the initial request, then `Build`, `Auto-Eval`, and `Maintain` iterate through implementation, verification, and checkpointing.
- `Planning-Consult`: the conversational planning workflow. The planner node uses the `interactivePlan` materia with `multiTurn: true`, so it starts with normal discussion instead of immediate work-item JSON: it can summarize the request, ask clarifying questions, propose a breakdown, and refine scope or acceptance criteria with you before implementation begins.

When using `Planning-Consult`, reply naturally during the planning loop with corrections, answers, tradeoffs, or requested changes such as "add a CRT shader requirement" or "split testing into a separate work item"; these refinement messages do not finalize. Once the plan looks right, run `/materia continue`. pi-materia then asks for the final JSON plan, parses it into the configured generic envelope (`summary`, `workItems`, `guidance`, `decisions`, `risks`, `satisfied`, `feedback`, and `missing`), and advances to the automated `Build`/`Auto-Eval`/`Maintain` execution loop. JSON output and parsing are intentionally deferred until that command-triggered finalization step.

Both loadouts are defined entirely as config using top-level reusable materia prompts plus socket/node adapters for JSON parsing, state assignment, conditional edges, foreach cursors, and named Materia assignments. Bundled default socket ids are sequential (`Socket-1` through `Socket-6`); materia identity stays in node fields such as `materia` or `utility`, while displays can add context like `Socket-4 (Build)`. Use `/materia loadout` to see which one is active and `/materia loadout Full-Auto` or `/materia loadout Planning-Consult` to switch.
