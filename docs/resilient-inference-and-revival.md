# Resilient Inference and Revival

**Status**: Implemented

This document covers pi-materia's resilient inference behavior — how provisional
agent errors are kept non-terminal so Pi can retry them natively — and the full
revival ecosystem: passive standalone revival, exhaustion-extending revival,
queued same-cast quest resumption, and the distinction between revive and recast.

## Table of Contents

1. [Provisional Agent Errors](#1-provisional-agent-errors)
2. [agent_settled Nudge Behavior](#2-agent_settled-nudge-behavior)
3. [Distinction Between Revive and Recast](#3-distinction-between-revive-and-recast)
4. [Passive Standalone Revival](#4-passive-standalone-revival)
5. [Exhaustion-Extending Revival](#5-exhaustion-extending-revival)
6. [Queued Same-Cast Quest Resumption](#6-queued-same-cast-quest-resumption)
7. [Parallel Branch Revival](#7-parallel-branch-revival)
8. [Implementation Reference](#8-implementation-reference)

---

## 1. Provisional Agent Errors

### 1.1 Motivation

Provider inference failures (model errors, rate limits, context window exceeded,
server errors) should never immediately terminalize a cast. Pi has its own native
retry, compaction, and follow-up mechanisms. pi-materia merely records the
interruption metadata and keeps the cast active, letting Pi's native loop handle
recovery.

### 1.2 Mechanism

When `handleAgentEnd` (src/runtime/agentLifecycle.ts) processes an agent end
event and the assistant's `stopReason` is `"error"`, or the event itself carries
a provider error with no successful assistant entry, it calls
`preserveAwaitingAfterInferenceInterruption` (src/runtime/turnRecovery.ts)
instead of `handleSameSocketRecoverableTurnFailure` + `failCast`.

The function records a bounded `inferenceInterruption` object on state, keeps the
cast active and awaiting a response, and emits only an `inference_interruption`
warning event — no `cast_end`, no `socket.failed`, no quest settlement.

```ts
state.inferenceInterruption = {
  error: errorMsg,
  entryId: options.entryId,
  socket: currentSocketId(state),
  materia: state.currentMateria,
  interruptedAt: Date.now(),
};
```

| Behaviour | Inference interruption | Terminal failure |
|---|---|---|
| Cast `active` | stays `true` | set to `false` |
| `awaitingResponse` | stays `true` | set to `false` |
| `socketState` | stays `awaiting_agent_response` | set to `failed` |
| `phase` | unchanged | set to `"failed"` |
| `failedReason` | not set | set to error message |
| `runState.endedAt` | not set | set to now |
| `inferenceInterruption` | set | not set |
| Manifest entry | none added | failed entry appended |
| Event emitted | `inference_interruption` (warning) | `cast_end ok:false` |
| UI notification | warning toast | error notification |
| Next action | Pi native retry/compaction continues | Requires `/materia recast` or revive |

### 1.3 Structural Matching

The interruption path uses structural matching rather than provider-specific
message allowlists:

- **`stopReason === "error"`** — The model itself reported an error
  (e.g. `server_error`, `context_length_exceeded`).
- **Event-level provider failure** — The event entry has error/errorKind fields
  and there is no assistant text (e.g. `invalid_request_error`,
  `provider auth failed`).

Transport-level transient failures (WebSocket drops, `Stream ended without
finish_reason`) route to `preserveAwaitingAfterTransientTransportFailure` instead,
which emits a `transient_transport_turn_failure` event. This separation lets
bounded recovery (JSON repair, missing tool commit, handoff validation) remain
distinct from inference and transport paths.

### 1.4 Tool Scope Restoration

On the next Pi turn after an inference interruption,
`prepareAgentStartSystemPrompt` (src/runtime/agentLifecycle.ts) re-applies the
active socket's tool scope via `updateSocketToolScope` when
`state.inferenceInterruption` is set. This ensures Pi's native retry/compaction
has the correct tool definitions.

### 1.5 Interruption Clearing

When a subsequent `handleAgentEnd` call succeeds (the cast completes normally),
`state.inferenceInterruption` is cleared to `undefined` before finalization.
This covers both single-turn and multi-turn success paths.

---

## 2. agent_settled Nudge Behavior

### 2.1 Motivation

Pi emits `agent_settled` when it finishes processing a user turn without
producing a new assistant response — for example, when Pi decides the provider
error cannot be retried automatically and stops. If an unresolved inference
interruption exists at that point, the cast should remain active and awaiting,
and the user should be nudged to try again.

### 2.2 Mechanism

`handleAgentSettled` (src/runtime/agentLifecycle.ts) is registered in
src/index.ts via `pi.on('agent_settled', ...)`. It checks for an active cast
with unresolved `state.inferenceInterruption` and, when found:

1. Keeps `state.active = true`, `state.awaitingResponse = true`, sets socket
   state to `awaiting_agent_response`.
2. Appends an `inference_interruption_settled` warning event with
   `nudgeNeeded: true` and the interruption's error/entryId/socket metadata.
3. Emits a `lifecycle.inference.settled_unresolved` lifecycle event so
   connected observers (e.g. agent_controller webhook) see the warning.
4. Updates UI status with a `"nudge"` suffix (e.g. "awaiting nudge after
   inference interruption: {error}").
5. Notifies the user with a warning: "pi-materia cast {id} awaiting user
   nudge after inference interruption."
6. Returns `true` so the caller knows settlement must be skipped; quest
   settlement only runs in the `agent_end` handler when `before.active &&
   !after.active`, which cannot fire while the cast stays active.

If there is no active cast or no unresolved interruption, `handleAgentSettled`
returns `false` and is a no-op.

### 2.3 End-to-End Flow

```
User sends message
  → provider error / stopReason === "error"
  → preserveAwaitingAfterInferenceInterruption
    → cast stays active/awaiting, inferenceInterruption set
  → Pi retries natively (tool scope restored via prepareAgentStartSystemPrompt)
  → Provider error persists
  → Pi settles (agent_settled)
  → handleAgentSettled: unresolved interruption detected
    → nudgeNeeded=true event, UI suffix "nudge", user notified
  → User nudges (sends any message)
  → before_agent_start → prepareAgentStartSystemPrompt re-applies tool scope
  → Agent succeeds
  → handleAgentEnd → inferenceInterruption cleared → normal completion
```

### 2.4 UI Status Display

`createMateriaCastStatusModel` (src/presentation/ui.ts) renders
"awaiting nudge after inference interruption: {error}" when
`state.inferenceInterruption` is set, in addition to the active nudge-suffix
status pushed by `handleAgentSettled`. This ensures the widget always shows
the interruption state even before `agent_settled` fires.

---

## 3. Distinction Between Revive and Recast

The two commands serve different purposes and are not interchangeable.

| Aspect | `/materia recast` | `/materia revive` |
|---|---|---|
| **Purpose** | Re-send the same prompt to the same socket. | Restore a failed/aborted cast to active state without necessarily re-sending a prompt. |
| **When to use** | The cast failed with no exhaustion metadata (ordinary failure). | The cast has exhaustion metadata (same-socket recovery exhausted, explicit retry edge exhausted) or you want a passive restore. |
| **Active prompt** | Reuses `state.activeTurnPrompt` when available to re-send the same prompt; otherwise re-starts the socket. | Passive path: does NOT dispatch inference; just normalizes state and waits for a nudge. Exhaustion paths: may advance to a blocked target or resume from exhausted socket. |
| **Attempt increment** | Does not exist for recast (same prompt, same socket). | Does not increment attempts. |
| **Event emitted** | `cast_recast` | `cast_revive` (with kind: "passive", "edge_traversal", or "same_socket_recovery") |
| **Lifecycle event** | None. | `lifecycle.cast.revived` (mapped to `runtime.accepted` in agent-controller preset) |
| **Quest linked** | Not applicable (quest runner does not call recast). | Revive handler queues quest-linked casts via unfailQuest + questQueuedResurrection instead of reviving. |

**Rule of thumb**: Use `/materia recast` for a normal failed cast you want to
immediately retry. Use `/materia revive` for a cast that exhausted its
recovery budget or one you want to restore without dispatching inference.

---

## 4. Passive Standalone Revival

### 4.1 Mechanism

When a cast failed without exhaustion metadata (`recoveryExhaustion` is
undefined), `reviveNativeCast` (src/runtime/castLifecycle.ts) runs the
**passive** path:

1. Loads the cast state by ID (throws if not found).
2. Asserts no other active cast exists.
3. Normalizes state: `active = true`, `phase` = socket id,
   `awaitingResponse` per socket type, socket state =
   `awaiting_agent_response` (agent) or `running_utility` (utility).
4. Clears `failedReason` and `runState.endedAt`.
5. Records a `cast_revive` event with `kind: "passive"`.
6. Re-initializes the event bus and starts heartbeat.
7. Saves state, updates UI status and widget.
8. Updates tool scope for agent sockets.
9. Emits `lifecycle.cast.revived` lifecycle event.
10. Notifies the user: "Use /materia recast to resend or nudge to continue."

**Critical**: The passive path does NOT dispatch any prompt. The cast becomes
active and awaiting a user nudge but Pi does not send a new materia turn. This
is intentional — the user can either nudge to continue (the next `agent_end`
handles the existing socket) or use `/materia recast` to resend the prompt.

### 4.2 Eligibility

Any failed/aborted cast qualifies for passive revival as long as:

- It has no `recoveryExhaustion` metadata.
- No other cast is currently active.
- It is not a quest-linked cast with a different active cast (those go through
  the queued resumption path — see §6).
- It does not carry `data.questQueuedResurrection` (dormant queued casts are
  hidden from `listRevivableCastStates`; they must be activated by the quest
  runner, not by /materia revive).

### 4.3 Standalone vs Quest-Linked

- **Standalone cast** (no `data.quest`): Revived passively. The cast reactivates
  at its last socket and awaits a user nudge.
- **Quest-linked cast with no active cast**: Falls through to passive revival
  (the quest-linking branch only activates when a *different* active cast is
  running).
- **Quest-linked cast with a different active cast**: The revive handler queues
  the quest via `unfailQuest` + `questQueuedResurrection` instead of reviving
  (see §6). This prevents interrupting the active cast.

---

## 5. Exhaustion-Extending Revival

### 5.1 Explicit Retry Edge Exhaustion

When a cast failed because an **explicit per-item retry edge** (`edge.maxTraversals`)
exhausted its scoped allowance, `reviveNativeCast` runs the **edge_traversal** path:

1. Calls `extendEdgeTraversalAllowanceForRevive` to extend **only the exhausted
   work item's** scoped allowance (`from->to@<itemKey>`) by its original
   configured limit. Other work items' allowances on the same edge are
   unaffected. Legacy persisted exhaustion metadata whose allowance was stored
   under the aggregate `from->to` key remains readable as a fallback.
2. Records `cast_revive` with exhaustion metadata.
3. Clears failure markers and advances directly to the **blocked target**
   socket instead of resending the completed source socket prompt.
4. Starts the blocked target socket, which may dispatch a prompt.

This is useful for loops that legitimately need more iterations of one work
item before reaching an exit condition. Ordinary edges without an explicit
`maxTraversals` are unbounded and never produce this exhaustion; aggregate
`state.edgeTraversals` counts are diagnostic-only.

No-advance cycle exhaustion (`limits.maxNoAdvanceCycles`, the structural
fallback for unannotated stalled loops) is an ordinary cast failure without
structured exhaustion metadata — correct the loop structure and use
`/materia recast`, not revive. See [Workflow safety and resource limits](workflow-safety.md).

### 5.2 Same-Socket Recovery Exhaustion

When a cast failed because it exhausted same-socket recovery retries (too many
JSON repair attempts, too many timeout retries, etc.),
`reviveNativeCast` runs the **same_socket_recovery** path:

1. Calls `extendSameSocketRecoveryAllowanceForRevive` to increment the
   recovery-max-attempts allowance.
2. Records `cast_revive` with exhaustion metadata.
3. Calls `resumeValidatedNativeCast` which re-sends the prompt on the
   exhausted socket (like a recast, but with the extended budget).

### 5.3 Event Emissions

All three revival paths emit a `lifecycle.cast.revived` lifecycle event
registered in `src/eventing/presets.ts` with:
- `AGENT_CONTROLLER_FILTER.include` — the event type is included for webhook
  delivery.
- `AGENT_CONTROLLER_TYPE_MAP` → `runtime.accepted` — connected observers
  (agent_controller) receive the cast as accepted/active rather than failed.

---

## 6. Queued Same-Cast Quest Resumption

This is the most complex revival path, spanning the quest board, the revive
command handler, the cast lifecycle, and the quest runner.

### 6.1 Motivation

When a quest-launched cast fails and the user wants to retry, they should be
able to requeue the quest and let the quest runner reactivate the **same cast**
at its preserved socket, not launch a new cast. This preserves the work
context (socket, materia, current item) and avoids incrementing the quest's
attempt count.

### 6.2 Full Flow

```
1. Quest-launched cast fails.
2. User runs `/materia revive <cast-id>` (or uses WebUI requeue).

   Revive handler:
   a. Detects a different active cast + quest-linked target
      → isQuestLinkedCastState(targetState) returns quest metadata.
   b. Calls unfailQuest({ questRef: questId, resumeCastId: castId })
      → Sets quest status to "pending", clears currentCastId/lastResult/lastError,
        preserves lastCastId, moves quest to back of queue, sets resumeCastId.
   c. Sets targetState.data.questQueuedResurrection = { questId, resumeCastId }
   d. Saves cast state → cast is dormant (not active, not revivable).
   e. Emits "unfail" quest card + info notification.
   f. Returns WITHOUT reviving the cast — the active cast is untouched.

3. User runs `/materia quest run` (or runner auto-advances).

   Quest runner (useCases.ts:648):
   a. selectPendingQuest picks the front pending quest.
   b. startPendingQuest checks quest.resumeCastId — if set, uses the
      same-cast resumption path:
      i.   Calls deps.casts.reactivateQueuedCast(quest.resumeCastId)
           → reactivateQueuedNativeCast (castLifecycle.ts:447)
      ii.  Calls resumeQuest(board, { questId, castId: resumeCastId })
           → Sets quest to "running", does NOT increment attempts.
      iii. No prompt is dispatched — the cast stays active awaiting a nudge.
   c. If resumeCastId is absent, falls back to startCast + startQuest
      (new cast, attempt increments to 1).

4. User nudges (any message) or runs `/materia continue` if multi-turn.
   → The reactivated cast proceeds normally.
```

### 6.3 reactivateQueuedNativeCast Details

`reactivateQueuedNativeCast` (src/runtime/castLifecycle.ts) is the core
function that activates a dormant queued cast:

1. Loads cast state; throws if not found.
2. **Clears** `data.questQueuedResurrection` — the cast is no longer dormant.
3. Normalizes state: `active = true`, `phase` = socket id,
   `awaitingResponse` per socket type, socket state per socket type.
4. Clears `failedReason` and `runState.endedAt`.
5. Records `cast_queued_resume` event with castId/socket/materia/item metadata.
6. Emits `lifecycle.cast.reactivated` lifecycle event.
7. Re-initializes event bus and starts heartbeat.
8. Updates tool scope for agent sockets.
9. Updates UI status and widget.
10. Notifies the user: "Nudge or use /materia continue to proceed."
11. **Does NOT dispatch any prompt** — the cast is active/awaiting but Pi
    won't send a turn until the user nudges.

### 6.4 Dormant Cast State

Between step 2 and step 3 of §6.2, the cast is **dormant**:

| Property | Value |
|---|---|
| `state.active` | `false` (original failed state) |
| `state.data.questQueuedResurrection` | `{ questId, resumeCastId }` |
| `isRevivableCastState(state)` | `false` — early-returns for `hasQuestQueuedResurrection` |
| `listRevivableCastStates` | Excluded — does not appear in `/materia revive` completions |
| Quest status | `pending` with `resumeCastId` set, at back of queue |

The dormant state prevents the cast from appearing as "revivable" while its
quest is pending, and prevents the revive handler from double-processing it.

### 6.5 Same-Cast Event Emissions

| Path | Event | Lifecycle Event |
|---|---|---|
| Revive handler queuing (step 2) | (handled by unfailQuest) | none |
| Quest runner reactivation (step 3) | `cast_queued_resume` | `lifecycle.cast.reactivated` |

Both `lifecycle.cast.revived` (revival paths) and `lifecycle.cast.reactivated`
(queued resumption) are registered in `AGENT_CONTROLLER_FILTER.include` and
mapped to `runtime.accepted` in `AGENT_CONTROLLER_TYPE_MAP`, so connected
observers receive non-terminal activation events.

### 6.6 Current-Work Preservation

`reactivateQueuedNativeCast` preserves `state.currentItemKey` and
`state.currentItemLabel` — the cast reactivates at the same socket/materia
with the same item context. The `cast_queued_resume` event records these
fields for observability.

---

## 7. Parallel Branch Revival

A failed intrinsic parallel run is revived from durable plan, graph, branch, child-session, attempt, and execution-scope identities. Revival does not invoke the generator again, redistribute work, or rerun accepted branches. Only failed or interrupted branches restart or resume; accepted terminal outputs and scopes remain available for the eventual ordered barrier.

Before launching anything, runtime validates the immutable plan and graph, stream membership, complete parent/loop/child/lane identity, retained child initial data, execution scope, cwd, and artifact provenance. It revalidates resumed snapshots as well. Missing data or drift is an integrity failure rather than permission to infer a replacement. Intrinsic revival does not require a loop concurrency override; it uses the persisted run bound.

Each coordinator attempt has distinct artifacts even when a resumed child retains its original session paths. Cancellation is idempotent and can be issued by a fresh dispatcher against every persisted nonterminal run; available telemetry is drained before terminalization. See [Parallel generation and scoped execution](parallel-loop-orchestration.md#7-persistence-cancellation-and-revival) and the [operator guide](parallel-workflow-operation.md#cancel-and-revive).

---

## 8. Implementation Reference

| Component | File | Key Functions |
|---|---|---|
| Inference interruption | `src/runtime/turnRecovery.ts` | `preserveAwaitingAfterInferenceInterruption` |
| Transient transport preservation | `src/runtime/turnRecovery.ts` | `preserveAwaitingAfterTransientTransportFailure` |
| Agent end handler | `src/runtime/agentLifecycle.ts` | `handleAgentEnd` (interruption routing) |
| Agent settled handler | `src/runtime/agentLifecycle.ts` | `handleAgentSettled` |
| Tool scope restoration | `src/runtime/agentLifecycle.ts` | `prepareAgentStartSystemPrompt` |
| Passive and parallel revival | `src/runtime/castLifecycle.ts` | `reviveNativeCast` |
| Edge-traversal revival | `src/runtime/castLifecycle.ts` | `reviveNativeCast` (edge_traversal path) |
| Same-socket recovery revival | `src/runtime/castLifecycle.ts` | `reviveNativeCast` (same_socket_recovery path) |
| Queued resumption | `src/runtime/castLifecycle.ts` | `reactivateQueuedNativeCast` (~L447) |
| Recast | `src/runtime/castLifecycle.ts` | `resumeNativeCast` → `resumeValidatedNativeCast` |
| Quest unfail (queued path) | `src/domain/questBoard.ts` | `unfailQuest` (+ `resumeCastId` field on Quest) |
| Quest resume (no attempt inc) | `src/domain/questBoard.ts` | `resumeQuest` |
| Quest runner (same-cast branch) | `src/application/useCases.ts` | `startPendingQuest` (~L648) |
| Revive command handler | `src/index.ts` | `/materia revive` (~L367) |
| Dormant cast suppression | `src/infrastructure/castStateRepository.ts` | `isRevivableCastState` / `hasQuestQueuedResurrection` |
| Helper: quest-linked check | `src/index.ts` | `isQuestLinkedCastState` |
| UI status with interruption | `src/presentation/ui.ts` | `createMateriaCastStatusModel` |
| Lifecycle event presets | `src/eventing/presets.ts` | `AGENT_CONTROLLER_FILTER`, `AGENT_CONTROLLER_TYPE_MAP` |
| Recovery allowance extensions | `src/application/recoveryPolicy.ts` | `extendEdgeTraversalAllowanceForRevive`, `extendSameSocketRecoveryAllowanceForRevive` |
| Parallel revival validation/dispatch | `src/runtime/parallelDispatcher.ts` | `validateRevival`, resumed snapshot validation, cancellation |

### Test Coverage

| Test file | What it covers |
|---|---|
| `tests/sameSocketRecoveryNative.test.ts` | Inference interruption preservation (stopReason error, event-level failures), tool scope restoration, multi-turn completion after interruption, agent_settled nudge behavior, end-to-end resume, no-op settled |
| `tests/questBoardDomain.test.ts` | `unfailQuest` (clears terminal state, back-of-queue, resumeCastId, rejects non-terminal), `resumeQuest` (pending→running, no attempt increment, rejects non-pending) |
| `tests/applicationUseCases.test.ts` | Quest runner with `resumeCastId` (reactivateQueuedCast called, startCast NOT called, attempts unchanged, same castId), fallback to new cast, queue ordering |
| `tests/questCommandInterface.test.ts` | `/materia revive` with quest-linked casts (queues quest, dormant cast suppressed, fallback to passive revive, questQueuedResurrection excluded from revivable) |
| `tests/reactivateQueuedNative.test.ts` | Native reactivateQueuedNativeCast with agent socket (cast_queued_resume event, current-work preserved, questQueuedResurrection cleared, active/awaiting, no prompt dispatched, tool scope updated), utility socket variant, error case |
| `tests/eventingPresets.test.ts` | `lifecycle.cast.revived` and `lifecycle.cast.reactivated` in AGENT_CONTROLLER_FILTER + AGENT_CONTROLLER_TYPE_MAP |
| `tests/lifecycleEvents.test.ts` | End-to-end lifecycle event delivery through real preset sink |
| `tests/infrastructureAdapters.test.ts` | Lifecycle keys include `reactivateQueuedCast` |
