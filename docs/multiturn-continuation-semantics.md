# Multi-turn continuation semantics

Implementation notes for agent sockets whose resolved materia have `multiTurn: true`, pause for conversational refinement, and finalize only when the user runs `/materia continue`.

## Current lifecycle

1. `startNativeCast()` creates an active `MateriaCastState`, sets `awaitingResponse = true` and socket state (`currentSocketState` legacy DTO field) = `"awaiting_agent_response"`, then calls `startSocket()` for the pipeline entry.
2. `startSocket()` increments the socket visit, records `socket_start`, applies materia model/tool scope for agent sockets, and sends the hidden materia prompt with `sendMateriaTurn(..., { triggerTurn: true })`.
3. `handleAgentEnd()` processes the newest assistant entry. For normal single-turn sockets it immediately calls `completeSocket()`.
4. For `agent` sockets whose resolved materia has `multiTurn: true`, `handleAgentEnd()` records the assistant output as a `socket_refinement` artifact, sets socket state (`currentSocketState` legacy DTO field) = `"awaiting_user_refinement"`, clears `awaitingResponse`, saves state, updates status/widgets, and notifies the user to refine the draft or run `/materia continue` to finalize. The socket pauses after each assistant turn until that command is run.
5. While paused, ordinary user messages are treated as refinement instructions. The normal Pi turn continues; the `before_agent_start` hook calls `prepareMultiTurnRefinementTurn()` to restore the active materia/model/tools, set `awaitingResponse = true` and socket state (`currentSocketState` legacy DTO field) = `"awaiting_agent_response"`, record `context_refinement`, and let the user's message drive another isolated refinement turn.
6. The next `agent_end` records another `socket_refinement` and pauses again.
7. When the user runs `/materia continue`, the command handler calls `startMultiTurnFinalizationTurn()` for the paused socket, sets `multiTurnFinalizing = true`, requests the socket's final output format, and advances through the normal completion path after the assistant replies.

`/materia continue` is the only supported finalization trigger for paused multi-turn sockets. Natural-language messages such as `continue`, `ready to continue`, `looks good, proceed`, or `finalize` are normal refinement input and must not finalize or advance the socket.

## Refinement input

Free-form refinement is the default while a multi-turn socket is paused. Ordinary answers, constraints, corrections, and requested changes keep the socket at the current socket and start another conversational refinement turn instead of parsing or advancing.

Refinement messages include:

- `Let's do a full CRT-inspired shader with phosphor glow.`
- `Add rollback steps before we continue.`
- `Can you split the bootstrap work into its own task?`
- `Continue refining the risk section.`
- `We are ready after you add rollback steps.`
- `ready to continue`
- `looks good, proceed`
- `finalize`

If `awaitingResponse` is already true, no refinement preparation runs; the runtime keeps preventing double-processing while waiting for the active agent response.

## Finalization semantics

Command-triggered finalization reuses the same completion path that single-turn sockets use. Until `/materia continue` is run, the assistant output is only a refinement draft: JSON-parsed sockets must not request or emit final structured JSON, and the runtime must not call `completeSocket()` or attempt `parseJson()` for that plaintext refinement output. After `/materia continue`, the paused multi-turn branch asks the agent for the socket's final format and then calls `completeSocket(pi, ctx, state, finalAssistantText, entryId)` so behavior remains identical to normal orchestration:

- Text sockets write the normal `socket_output` artifact via `recordNodeOutput()`.
- JSON sockets parse with `parseJson()`, write the parsed JSON sidecar, and set `state.lastJson`.
- `assign` updates `state.data` through `applyAssignments()`.
- `advance` and edge/`next` selection use `applyAdvance()` and `selectNextTarget()`.
- `socket_complete` events and manifest entries are appended as today, preserving multi-turn metadata such as `finalized: true` / `finalizedRefinement` and `refinementTurn` without changing the artifact content shape consumed downstream.
- Budget checks, `advanceToSocket()`, `startSocket()`, `finishCast()`, and failure handling remain the same as single-turn sockets.

The final multi-turn artifact is the materia's command-triggered final assistant output in the normal socket artifact path, e.g. `sockets/<socket>/<visit>.md`, not a transcript or wrapper. Refinement drafts continue to be recorded separately as `.refinement-<turn>-...md` artifacts for traceability.
