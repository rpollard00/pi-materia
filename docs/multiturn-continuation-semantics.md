# Multi-turn continuation semantics

Implementation notes for agent sockets whose resolved materia have `multiTurn: true`, pause for conversational refinement, and finalize only when the user runs `/materia continue`.

## Runtime dispatch contract

Materia advancement has two separate observable effects:

1. **Completion and state advancement** are synchronous. When an `agent_end` event completes a socket, the runtime records the assistant output, applies assignments, advances graph state, selects the next socket, and persists the updated cast state before returning from the handler.
2. **Downstream agent prompt dispatch** is deferred when that next prompt is caused by an `agent_end`-originated completion. The runtime schedules the downstream `triggerTurn` prompt and sends it only after the current `agent_end` handler turn has unwound.

This distinction prevents nested `triggerTurn` work from being started inside the same `agent_end` handling stack while still making the durable completion result available immediately to status views, diagnostics, and subsequent routing checks.

Not every prompt is deferred. Initial cast prompts and command-originated prompts, including the first socket prompt and `/materia continue` finalization prompts, are dispatched immediately unless they later complete through `agent_end` and route to another agent socket. The deferred behavior applies to downstream prompts that are a consequence of an assistant response completing a socket.

In practical phases, an `agent_end`-originated continuation follows this sequence:

1. Receive `agent_end` for the current socket.
2. Mark the socket completion and record the normal output artifacts/events.
3. Apply assignments and advance graph state to the selected next socket or finish the cast.
4. If the next socket requires an agent prompt, schedule downstream prompt dispatch instead of calling `triggerTurn` inline.
5. After the current handler turn returns, dispatch the scheduled downstream prompt with `triggerTurn: true` if the scheduled socket is still current.

The deferred dispatch path is idempotent. Duplicate scheduling for the same source/target transition is skipped and recorded as diagnostic information, and stale scheduled dispatches are skipped if the cast has moved elsewhere before the deferred callback runs. These diagnostics describe lifecycle safety checks; they are not part of the canonical handoff payload shape.

## Current lifecycle

1. `startNativeCast()` creates an active `MateriaCastState`, sets `awaitingResponse = true` and socket state (`currentSocketState` current DTO field) = `"awaiting_agent_response"`, then calls `startSocket()` for the pipeline entry.
2. `startSocket()` increments the socket visit, records `socket_start`, applies materia model/tool scope for agent sockets, and sends the hidden materia prompt with `sendMateriaTurn(..., { triggerTurn: true })`. This initial prompt is immediate.
3. `handleAgentEnd()` processes the newest assistant entry. For normal single-turn sockets it synchronously calls `completeSocket()`, which records completion and advances graph state. Any downstream agent prompt selected from this `agent_end` completion is scheduled for deferred dispatch after the handler turn.
4. For `agent` sockets whose resolved materia has `multiTurn: true`, `handleAgentEnd()` records the assistant output as a `socket_refinement` artifact, sets socket state (`currentSocketState` current DTO field) = `"awaiting_user_refinement"`, clears `awaitingResponse`, saves state, updates status/widgets, and notifies the user to refine the draft or run `/materia continue` to finalize. The socket pauses after each assistant turn until that command is run.
5. While paused, ordinary user messages are treated as refinement instructions. The normal Pi turn continues; the `before_agent_start` hook calls `prepareMultiTurnRefinementTurn()` to restore the active materia/model/tools, set `awaitingResponse = true` and socket state (`currentSocketState` current DTO field) = `"awaiting_agent_response"`, record `context_refinement`, and let the user's message drive another isolated refinement turn.
6. The next `agent_end` records another `socket_refinement` and pauses again.
7. When the user runs `/materia continue`, the command handler calls `startMultiTurnFinalizationTurn()` for the paused socket, sets `multiTurnFinalizing = true`, requests the socket's final output format, and sends that finalization prompt immediately. After the assistant replies, completion follows the same synchronous state-advancement and deferred-downstream-dispatch contract described above.

`/materia continue` is the only supported finalization trigger for paused multi-turn sockets. Natural-language messages such as `continue`, `ready to continue`, `looks good, proceed`, or `finalize` are normal refinement input and must not finalize or advance the socket.

## Refinement input

Free-form refinement is the default while a multi-turn socket is paused. Ordinary answers, constraints, corrections, and requested changes keep the socket at the current socket and start another conversational refinement turn instead of parsing or advancing.

Refinement messages include:

- `Let's do a full CRT-inspired shader with phosphor glow.`
- `Add rollback steps before we continue.`
- `Can you split the bootstrap work into its own workItems entry?`
- `Continue refining the risk section.`
- `We are ready after you add rollback steps.`
- `ready to continue`
- `looks good, proceed`
- `finalize`

If `awaitingResponse` is already true, no refinement preparation runs; the runtime keeps preventing double-processing while waiting for the active agent response.

## Finalization semantics

### Finalization prompt dispatch

When the user runs `/materia continue`, `startMultiTurnFinalizationTurn()`
(src/runtime/agentLifecycle.ts) sets `state.multiTurnFinalizing = true`, then calls
`sendMateriaTurn()` with `buildMultiTurnFinalizationPrompt(state, socket)`.
The hidden prompt message is dispatched with `customType: "pi-materia-prompt"`
and carries `details.finalization: true` (src/runtime/agentPromptDispatch.ts ~L360).
This marker is derived from `state.multiTurnFinalizing` and covers every dispatch
path:

- The initial `/materia continue` dispatch in `startMultiTurnFinalizationTurn`.
- Recovery/resume re-sends via `turnRecovery.ts` `rebuildPrompt()` when
  `recoveryTurnMode(state) === "finalization"` — the same
  `buildMultiTurnFinalizationPrompt` is rebuilt, and `sendMateriaTurn` tags it.
- Same-socket JSON-repair retries via `socketOutputCommit.ts` — when a
  `finalizedMultiTurn` validation failure occurs, `state.multiTurnFinalizing` is
  set to `true` before the repair turn dispatches, so the re-sent prompt also
  carries the flag.

The display-only `"pi-materia"` orchestration card is not tagged.

### Isolated-context anchor exclusion

`buildIsolatedMateriaContext()` (src/application/promptAssembly.ts ~L220) anchors
isolated agent context on the active socket's hidden `pi-materia-prompt` via
`findActiveMateriaPromptIndex()`. Before this fix, every hidden prompt — including
the finalization prompt sent by `/materia continue` — was a valid anchor candidate.
Since anchor discovery scans backwards and selects the *latest* matching prompt,
the finalization prompt would become the anchor, discarding all earlier refinement
turns (user messages, assistant drafts, tool calls) and leaving only the synthetic
cast context prepend plus the finalization prompt itself. This caused the
context-clearing regression.

The fix: `findActiveMateriaPromptIndex()` (~L448) and its candidate reader
`readMateriaPromptCandidate()` (~L485) skip `pi-materia-prompt` messages whose
`details.finalization === true`. The anchor therefore resolves to the socket
visit's INITIAL hidden prompt — the refinement prompt sent by `startSocket()`
when the socket first became active. The defensive content-only fallback
`findContentAnchoredPromptIndex()` (~L505) also skips finalization-marked
prompts, and the metadata-aware socket/materia matching preserves the existing
prior-socket exclusion.

Crucially, the exclusion is anchor-only: the finalization-marked message itself
is still retained in the returned isolated context because it appears at or
after the anchor index in the `messages.slice(materiaStart)` slice.

### Full refinement transcript preserved

With the anchor fixed to the visit's initial prompt, `buildIsolatedMateriaContext`
preserves every message from that point forward:

1. The initial hidden refinement prompt (the first `pi-materia-prompt`).
2. All user refinement messages and assistant draft responses.
3. The finalization hidden prompt (the last `pi-materia-prompt`, carrying
   `details.finalization: true`).
4. The prepended synthetic cast context (`buildSyntheticCastContext(state)`)
   provides the shared handoff context summary.

This ensures the agent sees the full refinement conversation during finalization,
not just the finalization prompt in isolation.

### Synthetic cast context deduplication

The synthetic cast context is prepended by `buildIsolatedMateriaContext` on
every isolated turn — including finalization and all recovery re-dispatch paths.
To avoid duplication, `buildMultiTurnFinalizationPrompt` (src/application/promptAssembly.ts ~L28)
no longer embeds `buildSyntheticCastContext(state)` directly. Similarly,
`buildJsonOutputRepairRetryPrompt` (~L115) only embeds the synthetic context
for single-turn repair paths (`!state.multiTurnFinalizing`); during multi-turn
finalization isolation already supplies it. Token projection in
`maybeRunProactiveCompaction` already accounts for `buildSyntheticCastContext`
separately (src/runtime/agentPromptDispatch.ts ~L262), so no double-counting
remains.

### Completion path

Command-triggered finalization reuses the same completion path that single-turn sockets use. Until `/materia continue` is run, the assistant output is only a refinement draft: JSON-parsed sockets must not request or emit final structured JSON, and the runtime must not call `completeSocket()` or attempt `parseJson()` for that plaintext refinement output. After `/materia continue`, the paused multi-turn branch asks the agent for the socket's final format and then calls `completeSocket(pi, ctx, state, finalAssistantText, entryId)` so completion and graph advancement remain identical to normal orchestration:

- Text sockets write the normal `socket_output` artifact via `recordSocketOutput()`.
- JSON sockets parse with `parseJson()`, write the parsed JSON sidecar, and set `state.lastJson`.
- `assign` updates `state.data` through `applyAssignments()`.
- `advance` and edge selection use `applyAdvance()` and `selectNextTarget()`.
- `socket_complete` events and manifest entries are appended as today, preserving multi-turn metadata such as `finalized: true` / `finalizedRefinement` and `refinementTurn` without changing the artifact content shape consumed downstream.
- Budget checks, `advanceToSocket()`, `startSocket()`, `finishCast()`, and failure handling remain the same as single-turn sockets.

The final multi-turn artifact is the materia's command-triggered final assistant output in the normal socket artifact path, e.g. `sockets/<socket>/<visit>.md`, not a transcript or wrapper. Refinement drafts continue to be recorded separately as `.refinement-<turn>-...md` artifacts for traceability.
