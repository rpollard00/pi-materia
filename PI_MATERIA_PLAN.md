# pi-materia Next Features Plan

This plan turns the first test feedback into a staged roadmap for pi-materia, a Pi extension for configurable agent pipelines.

## Goals

pi-materia should become a configurable, observable Pi-native workflow runtime where each pipeline node drives an isolated role turn in the active Pi conversation, reports progress/cost, exposes its work, and hands off to maintainer checkpoints safely.

## Naming and Metaphor Architecture

pi-materia uses a materia-inspired metaphor for pluggable agent pipelines:

- **pi-materia**: the overall Pi extension/framework and npm package.
- **Materia Grid**: the configured pipeline graph visualization.
- **Slot**: a graph position/node where an agent can be plugged in.
- **Materia**: a reusable role/capability package that can be slotted into the grid.
- **Link**: an edge/handoff between slots.
- **Loadout**: the full resolved configuration for a run.
- **Cast**: a pipeline execution/run.
- **Save Point**: a maintainer checkpoint/commit.
- **Command Materia**: implementation/build agents.
- **Sense/Scan Materia**: planner/evaluator agents that inspect, plan, or verify.
- **Support Materia**: helper behavior that modifies another slot, such as budget limits, retries, policy gates, or artifact capture.
- **Mastered Materia**: a reusable, validated pipeline or role preset.

Initial command naming should prefer `/materia` as the main namespace:

```text
/materia cast "build auth"
/materia grid
/materia loadout
/materia casts
/materia inspect
/materia tail
```

## Phase 1: Configuration and Runtime Separation

### 1. Load extension/config from outside the target project — implemented

Problem: testing the loop from the plugin repo pollutes the plugin working directory.

Tasks:
- Support a `--materia-config` extension flag or `MATERIA_CONFIG` env var.
- Resolve config in this order:
  1. explicit flag/env path
  2. target cwd `.pi/pi-materia.json`
  3. extension package default config
- Store cast artifacts in the target project by default, but support `artifactDir` in config.
- Document running Pi with the extension from another path:
  ```bash
  pi -e /path/to/pi-materia/src/index.ts
  ```

Acceptance:
- Can run pi-materia against any repo without writing runtime files into the extension repo.
- Config path and artifact directory are shown at run start.

Implementation notes:
- Added `--materia-config` and `MATERIA_CONFIG` support.
- Config resolution now falls back to target `.pi/pi-materia.json`, then built-in defaults.
- Added `artifactDir` config support.
- Each cast writes `config.resolved.json` into its artifact directory.
- Added `README.md` development usage docs.

### 2. Replace hardcoded agents with JSON pipeline config — implemented

Problem: planner/builder/evaluator/maintainer are hardcoded.

Tasks:
- Introduce config schema:
  ```json
  {
    "pipeline": {
      "entry": "planner",
      "nodes": {
        "planner": {
          "type": "agent",
          "role": "planner",
          "next": "builder"
        },
        "builder": {
          "type": "agent",
          "role": "builder",
          "next": "evaluator"
        },
        "evaluator": {
          "type": "agent",
          "role": "evaluator",
          "edges": {
            "passed": "maintainer",
            "failed": "builder"
          }
        },
        "maintainer": {
          "type": "agent",
          "role": "jjMaintainer",
          "next": "planner"
        }
      }
    },
    "roles": {
      "planner": { "tools": "readOnly", "systemPrompt": "..." }
    }
  }
  ```
- Validate config on load and report friendly errors.
- Keep current hardcoded loop as the default config.

Acceptance:
- Existing `/materia cast <task>` behavior works as the primary cast command.
- Pipeline can be modified by editing JSON only.

Implementation notes:
- Added `pipeline.entry` and `pipeline.nodes` to the default loadout.
- Slots now reference roles by name instead of the runtime directly calling hardcoded role keys.
- Removed `commitCommand` from the config schema; VCS behavior now belongs in maintainer role prompts.
- Added separate `jjMaintainer` and `gitMaintainer` roles.
- The bundled default currently uses `jjMaintainer` for faster local iteration.
- Added pipeline validation with friendly errors for missing slots, missing roles, and unsupported links.
- Runtime traverses configured Materia Grid links. Built-in node kinds (`planner`, `builder`, `evaluator`, `maintainer`) provide structured behavior, and `generic` nodes can be inserted for custom handoffs.
- Added `config/default.json` as the bundled default loadout that is used when no explicit or project config exists.

## Phase 2: Observability, Token Budgeting, and Visual Feedback

### 3. Token and cost reporting for safe testing

Problem: pi-materia runs multiple role turns, so token usage can climb quickly during test loops.

Tasks:
- [x] Capture usage from Pi assistant messages where Pi exposes it.
  - Current native runtime reads usage from assistant messages after role turns.
  - Needs real-run verification against provider/message shapes.
- [x] Aggregate per:
  - run
  - node/role
  - task
  - attempt
- [x] Show live totals in the pi-materia widget.
- [x] Write incremental totals to `usage.json` after every observed role-turn usage event.
- [x] Include model/provider/api/thinking level in usage report when available from Pi/model metadata.
- [x] Add configurable safety limits:
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
- [x] Warn when budget crosses `warnAtPercent`.
- [x] Stop or ask for confirmation when the limit is reached, depending on config.
- [ ] Verify token/cost capture with real casts and multiple providers.
- [x] Add a richer final usage breakdown display, not just totals notification + `usage.json`.
  - Current implementation renders a `materia-usage` widget with total, by-role, by-node, and by-task usage.

Acceptance:
- [x] Live widget shows token/cost totals during a run.
- [x] End of run reports total tokens and per-role breakdown in the UI.
- [x] Tests can be bounded by token/cost limits to avoid runaway loops.

### 4. Rich progress feedback

Problem: current UI only shows messages like `building 1`, `building 2`.

Tasks:
- [x] Add a live status widget using `ctx.ui.setWidget()`.
- [x] Display:
  - run id
  - current node
  - current role
  - current task
  - attempt count
  - elapsed time
  - last emitted role-turn summary
  - token/cost totals if available
- [x] Update widget at major lifecycle events and streamed text deltas.
- [x] Polish widget formatting/layout enough for the MVP.
  - Further polish can happen after real TUI testing.

Acceptance:
- [x] User can tell what pi-materia is doing without opening logs.
  - Current widget is functional but intentionally minimal.

### 5. Visualize loaded pipeline/config

Tasks:
- [x] Add `/materia grid` command.
- [x] Render configured graph as text/ASCII:
  ```text
  planner -> builder -> evaluator
                         | passed -> maintainer
                         | failed  -> builder
  ```
- [x] Show roles, tools, max attempts, artifact dir, and budget.
- [ ] Show maintain policy once `maintainPolicy` exists in Phase 4.
- [x] Generalize graph rendering for configured `next` and labeled `edges`.
  - Runtime execution is still intentionally limited to the supported Phase 1 grid shape.

Acceptance:
- [x] Before running, user can inspect exactly what pi-materia will execute for the current supported grid shape.

### 6. Better artifact/log structure

Tasks:
- [x] Store structured event log/artifacts:
  - `events.jsonl`
  - `usage.json`
  - `config.resolved.json`
  - `plan.json`
  - `tasks/<task-id>/build-<attempt>.md`
  - `tasks/<task-id>/eval-<attempt>.json`
  - `maintenance/final.md`
- [x] Append major state transitions to `events.jsonl`.
- [x] Append role lifecycle/tool events to `events.jsonl`.
  - Captures state transitions, tool-visible Pi transcript entries, and agent end.
- [ ] Consider per-task maintenance artifact names once maintainer can run after each task.

Acceptance:
- [x] A pi-materia cast can be debugged after the fact from artifacts alone for the current pipeline.
- [ ] Confirm artifact completeness with a real failed cast and a real successful cast.

## Phase 2.5: Real-Run Feedback Fixes

Feedback from real `/materia cast` tests exposed several integration gaps. Follow-up work is now focused on the active Pi conversation/session as the primary runtime.

### A. Verify native transcript and prompt rendering

Problem: Materia should feel like a first-class Pi workflow, with native assistant/tool rendering and compact Materia control messages instead of raw orchestration prompts.

Actions:
- [x] Run planner/builder/evaluator/maintainer as active Pi turns.
- [x] Hide full Materia role prompts behind `display: false` custom messages.
- [x] Render compact visible cast messages for role transitions.
- [x] Use the main Pi pane for readable native assistant/tool progress.
- [ ] Real-run test confirms transcript volume is useful and not too noisy.

Acceptance:
- [x] During long-running builds/tool calls, the user can see useful progress in the main Pi window without opening artifacts.
- [ ] Raw orchestration prompts do not clutter the user-visible transcript.

### B. Fix token/cost tracking

Problem: real run showed tokens/cost stuck at zero before native session orchestration.

Actions:
- [x] Source usage from Pi assistant messages in the active session after each role turn.
- [ ] Verify usage capture with real casts and multiple providers.
- [ ] Add diagnostic logging for usage extraction during development.
- [ ] Update widget and `usage.json` from the confirmed source of truth.

Acceptance:
- Widget token/cost numbers update during or immediately after each role turn.
- Final `usage.json` matches Pi's own session totals.

### C. Bootstrap/checkpoint target projects for jj and artifacts

Problem: default maintainer is `jjMaintainer`, but new target repos may not be initialized for jj. Materia artifacts were captured by VCS.

Actions:
- [ ] Add a bootstrap step at cast start.
- [ ] If the default/configured maintainer is jj-based and no jj repo exists, initialize or ask to initialize jj.
- [ ] Ensure target `.gitignore` or VCS ignore rules exclude `.pi/pi-materia/` artifacts.
- [ ] Consider adding a `/materia bootstrap` command for explicit setup.

Acceptance:
- New target projects do not accidentally commit Materia runtime artifacts.
- jj maintainer can checkpoint work even when the prompt did not mention jj.

### D. Improve task labels and descriptions in UI/artifacts

Problem: widget showed `task: 2`; task ids alone are not meaningful.

Actions:
- [x] Track current task title/description in `MateriaRunState`.
- [x] Show task title in widget/status, e.g. `task: 2 - Add movement/input`.
- [x] Include task title in artifact metadata files.

Acceptance:
- User can tell which planned task is active without opening `plan.json`.

### E. Realtime elapsed/progress updates during long tool calls

Problem: elapsed time only updates between lifecycle events, and status stayed on `starting` during long installs/compiles.

Actions:
- [ ] Add a timer while a cast is active to refresh the widget elapsed time every second or few seconds.
- [ ] Capture and display tool execution start/update/end events in the widget.
- [ ] Show active tool name/command summary, especially long `bash` commands.
- [ ] Surface long-running tool output summaries in the main pane if possible.

Acceptance:
- During a long compile/install, elapsed time continues ticking and the active command/tool is visible.

## Phase 3: Native Pi Session Orchestration

Strategic direction: Materia is a Pi-native workflow/state-machine orchestrator. The active Pi session does the planner/builder/evaluator/maintainer work so rendering, scrolling, tool output, token accounting, and resumability come from Pi itself.

### 7. Redesign lifecycle around the active Pi session

Problem addressed: the original implementation ran roles outside the active Pi conversation, then copied output back into the main pane. The native runtime keeps the visible transcript, tool UI, usage accounting, and resumability anchored in the active Pi session.

Target architecture:

```text
/materia cast <request>
  -> create Materia cast state
  -> send planner prompt into active Pi session

Pi agent turn ends
  -> Materia reads assistant output
  -> parse/record plan
  -> send builder prompt into active Pi session

Builder turn ends
  -> Materia records summary/artifacts
  -> send evaluator prompt into active Pi session

Evaluator turn ends
  -> Materia parses evaluation JSON
  -> if failed and attempts remain: send builder repair prompt
  -> if passed: continue next task or maintainer

Maintainer turn ends
  -> Materia records checkpoint outcome
  -> cast complete
```

Core principle:
- Materia drives **what prompt comes next**.
- Pi remains responsible for **rendering, tool execution, sessions, token accounting, scrolling, and persistence**.

Implementation tasks:

#### 7.1 Add persisted cast state

- [x] Define a `MateriaCastState` persisted via `pi.appendEntry()` and restored from session entries on resume.
- [x] Track:
  - cast id
  - request
  - config source/hash
  - artifact dir/run dir
  - current node
  - current phase: `planning | building | evaluating | maintaining | complete | failed`
  - current task id/title
  - task list
  - current attempt
  - last processed assistant entry/message id
  - pending next action
- [x] Add helpers:
  - `loadActiveCastState(ctx.sessionManager)`
  - `saveCastState(pi, state)`
  - `clearCastState(pi, state)`

Acceptance:
- A cast can survive Pi restart/session reload and know where it left off.

#### 7.2 Replace external role execution with active-session prompt injection

- [x] Stop using the pre-native role execution path for the main runtime.
- [x] Default runtime now drives all roles through the active Pi session.
- [x] Introduce prompt builders:
  - `buildPlannerPrompt(request, config)`
  - `buildBuilderPrompt(task, attempt, feedback, config)`
  - `buildEvaluatorPrompt(task, buildSummary, config)`
  - `buildMaintainerPrompt(config)`
- [x] Use `pi.sendUserMessage()` or `pi.sendMessage(..., { triggerTurn: true })` to start the next active Pi turn.
- [x] Ensure prompts include the active role/system-like instructions since per-turn system prompt swapping may not be available.

Acceptance:
- Planner/builder/evaluator/maintainer output appears as normal Pi assistant/tool output, not copied custom progress messages.

#### 7.3 Drive transitions from Pi lifecycle events

- [x] Register `pi.on("agent_end", ...)` handler.
- [x] When a Materia cast is active, inspect the final assistant output for the current phase.
- [x] Transition state:
  - planning -> parse `PlanResult`, write `plan.json`, start first builder turn
  - building -> record build summary, start evaluator turn
  - evaluating -> parse `EvaluationResult`, branch passed/failed
  - maintaining -> record maintainer result, complete cast
- [x] Guard against double-processing by tracking last processed entry/message id.
- [x] Persist state before sending each next prompt.

Acceptance:
- Materia advances automatically after each active Pi turn.

#### 7.4 Manage tools/role behavior per phase

Problem: roles currently configure tool access and system prompts independently. Active-session orchestration needs equivalent behavior.

Options to investigate:
- [x] Use `pi.setActiveTools()` before each phase to approximate role tool scopes.
- [x] Include role `systemPrompt` as explicit instructions in each injected prompt.
- [x] Investigate whether Pi supports temporary system prompt/context injection through extension lifecycle hooks; implemented `before_agent_start` role prompt augmentation.
- [ ] If needed, add a `roleMode` config field documenting that active-session roles are prompt-scoped, not isolated system prompts. Deferred until config schema versioning.

Acceptance:
- Planner/evaluator can be constrained to read-only tools; builder/maintainer get coding tools.

#### 7.5 Use Pi-native token/cost/session accounting

- [x] Remove custom external-runner token accounting from the main active-session path.
- [x] Read totals from Pi assistant message usage for Materia widgets/artifacts.
- [x] Continue writing `usage.json`, but source it from Pi-native session data.
- [x] Keep budget enforcement, but check it after each turn using Pi's actual usage totals.

Acceptance:
- Materia token/cost numbers match Pi footer/session info.

#### 7.6 Artifact model for active-session orchestration

- [x] Continue writing:
  - `config.resolved.json`
  - `events.jsonl`
  - `usage.json`
  - `plan.json`
  - `tasks/<task-id>/build-<attempt>.md`
  - `tasks/<task-id>/eval-<attempt>.json`
  - `maintenance/final.md`
- [x] Store references to Pi session entries/message ids for each artifact.
- [x] Add a `manifest.json` mapping Materia phases/tasks to Pi entries.

Acceptance:
- Artifacts can be correlated directly with native Pi transcript entries.

#### 7.7 User controls for active casts

- [x] Add `/materia status` to show active cast state.
- [x] Add `/materia abort` to stop/clear active cast state.
- [x] Add `/materia continue` to resume from persisted state and send the next prompt if needed.
- [x] Add `/materia casts` for artifact discovery.

Acceptance:
- User can inspect, stop, and resume Materia's state machine explicitly.

#### 7.8 Native runtime cleanup

- [x] Active-session orchestration is the default runtime.
- [x] Update README to describe Materia as a Pi-native workflow orchestrator.
- [ ] Remove obsolete pre-native runtime code once the native runtime is fully smoke-tested.

Acceptance:
- Default Materia runtime runs entirely through the active Pi session.

Phase 3 implementation notes:
- Added `src/native.ts` as the Pi-native orchestration runtime.
- `/materia cast` now initializes a persisted cast state and sends the planner prompt into the active Pi session.
- `agent_end` transitions the state machine by following configured Materia Grid links and sends the next node prompt through a shared node-start path.
- `before_agent_start` augments the active system prompt with the current Materia role instructions.
- `context` replaces the model-visible conversation for active Materia turns with an isolated per-role context plus the current role turn/tool-loop messages.
- Role tool scopes are approximated with `pi.setActiveTools()`.
- Artifacts now include `manifest.json` linking phases/tasks to native Pi session entry ids and context artifacts.
- Each role turn writes the exact isolated model-visible context/prompt under `contexts/` before triggering the turn.

## Phase 3.5: Utility Materia Nodes and Test Foundation — Complete

Strategic correction from follow-up design discussion: deterministic project setup, artifact ignore hygiene, VCS detection, and future checkpoint mechanics should not be hardcoded into the Materia engine. They should be represented as configured Materia nodes just like agent slots, but executed by deterministic utilities instead of LLM turns.

Core principle:

```text
Config owns workflow meaning.
Agent nodes ask Pi/LLMs to reason or edit.
Utility nodes run deterministic configured programs.
The engine only traverses nodes and records outputs.
```

This phase should happen before deeper Maintenance/VCS Policy work so that VCS and bootstrap behavior can be implemented as data-driven utility Materia rather than framework-specific branches.

### 7.9 Add generic utility node support

Tasks:
- Extend pipeline node schema to support non-agent utility nodes:
  ```ts
  interface MateriaUtilityNodeConfig {
    type: "utility";
    utility?: string;
    command?: string[];
    params?: Record<string, unknown>;
    parse?: "json" | "text";
    assign?: Record<string, string>;
    next?: string;
    edges?: MateriaEdgeConfig[];
    foreach?: MateriaForeachConfig;
    advance?: MateriaAdvanceConfig;
    limits?: MateriaNodeLimitsConfig;
    timeoutMs?: number;
  }
  ```
- Keep `agent` and `utility` nodes on the same generic completion path:
  - write raw output artifact
  - optionally parse JSON
  - apply `assign`
  - evaluate configured `edges`/`next`
  - enforce visit/traversal limits
  - write manifest and event metadata
- Update `/materia grid` rendering and validation to show utility nodes and validate `command`/`utility` fields.
- Ensure utility nodes can participate in `foreach` just like agent nodes.

Acceptance:
- A single-node utility grid can run and complete without starting a Pi agent turn.
- Utility output can be assigned into generic cast state and routed with edge conditions.
- No utility implementation contains planner/builder/evaluator/maintainer assumptions.

### 7.10 Make utility nodes language-agnostic with a JSON process protocol

Primary primitive: run an explicitly configured command and exchange JSON over stdin/stdout. This allows users to write utility Materia in Python, Bash, Go, Rust, Node, Bun, or any other language.

Example config:

```json
{
  "pipeline": {
    "entry": "bootstrap",
    "nodes": {
      "bootstrap": {
        "type": "utility",
        "command": ["python3", ".pi/materia/ensure_ignored.py"],
        "params": {
          "patterns": [".pi/pi-materia/"]
        },
        "assign": {
          "bootstrap": "$"
        },
        "next": "planner"
      }
    }
  }
}
```

Input sent to the utility on stdin:

```json
{
  "cwd": "/path/to/project",
  "runDir": "/path/to/project/.pi/pi-materia/20260430-120000",
  "request": "build auth",
  "castId": "20260430-120000",
  "nodeId": "bootstrap",
  "params": {
    "patterns": [".pi/pi-materia/"]
  },
  "state": {},
  "item": null,
  "itemKey": null,
  "itemLabel": null
}
```

Expected stdout for JSON parse mode:

```json
{
  "ok": true,
  "changed": true,
  "added": [".pi/pi-materia/"]
}
```

Protocol rules:
- `stdout` is the utility result.
- `stderr` is diagnostic log output and should be artifacted.
- Exit code `0` means success.
- Non-zero exit code fails the node/cast with a clear diagnostic unless later config adds recoverable errors.
- JSON parse failures fail the node when `parse: "json"`.
- Utility commands are explicit config only; never auto-load arbitrary project files.
- Add timeouts and maximum captured output sizes to avoid hung or noisy utilities.

Acceptance:
- Utility examples work in at least one non-TypeScript language using only stdin/stdout JSON.
- The engine treats process utility output exactly like agent output for assignment and routing.

### 7.11 Add optional named/built-in utility aliases without making them engine semantics

Tasks:
- Add a small utility registry for optional named utilities such as:
  - `project.ensureIgnored`
  - `vcs.detect`
  - future `vcs.checkpoint`
- Treat named utilities as plugins/commands behind the same generic utility-node interface.
- Keep command-based utilities as the lowest-level, language-agnostic primitive.
- Do not implicitly insert bootstrap/VCS behavior into casts. If the default loadout uses these utilities, it should do so explicitly in `config/default.json`.

Initial candidate utility behavior:
- `project.ensureIgnored` with params `{ "patterns": [".pi/pi-materia/"] }`.
- `vcs.detect` returning `{ "kind": "jj" | "git" | "none", "root": string | null, "available": { "jj": boolean, "git": boolean } }`.

Acceptance:
- Built-in utilities can be used from config, but removing them from the grid removes the behavior.
- The engine remains a generic node executor rather than a VCS/bootstrap policy engine.

### 7.12 Document Utility Materia

Tasks:
- Add a simple markdown guide at `docs/utility-materia.md` covering:
  - when to use utility nodes vs agent nodes
  - utility node schema
  - JSON stdin/stdout protocol
  - Python example for `.gitignore`/artifact ignore hygiene
  - edge routing from utility JSON output
  - security/trust model for configured commands
  - testing utilities locally outside Pi
- Link the guide from `README.md` once the feature lands.
- Include at least one minimal complete loadout example that says/runs `HELLO WORLD` without an LLM turn.

Acceptance:
- A user can write a utility node in an arbitrary language by following the docs.
- Docs make clear that utility commands execute local code and must be explicitly trusted/configured.

### 7.13 Establish a test framework, likely with Bun

Problem: there is currently no test script or test harness. `npm run typecheck` exists, but runtime behavior is only manually smoke-tested.

Tasks:
- Evaluate adopting Bun for local development/test speed while preserving npm package compatibility for Pi users.
- Add `bun test` based test scripts, for example:
  ```json
  {
    "scripts": {
      "test": "bun test",
      "test:watch": "bun test --watch",
      "typecheck": "tsc --noEmit"
    }
  }
  ```
- Decide whether to switch package management fully to Bun (`bun.lock`) or keep `package-lock.json` until publishing compatibility is confirmed.
- Add a lightweight fake Pi extension context/session harness for native runtime tests.
- Keep tests runnable in a normal repo checkout without requiring real provider API calls.

Acceptance:
- `bun test` runs locally and in future CI without contacting an LLM provider.
- Existing `npm run typecheck` remains available.
- Test setup is documented in README or contributor notes.

### 7.14 Add test coverage for generic engine and utility nodes

Initial test targets:
- Template rendering and minimal path/expression helpers.
- Pipeline validation for `agent` and `utility` nodes.
- Utility command runner success with JSON output.
- Utility command runner text mode.
- Non-zero utility exit code failure diagnostics.
- Invalid JSON failure diagnostics.
- Timeout behavior.
- `foreach` utility execution and current item metadata.
- `assign` from utility output into generic state.
- Edge routing from utility JSON output.
- Manifest/events/artifacts for utility nodes, including short item labels.
- Fake-session smoke test for an all-utility `HELLO WORLD` grid.

Acceptance:
- Core utility node behavior is covered before changing the bundled default loadout to rely on utilities.
- Tests protect the data-driven engine from regressing into semantic planner/builder/evaluator branches.

## Phase 4: Maintenance and VCS Policy — Complete

Note: after Phase 3.5, Maintenance/VCS Policy should be implemented as configured Materia behavior where possible. Deterministic pieces such as VCS detection, ignore hygiene, and commits should be utility Materia nodes or named utilities, not hidden engine branches.

Status: implemented in the bundled loadout as configured `Build`, `Auto-Eval`, and `Maintain` Materia rather than hardcoded engine policy. `Auto-Eval` routes passed work to `Maintain` after each task. `Maintain` autonomously checkpoints and now returns structured JSON with `satisfied`, `commitMessage`, `reason`, `vcs`, `checkpointCreated`, and `commands`, assigned to `state.lastMaintain`. If `satisfied == false`, the node routes back to `Maintain` with a configured traversal limit; task cursor advancement is conditional on `satisfied == true`. VCS detection is explicit via the `vcs.detect` utility node.

### 8. Maintain more frequently

Problem: maintainer only runs at the end.

Tasks:
- [x] Add configured maintain/checkpoint behavior after each passed task. Supersedes a dedicated `maintainPolicy` field for the default loadout by expressing policy directly in the Materia Grid.
- [x] Original option considered: add `maintainPolicy` config:
  ```json
  {
    "maintainPolicy": {
      "mode": "afterEachTask",
      "commit": "autoOnSatisfied"
    }
  }
  ```
- Supported modes:
  - `endOnly`
  - `afterEachTask`
  - `afterEachPassedEvaluation`
  - `manual`
- [x] Default next version should be `afterEachTask`.

Acceptance:
- [x] Maintainer runs after each task passes evaluation.

### 9. Maintainer commits automatically when satisfied

Problem: maintainer asks user instead of deciding.

Tasks:
- [x] Maintainer evaluates repo state and decides whether to commit.
- [x] Require maintainer to return JSON:
  ```json
  { "satisfied": true, "commitMessage": "...", "reason": "..." }
  ```
- [x] If satisfied, the configured `Maintain` Materia autonomously executes the checkpoint/commit through Pi tools.
- [x] If not satisfied, maintainer explains why in structured output and the configured node edges retry `Maintain` up to the traversal limit.

Acceptance:
- [x] No confirmation prompt is required by default.
- [x] User can opt into confirmation by replacing `Maintain` with a manual/custom Materia node in the loadout.

### 10. Detect jj and use jj instead of git

Tasks:
- [x] Detect VCS:
  - if `.jj/` exists or `jj root` succeeds, use jj
  - else if `git rev-parse --show-toplevel` succeeds, use git
- [x] Implement VCS behavior as configured Materia rather than a hidden engine adapter:
  - `vcs.detect` utility reports `{ kind, root, available }`
  - `Maintain` inspects status/diff and checkpoints through Pi tools
- [x] jj checkpoint strategy:
  - use `jj status`
  - use `jj diff`
  - use `jj describe -m <message>`
  - use `jj new` after describing so the next task starts in a fresh change
- [x] git commit strategy:
  - `git add -A`
  - `git commit -m <message>`

Acceptance:
- [x] In jj repos, pi-materia's default Maintain instructions prefer jj and do not need git commit.
- [x] In git repos, pi-materia's default Maintain instructions use git.

## Phase 5: Safer Graph Execution

### 11. Configurable edge conditions and loop limits

Tasks:
- Move evaluator pass/fail logic into graph edge conditions.
- Add per-edge and per-node max loop counts.
- Detect infinite loops and stop with a clear error.

Acceptance:
- Graphs can express retry loops safely.

### 12. Per-role model/thinking/tool settings

Tasks:
- Extend role config:
  ```json
  {
    "model": "anthropic/claude-sonnet-4-5",
    "thinking": "medium",
    "tools": ["read", "grep", "find", "ls"]
  }
  ```
- Resolve model per role turn, falling back to active Pi model.

Acceptance:
- Planner/evaluator can use cheaper/read-only settings while builder uses stronger coding settings.
- Model switching happens on the active Pi session before each isolated role turn.

## Proposed Implementation Order

1. Config loading from external path and artifact directory separation. — implemented
2. Token/cost aggregation with live widget display and budget limits. — implemented, pending broader provider verification
3. Structured pipeline config replacing hardcoded roles. — implemented
4. Status widget and event log. — implemented
5. `/materia grid` pipeline visualization. — implemented
6. Active-session orchestration and isolated role context artifacts. — implemented
7. Fully data-driven generic engine. — implemented
8. Bun-based test foundation and fake Pi runtime harness.
9. Language-agnostic utility node schema and command runner.
10. Utility Materia documentation and examples.
11. Optional named utility registry, starting with artifact ignore/VCS detection utilities.
12. Update bundled default loadout to use utility nodes explicitly for deterministic bootstrap hygiene.
13. Maintainer/checkpoint policy as configured nodes/utilities, not engine branches.
14. Per-role model/thinking/tool settings.
15. Advanced graph edge conditions/parallelism if needed.

## Near-Term Commands to Add

- `/materia cast <task>`: cast the configured pipeline.
- `/materia grid`: show resolved config and graph.
- `/materia loadout`: show resolved config details.
- `/materia casts`: list recent cast artifact directories.
- `/materia inspect <cast-id>`: show paths/details for a prior cast.
- `/materia tail <cast-id>`: tail events from a prior cast.

## Open Design Questions

- Should roles use the same active model by default, or should roles define defaults?
- Should maintainer commit extension code/config changes by default, or only target-project changes?
- Should failed maintenance send control back to builder, evaluator, or stop?
- Should pi-materia support parallel branches later, or stay sequential initially?
- Should built-in utility aliases live in pi-materia core, separate packages, or both?
- What command sandbox/confirmation model is appropriate for utility nodes that execute arbitrary local programs?
- Should Bun become the primary package manager, or should Bun only provide the test runner while npm remains the publishing baseline?

## Phase 6: Fully Data-Driven Materia Engine

Strategic correction: the Materia engine must not know about planner/builder/evaluator/maintainer semantics. Those are default loadout concepts only. The framework source should contain no references to `plan`, `build`, `evaluate`, `maintain`, or node kinds as runtime behavior. The engine should only traverse configured nodes, render configured prompts, parse configured outputs, assign configured state, evaluate configured edges, and enforce generic safety limits.

Status: implemented. `src/native.ts` now uses one generic node start path and one generic node completion path. Runtime semantics are configured through `prompt`, `parse`, `assign`, `edges`, `foreach`, `advance`, and limits. The bundled software-development loadout is data in `config/default.json`; `src/` no longer contains runtime branches for planner/builder/evaluator/maintainer, plan/build/evaluation/maintain modes, or node kinds.

### 13. Remove semantic node behavior from framework source — Done

Problem: current code still has framework-level concepts like node output modes (`plan`, `evaluation`) and phase-specific branches. That prevents users from defining arbitrary Materia Grids such as a single node that says `HELLO WORLD` and exits.

Target principle:

```text
Config owns workflow meaning.
Engine owns traversal mechanics.
LLM + role prompt own task behavior.
```

The engine may know generic concepts:
- nodes
- roles
- prompts
- tools
- output parsing
- state assignment
- edges
- cursors/iteration
- counters/limits
- artifacts

The engine must not know domain concepts:
- planner
- builder
- evaluator
- maintainer
- plan
- build
- evaluation
- checkpoint/commit

Acceptance:
- A config with one node that prompts `Say exactly: HELLO WORLD` and `next: "end"` works without framework code changes.
- Searching `src/` for planner/builder/evaluator/maintainer/plan/build/evaluation/maintain should find only docs/examples/default config compatibility comments if any, not runtime branches.

### 14. Replace semantic node schema with generic node schema — Done

Remove or stop using runtime-semantic fields:

```ts
MateriaNodeKind
MateriaNodeOutputMode
output: "plan" | "evaluation"
taskScoped
attemptScoped
advanceTaskOnSuccess
```

Introduce generic node fields:

```ts
interface MateriaPipelineNodeConfig {
  type: "agent";
  role: string;
  prompt?: string;
  parse?: "text" | "json";
  assign?: Record<string, string>;
  next?: string;
  edges?: MateriaEdgeConfig[];
  foreach?: {
    items: string;
    as: string;
    cursor?: string;
  };
  advance?: {
    cursor: string;
    items: string;
  };
  limits?: {
    maxVisits?: number;
  };
}

interface MateriaEdgeConfig {
  when?: string;
  to: string;
  maxTraversals?: number;
}
```

Examples:

```json
{
  "hello": {
    "type": "agent",
    "role": "echoer",
    "prompt": "Say exactly: HELLO WORLD",
    "next": "end"
  }
}
```

```json
{
  "Auto-Eval": {
    "type": "agent",
    "role": "Auto-Eval",
    "parse": "json",
    "assign": {
      "lastCheck": "$"
    },
    "edges": [
      { "when": "$.passed == true", "to": "Maintain" },
      { "when": "$.passed == false", "to": "Build", "maxTraversals": 3 }
    ]
  }
}
```

Acceptance:
- Node schema describes mechanics only.
- Default planner/builder/evaluator/maintainer behavior is represented entirely as config using these generic fields.

### 15. Replace semantic cast state with generic state — Done

Remove semantic state fields:

```ts
tasks
currentTaskIndex
lastBuildSummary
lastFeedback
maintenanceMode
```

Replace with generic state:

```ts
interface MateriaCastState {
  data: Record<string, unknown>;
  cursors: Record<string, number>;
  visits: Record<string, number>;
  edgeTraversals: Record<string, number>;
  lastOutput?: string;
  lastJson?: unknown;
}
```

Common default workflow state should live under generic keys assigned by config, e.g.:

```json
"assign": {
  "tasks": "$.tasks"
}
```

and referenced via templates:

```text
{{state.currentTask.title}}
{{state.lastFeedback}}
{{lastOutput}}
```

Acceptance:
- Engine state is workflow-agnostic.
- Task iteration is a generic cursor over a configured collection, not a hardcoded task loop.

### 16. Implement generic node start path — Done

Replace all start functions/branches with one path:

```ts
startNode(nodeId)
```

Responsibilities:
- resolve node by id
- increment/check node visit counter
- resolve role
- set active tools from role
- render prompt template from generic state
- write context artifact
- send hidden prompt into active Pi session
- persist cast state

Prompt rendering should support generic variables:

```text
{{request}}
{{state.foo}}
{{item.id}}
{{item.title}}
{{lastOutput}}
{{lastJson.feedback}}
{{cursor.taskIndex}}
```

Acceptance:
- Every node, including entry node, starts through the same function.
- There are no node-id/name/kind-specific start functions.

### 17. Implement generic node completion path — Done

Replace phase branches with one path:

```ts
completeNode(outputText)
```

Responsibilities:
- write raw output artifact under `nodes/<node-id>/...`
- set `state.lastOutput`
- parse JSON only when `node.parse === "json"`
- set `state.lastJson` when parsed
- apply `assign` mappings
- apply cursor advancement when configured
- evaluate edges/next
- call `startNode(next)` or complete cast

Generic assignment examples:

```json
"assign": {
  "tasks": "$.tasks",
  "lastFeedback": "$.feedback",
  "lastPassed": "$.passed"
}
```

Acceptance:
- No `if planning`, `if building`, `if evaluating`, `if maintaining` runtime branches.
- JSON parsing is opt-in and configured per node.
- Raw output is always artifacted regardless of parse mode.

### 18. Implement small JSONPath/template/expression helpers — Done

Do not add a large dependency initially. Implement a minimal helper set.

JSON path support:

```text
$              whole parsed node output
$.field        parsed output field
$.a.b          nested parsed output field
state.foo      generic cast data
item.foo       current foreach item
lastJson.foo   previous parsed output
```

Template support:

```text
{{request}}
{{state.tasks}}
{{item.title}}
{{lastOutput}}
{{lastJson.feedback}}
```

Condition support for edges:

```text
$.passed == true
$.passed == false
$.status == "ok"
exists($.missing)
!exists($.missing)
```

Acceptance:
- Default workflow can route pass/fail through config only.
- Simple custom workflows can route on JSON fields without TypeScript changes.

### 19. Implement generic edge traversal and cycle safety — Done

Generic next resolution order:

1. first matching configured edge
2. `next`
3. `end`

Track:

```ts
visits[nodeId]
edgeTraversals[`${from}->${to}`]
```

Support limits:

```json
"limits": { "maxVisits": 10 }
```

and edge limits:

```json
{ "when": "$.passed == false", "to": "repair", "maxTraversals": 3 }
```

Acceptance:
- Infinite loops fail with clear diagnostics.
- Retry behavior is data-driven through edge traversal limits, not builder-specific attempt logic.

### 20. Make iteration data-driven — Done

Support generic foreach/cursor behavior:

```json
"foreach": {
  "items": "state.tasks",
  "as": "task",
  "cursor": "taskIndex"
}
```

and cursor advancement:

```json
"advance": {
  "cursor": "taskIndex",
  "items": "state.tasks"
}
```

Engine behavior:
- template exposes current item as `{{task.title}}` or `{{item.title}}`
- advancing past the collection routes to `end` or configured `done` target later

Acceptance:
- Default multi-task workflow is implemented via generic cursor configuration.
- Other workflows can iterate over arbitrary arrays, not just `tasks`.

### 21. Move current default workflow semantics into `config/default.json` — Done

The bundled default config should define the familiar Materia Grid entirely as data:

- planner node creates JSON `{ tasks: [...] }`
- `Build` node works on current task item
- `Auto-Eval` node returns JSON `{ passed, feedback, missing }`
- `Maintain` node records jj/git description/commit
- pass/fail routing is configured via JSON conditions
- task advancement is configured on `Maintain` success with `advance.when`

The framework source should not contain those names or behaviors.

Acceptance:
- Editing only `config/default.json` can substantially change the workflow.
- A user can replace the whole grid with unrelated nodes and the engine still works.

### 22. Update docs around generic Materia Grids — Done

README should show:

Minimal hello-world grid:

```json
{
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

And explain:
- prompts are templates
- outputs can be text or parsed JSON
- edges are condition-driven
- state assignment is explicit
- loops need limits

Acceptance:
- Users understand pi-materia as a generic graph runtime, not a hardcoded software-development loop.
