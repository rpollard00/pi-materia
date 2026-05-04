# Multi-turn continuation semantics

Implementation notes for agent nodes whose resolved roles have `multiTurn: true`, pause for natural-language refinement, and finalize when the user says the work is ready to continue.

## Current lifecycle

1. `startNativeCast()` creates an active `MateriaCastState`, sets `awaitingResponse = true` and `nodeState = "awaiting_agent_response"`, then calls `startNode()` for the pipeline entry.
2. `startNode()` increments the node visit, records `node_start`, applies role model/tool scope for agent nodes, and sends the hidden role prompt with `sendMateriaTurn(..., { triggerTurn: true })`.
3. `handleAgentEnd()` processes the newest assistant entry. For normal single-turn nodes it immediately calls `completeNode()`.
4. For `agent` nodes whose resolved role has `multiTurn: true`, `handleAgentEnd()` records the assistant output as a `node_refinement` artifact, sets `nodeState = "awaiting_user_refinement"`, clears `awaitingResponse`, saves state, updates status/widgets, and notifies the user to either refine the draft or say they are ready to continue/finalize.
5. While paused, the `input` hook in `src/index.ts` calls `handleMultiTurnUserInput()` for normal user messages before Pi starts another agent turn.
6. If the message is a readiness instruction, the runtime finalizes the latest assistant output and advances the cast. If it is not a readiness instruction, the normal Pi turn continues; the `before_agent_start` hook calls `prepareMultiTurnRefinementTurn()` to restore the active role/model/tools, set `awaitingResponse = true` and `nodeState = "awaiting_agent_response"`, record `context_refinement`, and let the user's message drive another isolated refinement turn.
7. The next `agent_end` records another `node_refinement` and pauses again.

The `/materia continue` subcommand is retained only as a backward-compatible alias. User-facing status/help/documentation should describe natural-language readiness instead of requiring that command.

## Readiness detection

Paused multi-turn user messages are classified by a deterministic helper, `isReadinessToContinueInstruction()`:

- Normalize the latest user text: trim whitespace, lowercase, collapse repeated whitespace, and strip surrounding punctuation that does not affect intent.
- Treat concise readiness commands as finalization, for example:
  - `continue`
  - `ready to continue`
  - `finalize`
  - `finalise`
  - `we're ready`
  - `we are ready`
  - `ready`
  - `looks good, continue`
  - `that looks good, finalize it`
- Require an explicit readiness/finalization verb or phrase. Messages with substantive requested changes remain refinement turns, for example:
  - `continue refining the risk section`
  - `finalize the API design but add tests first`
  - `we're ready after you add rollback steps`
  - `make it final JSON`

If `awaitingResponse` is already true, no readiness or refinement processing runs; the runtime keeps preventing double-processing while waiting for the active agent response.

## Finalization semantics

Natural-language readiness reuses the same finalization path that single-turn nodes use. The paused multi-turn branch calls `completeNode(pi, ctx, state, state.lastAssistantText, entryId)` so behavior remains identical to normal orchestration:

- Text nodes write the normal `node_output` artifact via `recordNodeOutput()`.
- JSON nodes parse with `parseJson()`, write the parsed JSON sidecar, and set `state.lastJson`.
- `assign` updates `state.data` through `applyAssignments()`.
- `advance` and edge/`next` selection use `applyAdvance()` and `selectNextTarget()`.
- `node_complete` events and manifest entries are appended as today, preserving multi-turn metadata such as `finalized: true` / `finalizedRefinement` and `refinementTurn` without changing the artifact content shape consumed downstream.
- Budget checks, `advanceToNode()`, `startNode()`, `finishCast()`, and failure handling remain the same as single-turn nodes.

The final multi-turn artifact is the role's latest assistant output in the normal node artifact path, e.g. `nodes/<node>/<visit>.md`, not a transcript or wrapper. Refinement drafts continue to be recorded separately as `.refinement-<turn>-...md` artifacts for traceability.
