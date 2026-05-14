# pi-materia

pi-materia is a [Pi](https://pi.dev) extension for configurable, materia-themed agent workflows. A Materia Grid is a data-driven graph: each socket renders a reusable materia behavior, exposes a configured tool scope, optionally parses output, assigns state, and follows configured links.

The bundled default loadout is a software-development workflow, but the engine itself is generic. Materia are reusable behaviors/skills; sockets are placement adapters that decide parse mode, assignment, routing, and iteration. You can replace the grid with a single socket that says `HELLO WORLD`, or with any arbitrary sequence/loop of materia turns.

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

WebUI implementation inspection notes for future `/materia ui` work live in [docs/webui-integration-notes.md](docs/webui-integration-notes.md). Manual regression coverage for the shipped UI is documented in [docs/webui-smoke-tests.md](docs/webui-smoke-tests.md). Loadout ownership, default immutability, lock/edit mode, migration registry rules, and future guardrails are documented in [docs/loadout-ownership-locking.md](docs/loadout-ownership-locking.md). Canonical edge conditions, generator materia, loop-consumer regions, utility materia, migration notes, and affected check commands are documented in [docs/graph-semantics.md](docs/graph-semantics.md). The canonical relationship between loop exits, `consumes`, `parse`, `advance`, and ordered edges is documented in [docs/loop-semantics.md](docs/loop-semantics.md); the loop compatibility shim inventory and sunset plan are in [docs/loop-compatibility-sunset.md](docs/loop-compatibility-sunset.md).

## Usage

```text
/materia grid
/materia loadout
/materia loadout Planning-Consult
/materia ui
/materia cast implement the next small feature
/materia link [--from <cast-id>] <target> [<target> ...] -- <prompt>
/materia recast [cast-id]
/materia revive [cast-id]
/materia casts
/materia status
/materia abort
```

pi-materia reports the config source, artifact directory, active loadout, resolved grid, live status, and end-of-run token/cost totals when available. The visible transcript stays native, but full materia prompts are hidden behind compact Materia cast messages, and each materia turn receives a curated Materia context instead of the full previous conversation.

Use `/materia link [--from <cast-id>] <target> [<target> ...] -- <prompt>` to immediately run an ephemeral virtual loadout composed from materia and/or loadout targets without mutating the active loadout. Previous-cast context supplied with `--from` is structured state for opt-in materia/loadouts; it is not automatic prompt injection and does not require `Chain-Context` unless you want explicit context transformation.

Illustrative linked-run examples:

```text
/materia link Planner Build -- Add a small settings page.
/materia link loadout:Planning-Consult loadout:Full-Auto -- Plan and implement the next feature.
/materia link materia:Context-Check loadout:Planning-Consult Build -- Audit, plan, then implement.
/materia link --from 2026-05-12T19-40-40-605Z Chain-Context Build -- Continue the prior cast.
/materia link --from 2026-05-12T19-40-40-605Z loadout:Full-Auto -- Continue without automatic prompt injection.
```

Unprefixed targets are allowed only when they do not collide with another materia/loadout name; use `materia:<name>` or `loadout:<name>` to disambiguate. See [link semantics](docs/link-semantics.md) for the v1 contract, detailed examples, troubleshooting, migration notes, ambiguity rules, and non-goals.

Use `/materia recast [cast-id]` to resume a failed or user-aborted cast from its current socket. Use `/materia revive [cast-id]` only when a cast failed because same-socket recovery exhausted its structured attempt allowance (for example, repeated context-window recovery failures). Revive first increases the exhausted recovery context's effective allowance by the original max-attempt value, then delegates to the normal recast path; repeated revives are additive (`original + original` each time), not exponential, and the bump is scoped to that one exhausted socket/item context. Other terminal failures are not revivable; use `/materia recast` for general failed or aborted casts.

Use `/materia ui` to start or reuse a background WebUI server scoped to the current Pi session. It prints a clickable local URL. Browser auto-open is disabled by default and can be enabled in `~/.config/pi/pi-materia/config.json` with `{ "webui": { "autoOpenBrowser": true } }`; `preferredPort` and `host` are also supported.

In the WebUI loadout editor, create generator-driven loops by selecting the sockets that form a cycle with shift-click or a drag-selection box, then clicking **Create Loop**. The selected cycle must have exactly one inbound edge from a materia marked `generator: true`; generator sockets parse JSON and produce canonical `workItems`, including when one generator feeds another generator. Structured loops use normal edges for same-item flow, `advance` for cursor advancement/exhaustion detection, `loops.<id>.exits` for post-exhaustion socket routes, and terminal `end` when no exit route matches. Legacy `loops.exit` / `advance.done` inputs are compatibility-normalized on save/load/run so UI-created loops and hand-authored default-style loadouts behave the same. See [Graph semantics](docs/graph-semantics.md#generator-and-loop-consumer-regions), [Loop semantics](docs/loop-semantics.md), and [Loop compatibility and sunset plan](docs/loop-compatibility-sunset.md) for the configuration contract, executable loop-exit examples, and legacy iterator/output-alias migration notes.

In the WebUI materia editor, the **Generate role prompt from brief** panel can draft prompt instructions for a prompt materia. Enter a short description of the role, click **Generate**, review the generated preview, then either **Regenerate**, **Discard**, or explicitly **Apply to prompt field**. Generation calls `POST /api/generate/materia-role` from the session-scoped WebUI server and uses an isolated in-memory context, so it does not append to or mutate the active Pi chat. Existing prompt text is not overwritten until you choose Apply.

The same editor uses dropdowns for agent materia **Model** and **Thinking**. **Active Pi Model** saves no `model` override and uses the current Pi session model; **Active Pi Thinking** saves no `thinking` override and uses the current Pi thinking setting. Other model choices come from Pi's configured and credentialed model registry for the launching session. Thinking choices are derived from the selected model, or from the active Pi model when **Active Pi Model** is selected. When editing an existing materia whose saved model is no longer available, the dropdown includes only that saved value with an unavailable label so it can be preserved by saving unchanged; unavailable models are not offered as general choices for new selections. Existing legacy thinking values that are not supported by the selected model can likewise be preserved only while editing that unchanged saved value.

Use `/materia loadout` to list configured graph loadouts and mark the active one. Use `/materia loadout <name>` to switch the active graph for future casts, for example `/materia loadout Planning-Consult`. Loadout names may contain hyphens.

In the WebUI, shipped default loadouts are read-only and must be duplicated before editing. User-owned duplicates can be locked/unlocked as an edit-mode toggle; locked loadouts remain useful for inspection and monitoring. Deleting a duplicate of a default removes only the user copy and falls back to the matching shipped default when available. The full ownership, locking, migration, and developer guardrail contract is documented in [docs/loadout-ownership-locking.md](docs/loadout-ownership-locking.md).

### Metrics semantics

Usage costs are reported in USD from Pi assistant-message usage metadata. When Pi provides a total cost, Materia preserves that total; otherwise it sums the available input/output/cache cost components.

Attempt counts are per exact Materia work-item identity: the socket id plus the current `foreach` item key, or a singleton key for non-`foreach` sockets. A retry/self-loop of the same socket/item increments the attempt; moving to a different `foreach` item or another socket starts at attempt 1. Socket visit counts are used for visit limits, and cast artifacts are written under `sockets/` paths.

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
      "sockets": {
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
      "sockets": {
        "planner": { "type": "agent", "materia": "planner", "next": "Build" },
        "Build": { "type": "agent", "materia": "Build", "next": "end" }
      }
    },
    "Planning-Consult": {
      "entry": "planner",
      "sockets": {
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

Materia configs may optionally set `model` and `thinking` alongside `tools` and `prompt`. If a materia omits `model`, pi-materia does not switch models for that turn; it preserves Pi's currently active model as the default behavior. If a materia omits `thinking`, pi-materia likewise preserves Pi's active thinking level. In the WebUI editor these defaults are the **Active Pi Model** and **Active Pi Thinking** dropdown entries, and selecting them leaves the corresponding config field unset rather than saving the display label.

Use `provider/model-id` (or an unambiguous model id from Pi's configured and credentialed model registry) for `model`. Supported `thinking` strings are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh` when the active Pi runtime/provider and selected model support thinking controls.

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

Provider/runtime limitations: explicit model switching requires Pi's runtime to expose model switching and the requested model must exist in Pi's registry with usable credentials. Explicit thinking requires Pi's runtime to expose thinking-level controls, and individual providers/models may ignore or map levels differently. If a configured model is unknown, unavailable, or cannot be used because credentials are missing or unauthorized, pi-materia shows a warning naming that configured model and continues the cast with the active Pi session model. If configured thinking is unsupported by the effective model, pi-materia falls back to the active or nearest safe supported thinking setting and warns or records the fallback where possible. Runtime usage/events may record the requested model/thinking, effective model/thinking, and fallback reason when Pi exposes enough metadata.

Generic socket mechanics:

- `materia`: named top-level materia assigned to an agent socket
- `parse`: `"text"` or `"json"`; JSON-parsed socket outputs follow the canonical [materia handoff JSON contract](docs/handoff-contract.md)
- `assign`: copy parsed output/state values into generic cast state
- `edges`: ordered condition-driven links using canonical conditions such as `satisfied`, `not_satisfied`, or `always`; runtime selects the first edge whose guard matches, so repeated guarded predicates are allowed, while edges after an unconditional edge are invalid because they are unreachable. The WebUI's **Flow** label is the `always` condition, not a separate edge model.
- `next`: fallback link when no edge matches
- `foreach`: iterate a socket over an array in state
- `advance`: advance a configured cursor
- `limits`: socket/edge cycle safety

Materia graphs are workflow state machines, not DAGs. Loops such as `Socket-4 (Build) -> Socket-5 (Auto-Eval) -> Socket-6 (Maintain) -> Socket-4 (Build)` are valid and model repeated work-item sections/retry paths; runtime socket-visit and edge-traversal limits bound execution instead of config validation rejecting cycles. Prefer declaring a top-level Generator materia with `generator: true`, wiring its JSON socket with `parse: "json"` and an assign entry for the canonical handoff path (`"workItems": "$.workItems"`), then adding a loadout-level `loops` region with `consumes: { from, output: "workItems" }`. pi-materia derives the loop consumer iterator path from the canonical Generator config (`state.workItems`) instead of tagging arbitrary loop members as iterators. Generated units of work intentionally use `workItems`; pi-materia does not retain a `tasks` compatibility output for new generated work units. Existing authored `generates` metadata is migration-only compatibility, not the canonical schema. See [docs/handoff-contract.md](docs/handoff-contract.md), [docs/graph-semantics.md](docs/graph-semantics.md), and [examples/graph-semantics-loadout.json](examples/graph-semantics-loadout.json).

Top-level materia define agent capabilities and behavior with `tools`, `prompt`, optional `model`, optional `thinking`, optional `multiTurn`, and optional `generator: true` for list-producing Generator materia. Set `"multiTurn": true` on a materia to let any agent socket using that materia pause for interactive refinement until the user runs `/materia continue`.

### Multi-turn planner materia

Agent sockets are single-turn by default: after the assistant responds, pi-materia parses/assigns the output and follows edges or `next` automatically. Add `"multiTurn": true` to an agent materia when you want sockets using that materia to run a manual refinement loop. A multi-turn materia records each assistant response as a refinement artifact, keeps the cast active at the current socket, and treats ordinary user replies as refinement instructions instead of finalization.

Examples of refinement replies that do **not** finalize or advance the socket:

- `Let's do a full CRT-inspired shader with phosphor glow.`
- `Add rollback steps before we continue.`
- `Can you split the bootstrap work into its own work item?`
- `Continue refining the risk section.`

Natural-language replies never finalize or advance the socket, even when they say things like `ready to continue`, `looks good, proceed`, or `finalize`. When the latest draft is ready, run `/materia continue`; this command is the only supported way to finalize a paused multi-turn socket.

Only after `/materia continue` does pi-materia request the final assistant output and process it using the socket's normal `parse`, `assign`, `edges`, and `next` behavior. For JSON-parsed multi-turn sockets, refinement turns should stay conversational: the agent should not emit final structured JSON, and pi-materia should not parse final JSON, until the command-triggered finalization turn.

The bundled config wires the `interactivePlan` materia, which has `multiTurn: true`, into the `Planning-Consult` loadout. To customize that behavior, create a project `.pi/pi-materia.json` or pass `--materia-config` with named `loadouts` and `activeLoadout` like this excerpt:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Custom",
  "loadouts": {
    "Custom": {
      "entry": "ensureArtifactsIgnored",
      "sockets": {
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
  sockets/<socket-id>/<visit>.md       # canonical socket output artifact
  sockets/<socket-id>/<visit>.json
  contexts/<socket-id>-<visit>.md
```

## Default loadouts

The bundled defaults live at `config/default.json` and set `activeLoadout` to `Full-Auto`.

- `Full-Auto`: the autonomous software-development workflow. The `planner` materia immediately produces a generic handoff envelope with structured `workItems` from the initial request, then `Build`, `Auto-Eval`, and `Maintain` iterate through implementation, verification, and checkpointing.
- `Planning-Consult`: the conversational planning workflow. The planner socket uses the `interactivePlan` materia with `multiTurn: true`, so it starts with normal discussion instead of immediate work-item JSON: it can summarize the request, ask clarifying questions, propose a breakdown, and refine scope or acceptance criteria with you before implementation begins.

When using `Planning-Consult`, reply naturally during the planning loop with corrections, answers, tradeoffs, or requested changes such as "add a CRT shader requirement" or "split testing into a separate work item"; these refinement messages do not finalize. Once the plan looks right, run `/materia continue`. pi-materia then asks for the final JSON plan, parses it into the configured generic envelope (`summary`, `workItems`, `guidance`, `decisions`, `risks`, `satisfied`, `feedback`, and `missing`), and advances to the automated `Build`/`Auto-Eval`/`Maintain` execution loop. JSON output and parsing are intentionally deferred until that command-triggered finalization step.

Both loadouts are defined entirely as config using top-level reusable materia prompts plus socket adapters for JSON parsing, state assignment, conditional edges, foreach cursors, and named Materia assignments. Bundled default socket ids are sequential (`Socket-1` through `Socket-8`); materia identity stays in socket fields such as `materia` or `utility`, while displays can add context like `Socket-4 (Build)`. Loadout config and WebUI save payloads use canonical `sockets` collections for loadout membership and loop membership. Use `/materia loadout` to see which one is active and `/materia loadout Full-Auto` or `/materia loadout Planning-Consult` to switch.

### Socket terminology and compatibility

Socket terminology is now canonical across config, runtime state, monitor payloads, events, manifests, and artifacts. Current configs must use `sockets` for loadout and loop membership, runtime state uses fields such as `currentSocketId`, `socketState`, `bySocket`, and `socketId`, events use `socket_start`/`socket_complete`, same-socket recovery uses `same_socket_recovery_exhausted`, and new output artifacts are written under `sockets/` with `socket_output`/`socket_refinement` manifest kinds. Pre-socket aliases and old artifact directory names are intentionally no longer part of the active contract; migrate old configs and tooling to these socket field/path names before running current pi-materia.
