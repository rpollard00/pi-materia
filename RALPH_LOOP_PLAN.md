# Materia Works Next Features Plan

This plan turns the first test feedback into a staged roadmap for Materia Works, a Pi extension for configurable agent pipelines.

## Goals

Materia Works should become a configurable, observable Pi pipeline runtime where each pipeline node can run an agent role, report progress/cost, expose its work, and hand off to maintainer checkpoints safely.

## Naming and Metaphor Architecture

Materia Works uses a materia-inspired metaphor for pluggable agent pipelines:

- **Materia Works**: the overall Pi extension/framework.
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

Legacy `/ralph` commands can remain temporarily as aliases during migration, but user-facing docs and config should use Materia Works terminology.

## Phase 1: Configuration and Runtime Separation

### 1. Load extension/config from outside the target project

Problem: testing the loop from the plugin repo pollutes the plugin working directory.

Tasks:
- Support a `--materia-config` extension flag or `MATERIA_CONFIG` env var.
- Resolve config in this order:
  1. explicit flag/env path
  2. target cwd `.pi/materia-works.json`
  3. extension package default config
- Store cast artifacts in the target project by default, but support `artifactDir` in config.
- Document running Pi with the extension from another path:
  ```bash
  pi -e /path/to/materia-works/.pi/extensions/materia-works/index.ts
  ```

Acceptance:
- Can run Materia Works against any repo without writing runtime files into the extension repo.
- Config path and artifact directory are shown at run start.

### 2. Replace hardcoded agents with JSON pipeline config

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
          "role": "maintainer",
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
- Existing `/materia run <task>` behavior works, with `/ralph <task>` temporarily available as a migration alias.
- Pipeline can be modified by editing JSON only.

## Phase 2: Observability, Token Budgeting, and Visual Feedback

### 3. Token and cost reporting for safe testing

Problem: Materia Works runs multiple subagents, so token usage can climb quickly during test loops.

Tasks:
- Capture usage from subagent events/messages where Pi exposes it.
- Aggregate per:
  - run
  - node/role
  - task
  - attempt
- Show live totals in the Materia Works widget.
- Write incremental totals to `usage.json` after every subagent turn.
- Include model/provider/thinking level in usage report.
- Add configurable safety limits:
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
- Warn when budget crosses `warnAtPercent`.
- Stop or ask for confirmation when the limit is reached, depending on config.

Acceptance:
- Live widget shows token/cost totals during a run.
- End of run reports total tokens and per-agent breakdown.
- Tests can be bounded by token/cost limits to avoid runaway loops.

### 4. Rich progress feedback

Problem: current UI only shows messages like `building 1`, `building 2`.

Tasks:
- Add a live status widget using `ctx.ui.setWidget()`.
- Display:
  - run id
  - current node
  - current role
  - current task
  - attempt count
  - elapsed time
  - last emitted subagent message summary
  - token/cost totals if available
- Update widget at each lifecycle event.

Acceptance:
- User can tell what Materia Works is doing without opening logs.

### 5. Visualize loaded pipeline/config

Tasks:
- Add `/materia grid` command.
- Render configured graph as text/ASCII:
  ```text
  planner -> builder -> evaluator
                         | passed -> maintainer
                         | failed  -> builder
  maintainer -> planner
  ```
- Show roles, tools, max attempts, artifact dir, maintain policy.

Acceptance:
- Before running, user can inspect exactly what Materia Works will execute.

### 6. Better artifact/log structure

Tasks:
- Store structured event log:
  - `events.jsonl`
  - `config.resolved.json`
  - `plan.json`
  - `tasks/<task-id>/build-<attempt>.md`
  - `tasks/<task-id>/eval-<attempt>.json`
  - `maintenance/<task-id>.md`
- Append every state transition to `events.jsonl`.

Acceptance:
- A Materia Works cast can be debugged after the fact from artifacts alone.

## Phase 3: Subagent Inspection

### 7. Ability to jump into/watch a subagent

Problem: subagents run invisibly.

Possible approaches:

A. Streaming mirror in main session:
- Subscribe to subagent `message_update` events.
- Mirror current subagent text into the Materia Works widget or a custom message renderer.
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
- In jj repos, Materia Works never runs git commit.
- In git repos, Materia Works uses git.

## Phase 5: Safer Graph Execution

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
- Should Materia Works support parallel branches later, or stay sequential initially?
