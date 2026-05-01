# Multi-turn continuation semantics

Implementation notes for replacing command-driven multi-turn finalization with natural-language readiness handling.

## Current lifecycle

1. `startNativeCast()` creates an active `MateriaCastState`, sets `awaitingResponse = true` and `nodeState = "awaiting_agent_response"`, then calls `startNode()` for the pipeline entry.
2. `startNode()` increments the node visit, records `node_start`, applies role model/tool scope for agent nodes, and sends the hidden role prompt with `sendMateriaTurn(..., { triggerTurn: true })`.
3. `handleAgentEnd()` processes the newest assistant entry. For normal single-turn nodes it immediately calls `completeNode()`.
4. For `agent` nodes with `multiTurn: true`, `handleAgentEnd()` currently does **not** parse, assign, or advance. It records the assistant output as a `node_refinement` artifact, sets `nodeState = "awaiting_user_refinement"`, clears `awaitingResponse`, saves state, updates status/widgets, and notifies the user to refine or run `/materia continue`.
5. While paused, the `before_agent_start` hook in `src/index.ts` calls `prepareMultiTurnRefinementTurn()` before a normal Pi agent turn. That function restores the active role/model/tools, sets `awaitingResponse = true` and `nodeState = "awaiting_agent_response"`, records `context_refinement`, and lets the user's message drive another refinement turn through isolated role context.
6. The next `agent_end` records another `node_refinement` and pauses again.

## Current `/materia continue` finalization path

`/materia continue` is the only explicit finalization path today:

- `src/index.ts`
  - Imports `continueNativeCast` from `src/native.ts`.
  - Registers `/materia continue` in the command description.
  - Handles `subcommand === "continue"` by loading active cast state and calling `continueNativeCast(pi, ctx, state)`.
  - Reports errors as `pi-materia continue failed: ...`.
  - User-facing status/usage/session text tells users to run `/materia continue`.
- `src/native.ts`
  - Exports `continueNativeCast()`.
  - If `state.nodeState === "awaiting_user_refinement"`, it reads `state.lastAssistantText`, synthesizes an entry id when needed, sets `nodeState = "idle"`, saves state, and calls `completeNode(pi, ctx, state, text, entryId)`.
  - `completeNode()` writes the normal node output, parses JSON when configured, applies assignments, applies `advance`, appends `node_complete`, checks budget, selects the next target, and advances/finishes the cast.
  - If `continueNativeCast()` is called outside a refinement pause, it restarts the current node with `startNode()`.
- `tests/multiturnNative.test.ts`
  - Asserts paused status mentions `/materia continue`.
  - Uses `/materia continue` to prove invalid JSON fails only at finalization.
  - Uses `/materia continue` after refinements to finalize latest assistant output.
  - Asserts finalization metadata and artifacts after command-driven finalization.

## All current `/materia continue` mentions

Repository search found these user-facing and implementation references:

- `README.md`: command list includes `/materia continue`; feature overview says `multiTurn` pauses until `/materia continue`; multi-turn section says finalization uses `/materia continue`.
- `PI_MATERIA_PLAN.md`: historical checklist item for adding `/materia continue`.
- `src/index.ts`: session restore notification, command description, status text, continue subcommand handler, error notification, usage string.
- `src/native.ts`: `continueNativeCast()` API and errors; multi-turn wait message/notification; synthetic isolated-context mode text.
- `tests/multiturnNative.test.ts`: status assertion and command invocations for finalization.

## Desired lifecycle

Multi-turn nodes should retain the same refinement loop, but finalization should be triggered by natural-language readiness from the user instead of requiring a slash command.

1. A multi-turn assistant response is still saved as a `node_refinement` artifact and the node pauses in `nodeState = "awaiting_user_refinement"` with `awaitingResponse = false`.
2. While paused and not already awaiting an agent response, a normal user message should be classified before preparing a refinement turn.
3. If the user message is **not** a readiness instruction, the runtime should call the same refinement setup currently performed by `prepareMultiTurnRefinementTurn()`: restore active role context, role model, tool scope, accumulated context, set `awaitingResponse = true`, write `context_refinement`, and let the role respond.
4. If the user message **is** a readiness instruction, the runtime should finalize the latest assistant output and advance the cast without requiring `/materia continue`.
5. If `awaitingResponse` is already true, no readiness or refinement processing should run; the runtime must keep preventing double-processing while waiting for the active agent response.

## Readiness detection plan

Add a small explicit classifier for paused multi-turn user messages. It should be deterministic and unit-testable.

Suggested behavior:

- Normalize the latest user text: trim whitespace, lowercase, collapse repeated whitespace, strip surrounding punctuation that does not affect intent.
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
- Require an explicit readiness/finalization verb or phrase. Messages with substantive requested changes should remain refinement turns, for example:
  - `continue refining the risk section`
  - `finalize the API design but add tests first`
  - `we're ready after you add rollback steps`
  - `make it final JSON`
- Keep `/materia continue` optional only as a backward-compatible alias if desired, but no status/help/synthetic context should say it is required.

## Finalization semantics

Natural-language readiness should reuse the same finalization path that single-turn nodes use. The implementation should factor the current paused-node branch of `continueNativeCast()` into a helper, then call that helper from readiness handling.

Finalization must call `completeNode(pi, ctx, state, state.lastAssistantText, entryId)` so behavior remains identical to normal orchestration:

- Text nodes write the normal `node_output` artifact via `recordNodeOutput()`.
- JSON nodes parse with `parseJson()`, write the parsed JSON sidecar, and set `state.lastJson`.
- `assign` updates `state.data` through `applyAssignments()`.
- `advance` and edge/`next` selection use `applyAdvance()` and `selectNextTarget()`.
- `node_complete` events and manifest entries are appended as today, preserving multi-turn metadata such as `finalized: true` / `finalizedRefinement` and `refinementTurn` without changing the artifact content shape consumed downstream.
- Budget checks, `advanceToNode()`, `startNode()`, `finishCast()`, and failure handling remain the same as single-turn nodes.

The final multi-turn artifact should be the role's latest assistant output in the normal node artifact path, e.g. `nodes/<node>/<visit>.md`, not a transcript or wrapper. Refinement drafts may continue to be recorded separately as `.refinement-<turn>-...md` artifacts for traceability.
