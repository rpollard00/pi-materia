# Materia agent turn lifecycle and failure-surface audit

This audit traces the current Pi-native Materia execution paths in `src/castRuntime.ts`/`src/runtime/nativeLifecycle.ts` for bounded same-socket recovery. Automatic recovery is no longer limited to context-window failures: context-window recovery is one specialized mode, and safe generic agent-turn failures use the same bounded retry primitive without compaction.

## Lifecycle paths

### Normal agent socket turn

1. `/materia cast` resolves config/pipeline in `src/index.ts` and calls `startNativeCast()`.
2. `startNativeCast()` initializes `MateriaCastState` as active, awaiting an agent response, writes run artifacts/state, then calls `startSocket()` for the entry socket.
3. `startSocket()` performs socket-start mutations (see below), applies materia model/tool scope, then calls `sendMateriaTurn()` with `buildSocketPrompt()`.
4. `sendMateriaTurn()` writes a context artifact, appends a manifest entry, sends visible metadata, appends a `pi-materia-context` entry, and sends the hidden `pi-materia-prompt` with `{ triggerTurn: true }`.
5. Pi fires `before_agent_start`; Materia injects the active materia prompt.
6. Pi fires `context`; Materia replaces visible history with isolated synthetic context plus the active Materia prompt slice.
7. Pi fires `agent_end`; `handleAgentEnd()` finds the latest assistant entry, records text/error/usage, and either attempts safe recovery, records a multi-turn refinement, or completes the socket.
8. `completeSocket()` records output, parses JSON if configured, applies the generic handoff envelope/assignments/advance, emits `socket_complete`, checks budget, then `advanceToSocket()` either starts the next socket or `finishCast()`.

### Multi-turn refinement turn

1. A multi-turn agent socket starts through the same `startSocket()` path as a normal socket.
2. On `agent_end`, `handleAgentEnd()` sees `isMultiTurnResolvedAgentSocket(socket)` and `multiTurnFinalizing !== true`.
3. It calls `recordMultiTurnRefinement()`, which increments the refinement counter and writes the refinement artifact/manifest.
4. State is changed to socket state (`currentSocketState` legacy DTO field) = `"awaiting_user_refinement"`, `awaitingResponse = false`; the graph does not advance.
5. User follow-up causes Pi to start another turn. In `before_agent_start`, if state is `awaiting_user_refinement`, `prepareMultiTurnRefinementTurn()` applies materia model settings, flips state back to `awaiting_agent_response`, writes a `context_refinement` artifact/event, saves state, and lets Pi run using the user's prompt plus Materia isolated context.
6. The next `agent_end` repeats the refinement-recording path until the user runs `/materia continue`.

### Multi-turn finalization turn

1. `/materia continue` loads state and calls `continueNativeCast()`.
2. If socket state (`currentSocketState` legacy DTO field) is `"awaiting_user_refinement"`, `startMultiTurnFinalizationTurn()` applies materia model settings, sets `awaitingResponse = true`, socket state (`currentSocketState` legacy DTO field) to `"awaiting_agent_response"`, and `multiTurnFinalizing = true`.
3. It sends `buildMultiTurnFinalizationPrompt()` through `sendMateriaTurn()`.
4. On `agent_end`, `handleAgentEnd()` captures `wasAwaitingFinalization`, clears `multiTurnFinalizing`, and calls `completeSocket(..., { finalizedMultiTurn: true })`.
5. `completeSocket()` then records final output, parses/assigns/advances, and proceeds like a normal socket completion.

## Current incomplete-turn recovery surfaces

Recovery is attempted only while an active agent socket is still awaiting the same turn and before successful output state has been committed:

- Assistant error entries (`stopReason === "error"`) are classified before terminal failure. Context-window/token-limit messages become `context_window`; plain WebSocket transport failures become `transient_transport`; other errors can become `turn_failure` only at lifecycle call sites that explicitly opt in because the current turn is safe to resend.
- `agent_end` failures with no usable assistant entry use the same classification path. Transient WebSocket failures preserve awaiting state; safe generic failures attempt bounded `turn_failure` recovery.
- JSON parse and handoff validation failures for agent sockets are handled as pre-commit validation failures. They may attempt generic recovery after the raw output artifact exists, but before parsed JSON is recorded, before `applyGenericHandoffEnvelope()`, before assignments, before `applyAdvance()`, before `socket_complete`, before budget/route advancement, and before starting another socket.
- Context-window failures run the reason-specific recovery action: compact first, then retry.
- Generic `turn_failure` retries resend the saved active prompt directly without compaction, proactive compaction, `startSocket()`, visit increments, cursor advancement, or a new task attempt.
- Recovery uses the existing `same_socket_recovery_start`, `same_socket_recovery_retry`, `same_socket_recovery_retry_failed`, and `same_socket_recovery_exhausted` event family with a structured `reason`.

## Transient transport preservation

Plain WebSocket transport failures are intentionally distinct from same-socket retry. When such a failure is detected while awaiting an agent turn, Materia emits `transient_transport_turn_failure`, keeps the cast active/awaiting, and does not resend the prompt immediately. This avoids duplicating a provider request when the Pi transport may still complete or reconnect.

## Socket-start/state mutations unsafe to repeat during same-socket recovery

A full `startSocket()` call is not a safe retry primitive once a turn has been sent:

- `setCurrentItem()` mutates foreach state: initializes cursor, writes `state.data.item` and the loop alias, and sets `currentItemKey/currentItemLabel`; on empty loops it can advance to the foreach `done` target.
- `enforceSocketVisitLimit()` increments `state.visits[socket.id]`; retrying would consume visits and change artifact paths/refinement identity keys.
- `startTaskAttempt()` increments `taskAttempts` keyed by socket/item and updates `runState.attempt`; retrying would create duplicate attempts for the same logical turn.
- `startSocket()` rewrites phase/current materia/current task/socket state and emits another `socket_start` event.
- Utility sockets execute side effects immediately; automatic recovery targets incomplete agent turns only, not utility commands.
- `completeSocket()` applies non-idempotent completion mutations: output artifacts, JSON artifacts, assignments into `state.data`, foreach cursor advancement via `applyAdvance()`, edge traversal increments in `selectNextTarget()`, and graph advancement through `advanceToSocket()`.
- `recordMultiTurnRefinement()` increments `multiTurnRefinements`; retrying after an incomplete refinement turn must happen before this path, not by replaying a partially recorded refinement.
- `startMultiTurnFinalizationTurn()` and `prepareMultiTurnRefinementTurn()` also mutate awaiting/finalizing flags and materia-model usage entries; retries preserve the active mode rather than re-entering these setup functions blindly.

## Fail-fast boundaries

Automatic same-socket recovery is intentionally bounded and pre-commit only. It does not provide rollback. The following remain fail-fast or manually recoverable through `/materia recast` where appropriate:

- utility socket execution or utility output validation failures,
- assignment, generic handoff application, `applyAdvance()`, route selection, budget, or socket-complete failures after parsed output has been accepted,
- any failure after graph advancement, next-socket startup, or cast completion,
- broad catch blocks where the runtime cannot prove that no non-idempotent mutation occurred,
- classifications where generic retry was not explicitly enabled by the lifecycle boundary.

## Exhaustion and revive

Same-socket recovery has a small bounded allowance keyed to the logical turn context (mode/socket/item/visit/refinement identity), not to each error string. On exhaustion, Materia records `recoveryExhaustion` with `kind: "same_socket_recovery_exhausted"`, `reason: "context_window" | "turn_failure"`, the recovery key, attempt counts, revive allowance metadata, socket/item/mode details, and the terminal failure reason. `/materia revive [cast-id]` is available only when that structured exhaustion metadata matches the current failed cast. Revive increases the exhausted context's effective allowance by the original max-attempt value and then follows the normal `/materia recast` path. General failures without matching exhaustion metadata should use `/materia recast` instead.
