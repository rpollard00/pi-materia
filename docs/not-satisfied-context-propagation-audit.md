# `not_satisfied` context propagation audit

Date: 2026-05-24

## Scope

This audit traces the current `satisfied:false` / `not_satisfied` path from socket output handling through routing, state updates, work item reuse, prompt assembly, artifacts, and persistence. It specifically asks whether the next materia receives:

- that the next turn is follow-up/rework;
- which prior socket routed it there;
- the prior socket's actionable reason text.

## Current runtime path

1. **Socket completion and parsing**
   - `completeSocket()` in `src/runtime/nativeLifecycle.ts` records the raw socket output, stores it in `state.lastOutput`, parses JSON sockets, validates sparse agent handoff JSON, stores `state.lastJson`, and writes a parsed JSON sidecar artifact.
   - JSON validation preserves the canonical agent handoff contract: agent-authored fields are limited to `workItems`, `satisfied`, and `context` when those fields are relevant to the socket.

2. **Canonical handoff state update**
   - `applyGenericHandoffEnvelope()` in `src/application/handoff.ts` copies canonical fields into `state.data.envelope`.
   - If the parsed payload contains `context:string`, it appends a labeled entry to `state.data.context` using the source socket and materia label, e.g. `[Socket-6 Auto-Eval] ...`.
   - This gives later prompts accumulated explanatory text, including prior evaluator reasons, but it is a generic accumulated handoff log rather than a dedicated rework mailbox.

3. **Configured assignments**
   - After the generic envelope update, `completeSocket()` calls `applyAssignments()`.
   - `applyAssignments()` in `src/application/workflowTransitions.ts` applies socket-configured `assign` mappings to `state.data` using JSONPath-ish sources such as `$.context`.
   - In the default `Full-Auto` and interactive loadouts, Auto-Eval `Socket-5` has `assign: { "lastFeedback": "$.context", "lastCheck": "$" }`; because Build renders `{{state.lastFeedback}}`, this is a material current source of prior rejection/follow-up reason text for that default Build/Eval loop.
   - This source is config-specific. For example, the default architected flow's Auto-Eval `Socket-6` routes `not_satisfied` back to Build `Socket-5` but does not assign `lastFeedback`, so it relies on accumulated `state.context`, `lastOutput`, and `lastJson` exposure rather than the explicit Build prompt `Previous feedback` slot.

4. **Routing and advancement**
   - `canonicalSatisfiedOutcome()` reads only top-level `$.satisfied` from the current parsed payload.
   - `selectNextTarget()` selects the first canonical outgoing edge whose condition matches `satisfied === true`, `satisfied === false`, or `always`.
   - A `not_satisfied` edge is therefore graph control only: it does not itself create provenance, feedback, or prompt context.
   - Loop advancement uses the same boolean through `advance.when` / indexed loop exits. The current work item is not rewritten when an eval socket returns `satisfied:false`; routing back to Build reuses the current item set by loop cursor state.

5. **Prompt assembly**
   - `startSocket()` sets the current item, updates state, then `sendMateriaTurn()` sends `buildSocketPrompt()`.
   - Text/build sockets receive the reusable materia prompt rendered with state templates plus the socket adapter context from `socketAdapterContextInstruction()`.
   - The bundled Build prompt includes `{{state.context}}` as "Accumulated handoff context" and `{{state.lastFeedback}}` as "Previous feedback". Therefore, in the default `Socket-5 -> Socket-4` rework loop, the next Build turn does see the evaluator's reason text twice when context is emitted: once in accumulated context with source label and once in `Previous feedback` without source label.
   - There is no generic runtime-rendered section that says "this prompt was reached by a `not_satisfied` edge" or names the specific previous routing edge. Any such framing currently has to come indirectly from accumulated context labels, the previous output, or config-specific template wording.

6. **Artifacts and persistence**
   - Raw socket output and parsed JSON are written under the cast artifact directory and manifest.
   - Prompt/context artifacts are written before dispatch; `state.activeTurnPrompt` is persisted for same-socket recovery/recast.
   - Cast state is persisted after socket start, assignment, prompt dispatch, and completion. Persisted state contains `state.data.context`, `state.data.envelope`, `state.data.lastFeedback` when configured, `state.lastJson`, `state.lastOutput`, and `state.activeTurnPrompt` for the active prompt.
   - Artifacts are source-of-truth diagnostics, but the next agent only sees what prompt assembly renders. Artifact contents are not automatically read into prompts except via synthetic context fields such as generic cast data / previous output.

## Does the next materia know rework happened?

**Partially, and only by convention/configuration.**

- **Actionable reason text:** usually yes in the bundled default Build/Eval loop, if Auto-Eval emits a useful top-level `context`. It reaches Build through `state.data.context` and, in some loadouts, through `state.data.lastFeedback = $.context` rendered by the Build prompt.
- **Prior socket identity:** partly. `state.data.context` labels appended context with `[Socket-N Materia]`, so the reason text can carry source identity. `lastFeedback` alone drops that label because it stores only raw `$.context`.
- **Explicit follow-up/rework framing:** no generic mechanism. `not_satisfied` edge traversal does not add runtime provenance or wording to the next prompt. The next materia is not explicitly told that the previous socket rejected/failed the item or that the current turn is a rework attempt unless a prompt template or prior context happens to say so.
- **Reliability across arbitrary materia/sockets:** not reliable. The behavior depends on agent-authored `context`, config-specific `assign` mappings, and prompt templates that choose to render those state fields.

## Current source of truth

- **Routing truth:** current parsed payload's top-level boolean `satisfied`, consumed by `canonicalSatisfiedOutcome()` and `selectNextTarget()`.
- **Reason text truth:** top-level `context` emitted by the previous JSON socket. It is accumulated in `state.data.context`; in selected default loadouts it is also copied to `state.data.lastFeedback` by `assign`.
- **Prior raw output truth:** `state.lastOutput`, socket output artifacts, parsed JSON sidecars, and manifest entries.
- **Active prompt truth:** `state.activeTurnPrompt` plus the prompt/context artifact for the active socket.

## Context loss / weak points

- The `not_satisfied` routing decision itself is not persisted as a concise rework provenance record for prompt use.
- `lastFeedback` is a useful but config-specific convention, not a runtime-owned guarantee for all sockets or loadouts.
- `lastFeedback` stores only `$.context`, so it loses prior socket identity and edge condition unless the context string includes that manually.
- `state.data.context` is append-only labeled text, so it can contain the prior socket identity and reason, but it is broad accumulated handoff context rather than bounded rework-specific feedback.
- Prompt exposure depends on materia templates. Build currently renders `state.context` and `state.lastFeedback`; other materia may not.
- Artifacts contain authoritative output details but are diagnostics, not automatic prompt context.
- If an evaluator returns `satisfied:false` with an empty or vague `context`, the runtime has no generic reason text to recover beyond raw/parsed previous output.

## Conclusion

The original concern is valid. The current system can show why a default Auto-Eval rejected work, but it is not a generic runtime guarantee of rework awareness. The default `Socket-5` Auto-Eval assignment path (`lastFeedback <- $.context`) is an important existing source and should be preserved, but it does not replace a runtime-owned `not_satisfied` provenance mechanism.

A robust fix should preserve the canonical agent handoff contract and add bounded runtime-rendered follow-up context at the routing/prompt layer: when a `satisfied:false` result selects a follow-up edge, capture source socket/materia, edge condition/target, and concise reason text from the prior socket's `context`/output, then render that as generic follow-up context in the next prompt. This should not add agent-authored fields beyond `workItems`, `satisfied`, and `context`, should not mutate the work item schema, and should not use `state.data.context` as an implicit mailbox.

## Post-audit note

The runtime-owned follow-up context mechanism described in the conclusion has since been implemented. Current authoring semantics are documented in [Socket rework context semantics](socket-rework-context.md).
