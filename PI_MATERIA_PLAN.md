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
- Current runtime supports the default sequential grid shape: planner -> builder -> evaluator, with evaluator `passed` linking to maintainer or `end`, and `failed` linking back to builder.
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
- [ ] Track current task title/description in `MateriaRunState`.
- [ ] Show task title in widget/status, e.g. `task: 2 - Add movement/input`.
- [ ] Include task title in artifact filenames or task metadata files.

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
- `agent_end` transitions the state machine and sends builder/evaluator/maintainer prompts as normal user messages.
- `before_agent_start` augments the active system prompt with the current Materia role instructions.
- `context` replaces the model-visible conversation for active Materia turns with an isolated per-role context plus the current role turn/tool-loop messages.
- Role tool scopes are approximated with `pi.setActiveTools()`.
- Artifacts now include `manifest.json` linking phases/tasks to native Pi session entry ids and context artifacts.
- Each role turn writes the exact isolated model-visible context/prompt under `contexts/` before triggering the turn.

## Phase 4: Maintenance and VCS Policy

### 8. Maintain more frequently

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

### 9. Maintainer commits automatically when satisfied

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

### 10. Detect jj and use jj instead of git

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

1. Config loading from external path and artifact directory separation.
2. Token/cost aggregation with live widget display and budget limits.
3. Structured pipeline config replacing hardcoded roles.
4. Status widget and event log.
5. `/materia grid` pipeline visualization.
6. Maintainer after each passed task.
7. VCS adapter with jj/git detection.
8. Automatic maintainer commit decision.
9. Context artifact capture for isolated role turns. — implemented
10. Per-role model/thinking/tool settings.
11. Advanced graph edge conditions.

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
