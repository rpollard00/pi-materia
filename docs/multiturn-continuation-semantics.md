# Multi-turn continuation semantics

Implementation notes for agent nodes whose resolved roles have `multiTurn: true`, pause for conversational refinement, and finalize only when the user runs `/materia continue`.

## Current lifecycle

1. `startNativeCast()` creates an active `MateriaCastState`, sets `awaitingResponse = true` and `nodeState = "awaiting_agent_response"`, then calls `startNode()` for the pipeline entry.
2. `startNode()` increments the node visit, records `node_start`, applies role model/tool scope for agent nodes, and sends the hidden role prompt with `sendMateriaTurn(..., { triggerTurn: true })`.
3. `handleAgentEnd()` processes the newest assistant entry. For normal single-turn nodes it immediately calls `completeNode()`.
4. For `agent` nodes whose resolved role has `multiTurn: true`, `handleAgentEnd()` records the assistant output as a `node_refinement` artifact, sets `nodeState = "awaiting_user_refinement"`, clears `awaitingResponse`, saves state, updates status/widgets, and notifies the user to refine the draft or run `/materia continue` to finalize. The node pauses after each assistant turn until that command is run.
5. While paused, ordinary user messages are treated as refinement instructions. The normal Pi turn continues; the `before_agent_start` hook calls `prepareMultiTurnRefinementTurn()` to restore the active role/model/tools, set `awaitingResponse = true` and `nodeState = "awaiting_agent_response"`, record `context_refinement`, and let the user's message drive another isolated refinement turn.
6. The next `agent_end` records another `node_refinement` and pauses again.
7. When the user runs `/materia continue`, the command handler calls `startMultiTurnFinalizationTurn()` for the paused node, sets `multiTurnFinalizing = true`, requests the node's final output format, and advances through the normal completion path after the assistant replies.

`/materia continue` is the only supported finalization trigger for paused multi-turn nodes. Natural-language messages such as `continue`, `ready to continue`, `looks good, proceed`, or `finalize` are normal refinement input and must not finalize or advance the node.

## Refinement input

Free-form refinement is the default while a multi-turn node is paused. Ordinary answers, constraints, corrections, and requested changes keep the node at the current node and start another conversational refinement turn instead of parsing or advancing.

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

Command-triggered finalization reuses the same completion path that single-turn nodes use. Until `/materia continue` is run, the assistant output is only a refinement draft: JSON-parsed nodes must not request or emit final structured JSON, and the runtime must not call `completeNode()` or attempt `parseJson()` for that plaintext refinement output. After `/materia continue`, the paused multi-turn branch asks the agent for the node's final format and then calls `completeNode(pi, ctx, state, finalAssistantText, entryId)` so behavior remains identical to normal orchestration:

- Text nodes write the normal `node_output` artifact via `recordNodeOutput()`.
- JSON nodes parse with `parseJson()`, write the parsed JSON sidecar, and set `state.lastJson`.
- `assign` updates `state.data` through `applyAssignments()`.
- `advance` and edge/`next` selection use `applyAdvance()` and `selectNextTarget()`.
- `node_complete` events and manifest entries are appended as today, preserving multi-turn metadata such as `finalized: true` / `finalizedRefinement` and `refinementTurn` without changing the artifact content shape consumed downstream.
- Budget checks, `advanceToNode()`, `startNode()`, `finishCast()`, and failure handling remain the same as single-turn nodes.

The final multi-turn artifact is the role's command-triggered final assistant output in the normal node artifact path, e.g. `nodes/<node>/<visit>.md`, not a transcript or wrapper. Refinement drafts continue to be recorded separately as `.refinement-<turn>-...md` artifacts for traceability.
