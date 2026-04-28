# pi-materia Next Features Plan

This plan turns the first test feedback into a staged roadmap for pi-materia, a Pi extension for configurable agent pipelines.

## Goals

pi-materia should become a configurable, observable Pi pipeline runtime where each pipeline node can run an agent role, report progress/cost, expose its work, and hand off to maintainer checkpoints safely.

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
- **Summon Materia**: specialized subagents invoked for focused tasks.
- **Mastered Materia**: a reusable, validated pipeline or role preset.

Initial command naming should prefer `/materia` as the main namespace:

```text
/materia run "build auth"
/materia grid
/materia loadout
/materia runs
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
- Existing `/materia run <task>` behavior works as the only run command.
- Pipeline can be modified by editing JSON only.

Implementation notes:
- Added `pipeline.entry` and `pipeline.nodes` to the default loadout.
- Slots now reference roles by name instead of the runtime directly calling hardcoded role keys.
- Removed `commitCommand` from the config schema; VCS behavior now belongs in maintainer role prompts.
- Added separate `jjMaintainer` and `gitMaintainer` roles.
- The bundled default currently uses `jjMaintainer` for faster local iteration.
- Added pipeline validation with friendly errors for missing slots, missing roles, and unsupported links.
- Current runtime supports the default sequential grid shape: planner -> builder -> evaluator, with evaluator `passed` linking to maintainer or `end`, and `failed` linking back to builder.
- Added `config/default.json` as the bundled default loadout that is used when no explicit or project config exists.

## Phase 2: Observability, Token Budgeting, and Visual Feedback

### 3. Token and cost reporting for safe testing

Problem: pi-materia runs multiple subagents, so token usage can climb quickly during test loops.

Tasks:
- [x] Capture usage from subagent events/messages where Pi exposes it.
  - Current implementation reads usage from assistant `done`/`error` message update events when available.
  - Needs real-run verification against provider/event shapes.
- [x] Aggregate per:
  - run
  - node/role
  - task
  - attempt
- [x] Show live totals in the pi-materia widget.
- [x] Write incremental totals to `usage.json` after every observed subagent usage event.
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
- [x] End of run reports total tokens and per-agent breakdown in the UI.
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
  - last emitted subagent message summary
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
- [x] Append fine-grained subagent lifecycle/tool events to `events.jsonl`.
  - Captures turn start/end, message start/end, tool start/update/end, and agent end.
- [ ] Consider per-task maintenance artifact names once maintainer can run after each task.

Acceptance:
- [x] A pi-materia cast can be debugged after the fact from artifacts alone for the current pipeline.
- [ ] Confirm artifact completeness with a real failed cast and a real successful cast.

## Phase 2.5: Real-Run Feedback Fixes

Feedback from a real `/materia run` test building a Rust/Bevy Snake clone exposed several integration gaps. These should be addressed before deeper Phase 3 work.

### A. Surface subagent output in the main Pi conversation pane

Problem: the `last:` widget line is too small and does not give useful visibility into planner/builder/evaluator work.

Actions:
- [x] Investigate Pi extension APIs for appending/displaying custom entries in the main transcript during a cast.
  - Initial implementation used `pi.sendMessage(..., { deliverAs: "nextTurn" })`, but that did not surface during real casts.
  - Changed mirror messages to plain displayed `pi.sendMessage(...)` calls and also persist `pi-materia-mirror` entries for debugging.
- [x] Mirror planner output into the main pane as planning progress.
- [x] Mirror builder summaries/tool activity/code-change summaries into the main pane.
- [x] Mirror evaluator results into the main pane.
- [x] Keep the widget as compact status only; use the main pane for readable narrative/progress.
- [ ] Verify whether mirrored custom messages should be excluded from future LLM context or rendered via a custom renderer/entry type.

Acceptance:
- [x] During long-running builds/tool calls, the user can see useful progress in the main Pi window without opening artifacts.
- [ ] Real-run test confirms the transcript volume is useful and not too noisy.

### B. Fix token/cost tracking

Problem: real run showed tokens/cost stuck at zero.

Actions:
- [ ] Inspect actual subagent event payloads from a real run and identify where Pi exposes usage for subagent sessions.
- [ ] If usage is only available from session stats or persisted session entries, read it from there instead of relying only on streaming `done`/`error` events.
- [ ] Add diagnostic logging for usage extraction during development.
- [ ] Update widget and `usage.json` from the confirmed source of truth.

Acceptance:
- Widget token/cost numbers update during or immediately after each subagent turn.
- Final `usage.json` matches Pi's own session/sub-session totals.

### C. Make role work resumable/inspectable as Pi sessions

Problem: Materia subagent work currently uses in-memory sessions, so runs are not resumable through Pi.

Actions:
- [ ] Replace or augment `SessionManager.inMemory()` with persisted per-role/per-task sessions under the cast artifact directory or Pi session store.
- [ ] Record each sub-session id/path in `events.jsonl` and a run manifest.
- [ ] Add a command to inspect sessions, e.g. `/materia inspect <cast-id> <slot/task/attempt>`.
- [ ] Decide whether a Materia cast itself should be represented as a parent Pi session with child sessions.

Acceptance:
- The user can resume or inspect planner/builder/evaluator/maintainer work using Pi-native session tooling.

### D. Bootstrap/checkpoint target projects for jj and artifacts

Problem: default maintainer is `jjMaintainer`, but new target repos may not be initialized for jj. Materia artifacts were captured by VCS.

Actions:
- [ ] Add a bootstrap step at cast start.
- [ ] If the default/configured maintainer is jj-based and no jj repo exists, initialize or ask to initialize jj.
- [ ] Ensure target `.gitignore` or VCS ignore rules exclude `.pi/pi-materia/` artifacts.
- [ ] Consider adding a `/materia bootstrap` command for explicit setup.

Acceptance:
- New target projects do not accidentally commit Materia runtime artifacts.
- jj maintainer can checkpoint work even when the prompt did not mention jj.

### E. Improve task labels and descriptions in UI/artifacts

Problem: widget showed `task: 2`; task ids alone are not meaningful.

Actions:
- [ ] Track current task title/description in `MateriaRunState`.
- [ ] Show task title in widget/status, e.g. `task: 2 - Add movement/input`.
- [ ] Include task title in artifact filenames or task metadata files.

Acceptance:
- User can tell which planned task is active without opening `plan.json`.

### F. Realtime elapsed/progress updates during long tool calls

Problem: elapsed time only updates between lifecycle events, and status stayed on `starting` during long installs/compiles.

Actions:
- [ ] Add a timer while a cast is active to refresh the widget elapsed time every second or few seconds.
- [ ] Capture and display tool execution start/update/end events in the widget.
- [ ] Show active tool name/command summary, especially long `bash` commands.
- [ ] Surface long-running tool output summaries in the main pane if possible.

Acceptance:
- During a long compile/install, elapsed time continues ticking and the active command/tool is visible.

### G. Integrate Materia more tightly with Pi's harness model

Problem: Materia feels like invisible subagents instead of a coordinated pipeline integrated with Pi.

Actions:
- [ ] Investigate whether a Materia role can run as the active Pi session/agent instead of hidden subagent sessions.
- [ ] Explore a coordinator mode where Materia injects prompts/steering into Pi-native sessions and records transitions.
- [ ] Decide on architecture: hidden subagents + mirrored transcript vs Pi-native session orchestration.

Acceptance:
- Materia feels like a first-class Pi workflow, not a black-box extension.

## Phase 3: Native Pi Session Orchestration

Strategic direction: Materia should become a Pi-native workflow/state-machine orchestrator, not a hidden subagent framework. The active Pi session should do the planner/builder/evaluator/maintainer work so rendering, scrolling, tool output, token accounting, and resumability come from Pi itself.

### 7. Redesign lifecycle around the active Pi session

Problem: current implementation runs roles via hidden `createAgentSession()` calls, then mirrors output back into the main pane. This loses native rendering, native tool display, accurate token/cost accounting, and resumability.

Target architecture:

```text
/materia run <request>
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

- [ ] Define a `MateriaCastState` persisted via `pi.appendEntry()` and restored from session entries on resume.
- [ ] Track:
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
- [ ] Add helpers:
  - `loadActiveCastState(ctx.sessionManager)`
  - `saveCastState(pi, state)`
  - `clearCastState(pi, state)`

Acceptance:
- A cast can survive Pi restart/session reload and know where it left off.

#### 7.2 Replace `runRole()` subagent calls with active-session prompt injection

- [ ] Stop using hidden `createAgentSession()` for the main runtime path.
- [ ] Keep old subagent runner temporarily behind an internal fallback flag if needed.
- [ ] Introduce prompt builders:
  - `buildPlannerPrompt(request, config)`
  - `buildBuilderPrompt(task, attempt, feedback, config)`
  - `buildEvaluatorPrompt(task, buildSummary, config)`
  - `buildMaintainerPrompt(config)`
- [ ] Use `pi.sendUserMessage()` or `pi.sendMessage(..., { triggerTurn: true })` to start the next active Pi turn.
- [ ] Ensure prompts include the active role/system-like instructions since per-turn system prompt swapping may not be available.

Acceptance:
- Planner/builder/evaluator/maintainer output appears as normal Pi assistant/tool output, not mirrored custom messages.

#### 7.3 Drive transitions from Pi lifecycle events

- [ ] Register `pi.on("agent_end", ...)` handler.
- [ ] When a Materia cast is active, inspect the final assistant output for the current phase.
- [ ] Transition state:
  - planning -> parse `PlanResult`, write `plan.json`, start first builder turn
  - building -> record build summary, start evaluator turn
  - evaluating -> parse `EvaluationResult`, branch passed/failed
  - maintaining -> record maintainer result, complete cast
- [ ] Guard against double-processing by tracking last processed entry/message id.
- [ ] Persist state before sending each next prompt.

Acceptance:
- Materia advances automatically after each active Pi turn.

#### 7.4 Manage tools/role behavior per phase

Problem: roles currently configure tool access and system prompts independently. Active-session orchestration needs equivalent behavior.

Options to investigate:
- [ ] Use `pi.setActiveTools()` before each phase to approximate role tool scopes.
- [ ] Include role `systemPrompt` as explicit instructions in each injected prompt.
- [ ] Investigate whether Pi supports temporary system prompt/context injection through extension lifecycle hooks.
- [ ] If needed, add a `roleMode` config field documenting that active-session roles are prompt-scoped, not isolated system prompts.

Acceptance:
- Planner/evaluator can be constrained to read-only tools; builder/maintainer get coding tools.

#### 7.5 Use Pi-native token/cost/session accounting

- [ ] Remove custom subagent token accounting from the main active-session path.
- [ ] Read totals from Pi session stats/context if needed for Materia widgets/artifacts.
- [ ] Continue writing `usage.json`, but source it from Pi-native session data.
- [ ] Keep budget enforcement, but check it after each turn using Pi's actual usage totals.

Acceptance:
- Materia token/cost numbers match Pi footer/session info.

#### 7.6 Artifact model for active-session orchestration

- [ ] Continue writing:
  - `config.resolved.json`
  - `events.jsonl`
  - `usage.json`
  - `plan.json`
  - `tasks/<task-id>/build-<attempt>.md`
  - `tasks/<task-id>/eval-<attempt>.json`
  - `maintenance/final.md`
- [ ] Store references to Pi session entries/message ids for each artifact.
- [ ] Add a `manifest.json` mapping Materia phases/tasks to Pi entries.

Acceptance:
- Artifacts can be correlated directly with native Pi transcript entries.

#### 7.7 User controls for active casts

- [ ] Add `/materia status` to show active cast state.
- [ ] Add `/materia abort` to stop/clear active cast state.
- [ ] Add `/materia continue` to resume from persisted state and send the next prompt if needed.
- [ ] Add `/materia runs` later for artifact discovery.

Acceptance:
- User can inspect, stop, and resume Materia's state machine explicitly.

#### 7.8 Migration/deprecation of mirrored subagent path

- [ ] Keep current mirrored subagent implementation only until active-session orchestration is working.
- [ ] Once active-session runtime is stable, remove or demote subagent mode to an advanced optional mode.
- [ ] Update README to describe Materia as a Pi-native workflow orchestrator.

Acceptance:
- Default Materia runtime no longer creates hidden subagent sessions.

## Phase 4: Subagent Inspection / Advanced Multi-Session Mode

### 8. Ability to jump into/watch a subagent

Problem: subagents run invisibly.

Possible approaches:

A. Streaming mirror in main session:
- Subscribe to subagent `message_update` events.
- Mirror current subagent text into the pi-materia widget or a custom message renderer.
- Add config option `streamSubagents: true | false`.

B. Persist each subagent as its own Pi session:
- Replace `SessionManager.inMemory()` with per-role persisted sessions under artifact dir.
- Add `/materia inspect <cast-id> <slot/task/attempt>` or print the session file path.
- User can resume/watch/debug that subagent session separately.

Recommended implementation:
- Start with A for immediate visibility.
- Add B after artifact/session model is stable.

Acceptance:
- User can see what the active subagent is saying/doing in near real time.
- User can find the subagent session/artifacts for deeper inspection.

## Phase 5: Maintenance and VCS Policy

### 9. Maintain more frequently

Problem: maintainer only runs at the end.

Tasks:
- Add `maintainPolicy` config:
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
- Default next version should be `afterEachTask`.

Acceptance:
- Maintainer runs after each task passes evaluation.

### 10. Maintainer commits automatically when satisfied

Problem: maintainer asks user instead of deciding.

Tasks:
- Maintainer evaluates repo state and decides whether to commit.
- Require maintainer to return JSON:
  ```json
  { "satisfied": true, "commitMessage": "...", "reason": "..." }
  ```
- If satisfied, extension executes commit command itself.
- If not satisfied, maintainer explains why and pipeline either loops or stops based on config.

Acceptance:
- No confirmation prompt is required by default.
- User can opt into confirmation with `confirmBeforeCommit: true`.

### 11. Detect jj and use jj instead of git

Tasks:
- Detect VCS:
  - if `.jj/` exists or `jj root` succeeds, use jj
  - else if `git rev-parse --show-toplevel` succeeds, use git
- Implement VCS adapter:
  - `status()`
  - `diff()`
  - `commit(message)`
- jj commit strategy:
  - use `jj status`
  - use `jj diff`
  - use `jj commit -m <message>`
- git commit strategy:
  - `git add -A`
  - `git commit -m <message>`

Acceptance:
- In jj repos, pi-materia never runs git commit.
- In git repos, pi-materia uses git.

## Phase 6: Safer Graph Execution

### 11. Configurable edge conditions and loop limits

Tasks:
- Move evaluator pass/fail logic into graph edge conditions.
- Add per-edge and per-node max loop counts.
- Detect infinite loops and stop with a clear error.

Acceptance:
- Graphs can express retry loops safely.

### 12. Per-agent model/thinking/tool settings

Tasks:
- Extend role config:
  ```json
  {
    "model": "anthropic/claude-sonnet-4-5",
    "thinking": "medium",
    "tools": ["read", "grep", "find", "ls"]
  }
  ```
- Resolve model per subagent, falling back to active Pi model.

Acceptance:
- Planner/evaluator can use cheaper/read-only settings while builder uses stronger coding settings.

## Proposed Implementation Order

1. Config loading from external path and artifact directory separation.
2. Token/cost aggregation with live widget display and budget limits.
3. Structured pipeline config replacing hardcoded roles.
4. Status widget and event log.
5. `/materia grid` pipeline visualization.
6. Maintainer after each passed task.
7. VCS adapter with jj/git detection.
8. Automatic maintainer commit decision.
9. Subagent streaming mirror.
10. Persisted subagent sessions and jump/open commands.
11. Advanced graph edge conditions and per-agent model settings.

## Near-Term Commands to Add

- `/materia run <task>`: run the configured pipeline.
- `/materia grid`: show resolved config and graph.
- `/materia loadout`: show resolved config details.
- `/materia runs`: list recent cast artifact directories.
- `/materia inspect <cast-id>`: show paths/details for a prior cast.
- `/materia tail <cast-id>`: tail events from a prior cast.

## Open Design Questions

- Should subagents use the same active model by default, or should roles define defaults?
- Should maintainer commit extension code/config changes by default, or only target-project changes?
- Should failed maintenance send control back to builder, evaluator, or stop?
- Should pi-materia support parallel branches later, or stay sequential initially?
