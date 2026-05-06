# Materia agent turn lifecycle and failure-surface audit

This audit traces the current Pi-native Materia execution paths in `src/native.ts`/`src/index.ts` for long-turn compaction recovery work.

## Lifecycle paths

### Normal agent node turn

1. `/materia cast` resolves config/pipeline in `src/index.ts` and calls `startNativeCast()`.
2. `startNativeCast()` initializes `MateriaCastState` as active, awaiting an agent response, writes run artifacts/state, then calls `startNode()` for the entry node.
3. `startNode()` performs node-start mutations (see below), applies materia model/tool scope, then calls `sendMateriaTurn()` with `buildNodePrompt()`.
4. `sendMateriaTurn()` writes a context artifact, appends a manifest entry, sends visible metadata, appends a `pi-materia-context` entry, and sends the hidden `pi-materia-prompt` with `{ triggerTurn: true }`.
5. Pi fires `before_agent_start`; Materia injects the active materia prompt.
6. Pi fires `context`; Materia replaces visible history with isolated synthetic context plus the active Materia prompt slice.
7. Pi fires `agent_end`; `handleAgentEnd()` finds the latest assistant entry, records text/error/usage, marks the state no longer awaiting, and either:
   - calls `completeNode()` for a normal agent node, or
   - records a multi-turn refinement instead of completing the node.
8. `completeNode()` records output, parses JSON if configured, applies assignments/advance, emits `node_complete`, checks budget, then `advanceToNode()` either starts the next node or `finishCast()`.

### Multi-turn refinement turn

1. A multi-turn agent node starts through the same `startNode()` path as a normal node.
2. On `agent_end`, `handleAgentEnd()` sees `isMultiTurnResolvedAgentNode(node)` and `multiTurnFinalizing !== true`.
3. It calls `recordMultiTurnRefinement()`, which increments the refinement counter and writes the refinement artifact/manifest.
4. State is changed to `nodeState = "awaiting_user_refinement"`, `awaitingResponse = false`; the graph does not advance.
5. User follow-up causes Pi to start another turn. In `before_agent_start`, if state is `awaiting_user_refinement`, `prepareMultiTurnRefinementTurn()` applies materia model settings, flips state back to `awaiting_agent_response`, writes a `context_refinement` artifact/event, saves state, and lets Pi run using the user's prompt plus Materia isolated context.
6. The next `agent_end` repeats the refinement-recording path until the user runs `/materia continue`.

### Multi-turn finalization turn

1. `/materia continue` loads state and calls `continueNativeCast()`.
2. If `nodeState === "awaiting_user_refinement"`, `startMultiTurnFinalizationTurn()` applies materia model settings, sets `awaitingResponse = true`, `nodeState = "awaiting_agent_response"`, and `multiTurnFinalizing = true`.
3. It sends `buildMultiTurnFinalizationPrompt()` through `sendMateriaTurn()`.
4. On `agent_end`, `handleAgentEnd()` captures `wasAwaitingFinalization`, clears `multiTurnFinalizing`, and calls `completeNode(..., { finalizedMultiTurn: true })`.
5. `completeNode()` then records final output, parses/assigns/advances, and proceeds like a normal node completion.

## Incomplete-turn failure surfaces

Current behavior only handles failures visible as an assistant message:

- `handleAgentEnd()` calls `findLatestAssistantEntry()` after the previous processed entry.
- If no assistant entry exists, it returns without changing state. The cast remains `active` and `awaitingResponse`, but there is no retry, failure event, or diagnostic.
- If the assistant message has `stopReason === "error"`, `assistantErrorMessage()` converts `errorMessage` into `Pi agent turn failed for node ...`; the catch block immediately fails the cast.
- The same immediate-fail path is used for parse errors, artifact write errors, budget-limit errors, assignment/edge errors, and any error thrown while recording a refinement/finalization result.

Relevant context-window/token-limit surfaces for recovery classification:

- Provider/Pi may append an assistant error message (`stopReason: "error"`) whose text mentions context overflow, context length/window, max tokens, token limit, input too long, request too large, or equivalent provider messages. Today these are not distinguished from non-recoverable provider errors.
- Provider/Pi may abort before writing a usable assistant entry. Today `handleAgentEnd()` silently leaves the cast awaiting response.
- Pi auto-compaction is enabled at the Pi layer and can recover overflow before Materia sees a failure, but Materia currently does not observe compaction start/end or force compaction.
- `ctx.compact(options)` is available in extension contexts and can trigger compaction with completion/error callbacks; `session_before_compact` and `session_compact` events can be observed for proactive compaction telemetry.

## Node-start/state mutations unsafe to repeat during same-node recovery

A full `startNode()` call is not a safe retry primitive once a turn has been sent:

- `setCurrentItem()` mutates foreach state: initializes cursor, writes `state.data.item` and the loop alias, and sets `currentItemKey/currentItemLabel`; on empty loops it can advance to the foreach `done` target.
- `enforceNodeLimit()` increments `state.visits[node.id]`; retrying would consume visits and change artifact paths/refinement identity keys.
- `startTaskAttempt()` increments `taskAttempts` keyed by node/item and updates `runState.attempt`; retrying would create duplicate attempts for the same logical turn.
- `startNode()` rewrites phase/current materia/current task/node state and emits another `node_start` event.
- Utility nodes execute side effects immediately; recovery should target incomplete agent turns only, not re-run utility commands.
- `completeNode()` applies non-idempotent completion mutations: output artifacts, JSON artifacts, assignments into `state.data`, foreach cursor advancement via `applyAdvance()`, edge traversal increments in `selectNextTarget()`, and graph advancement through `advanceToNode()`.
- `recordMultiTurnRefinement()` increments `multiTurnRefinements`; retrying after an incomplete refinement turn must happen before this path, not by replaying a partially recorded refinement.
- `startMultiTurnFinalizationTurn()` and `prepareMultiTurnRefinementTurn()` also mutate awaiting/finalizing flags and materia-model usage entries; retries should preserve the active mode rather than re-entering these setup functions blindly.

## Implementation notes for same-node recovery

Integrate recovery at the incomplete agent-turn boundary, before `completeNode()` or `recordMultiTurnRefinement()` mutates successful output state:

1. Add a recovery classifier used by `handleAgentEnd()` when `assistantErrorMessage()` is present and by the no-assistant-entry path when Pi reports/records an incomplete turn. Classify context-window/token-limit failures as recoverable; all other errors remain fail-fast.
2. Add a same-node recovery handler that operates on the existing active state without calling `startNode()`. Key retry counters by mode (`normal`, `refinement`, `finalization`), node id, current foreach item key, and visit/refinement turn as applicable.
3. For context-window recovery, call `ctx.compact({ customInstructions, onComplete, onError })` or an awaitable wrapper around it, record structured recovery events, then regenerate the prompt from saved state:
   - normal: `buildNodePrompt(state, node)`
   - finalization: `buildMultiTurnFinalizationPrompt(state, node)` with `multiTurnFinalizing === true`
   - refinement: prepare/send the refinement continuation prompt/context without incrementing refinement counters
4. Retry by saving state and calling `sendMateriaTurn()` directly, not `startNode()`/`continueNativeCast()`.
5. If compaction fails or retry limit is exhausted, fail via a clear cast failure event explaining whether the cause was non-recoverable, compaction failure, or exhausted same-node retries.
6. Observe Pi compaction events (`session_before_compact`, `session_compact`) and `ctx.compact()` callback failures to emit Materia warnings without corrupting node execution state.
