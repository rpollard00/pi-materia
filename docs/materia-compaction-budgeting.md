# Materia compaction and request budgeting audit

This note documents the current Pi-native Materia context path as of this audit.

## Code paths

- Transcript/tool accumulation is owned by Pi core. Materia appends cast state with `pi.appendEntry("pi-materia-cast-state", ...)`, visible status messages with `pi.sendMessage({ customType: "pi-materia", ... })`, and hidden materia prompts with `pi.sendMessage({ customType: "pi-materia-prompt", content: prompt }, { triggerTurn: true })` in `src/castRuntime.ts:sendMateriaTurn`.
- Pi core context-usage reporting flows through `dist/core/extensions/runner.js:createContext().getContextUsage()` to `dist/core/agent-session.js:AgentSession.getContextUsage()`. That method reads the active model `contextWindow`, rejects stale post-compaction usage, then calls `estimateContextTokens(this.messages)` from `dist/core/compaction/compaction.js`. `estimateContextTokens` uses the last assistant provider usage plus local `estimateTokens` for trailing messages, or chars/4 for all messages if there is no assistant usage. It operates on `this.messages` as they exist before Materia sends the next hidden prompt and before context/system hooks run.
- Pi compaction itself uses `dist/core/agent-session.js:compactContext()`/`_runAutoCompaction()`, `dist/core/compaction/compaction.js:prepareCompaction()` and `compact()`, then rebuilds `agent.state.messages` with `dist/core/session-manager.js:buildSessionContext()` after appending a compaction entry.
- Context isolation happens in `src/index.ts` on the Pi `context` event. It calls `buildIsolatedMateriaContext(...)`, which replaces prior visible transcript before the active Materia prompt with a synthetic user message from `buildSyntheticCastContext(state)`, then keeps messages from the active materia prompt onward. Tool and assistant messages from the active materia turn are intentionally kept.
- System/developer prompt augmentation happens separately in `src/index.ts` on `before_agent_start`, which appends `activeMateriaSystemPrompt(...)` to Pi's existing system prompt.
- Proactive compaction is checked only in `src/runtime/agentPromptDispatch.ts:sendMateriaTurn` before writing the context artifact and before sending the hidden prompt. It calls `maybeRunProactiveCompaction`, which computes projected next-request overhead from the hidden Materia prompt content (`state.activeTurnPrompt`), synthetic isolated cast context (`buildSyntheticCastContext`), and system-prompt suffix (`activeMateriaSystemPrompt`), plus a conservative 2,000-token safety margin. The projection is passed to `assessContextPressureForCompaction` in `src/application/compactionWorkflow.ts`, which adds it to Pi's pre-turn `ctx.getContextUsage()` snapshot. Unless configuration overrides it, the usable budget is the effective active model context window minus Pi's 16,384-token reserve. Materia compacts only when the raw or projected total is strictly greater than that budget; it also retains the hard-window guard for a projected request greater than the full context window. Proactive event data includes projection and reserve-budget diagnostics when available.
- Same-socket context-window recovery is evidence-gated in `src/application/recoveryWorkflow.ts`. Provider `context_length_exceeded` responses can be transient or misleading, so a strong provider context signal is not enough by itself to force compaction on first sight. Recovery retries without compaction unless reserve-aware pressure corroborates the failure, provider telemetry confirms an overflow, or the same scoped recovery key receives another strong `context_length_exceeded`/`input` signal after its guarded retry. Confirmed overflows may extend the retry allowance so repeated overflows can compact again and continue on the same socket.
- Provider request assembly/submission starts with the later hidden prompt send in `sendMateriaTurn` via `{ triggerTurn: true }`. Pi core handles that in `dist/core/agent-session.js:sendCustomMessage()`, which calls `agent.prompt(appMessage)`. `@earendil-works/pi-agent-core/dist/agent.js:Agent.createContextSnapshot()` copies the current system prompt, messages, and tools, then `dist/agent-loop.js:streamAssistantResponse()` runs `transformContext` (wired in `dist/core/sdk.js` to `ExtensionRunner.emitContext()`), converts messages with `convertToLlm`, builds `{ systemPrompt, messages, tools }`, and calls `streamSimple(...)`. Provider modules then build the provider-specific payload and call `options.onPayload`/`before_provider_request` immediately before network submission.

### Multi-turn finalization: synthetic context ownership

The synthetic cast context (`buildSyntheticCastContext(state)`) for multi-turn
finalization turns is supplied **solely** by the `buildIsolatedMateriaContext`
prepend in `src/index.ts` (the Pi `context` event handler). The finalization
prompt itself (`buildMultiTurnFinalizationPrompt`) no longer embeds it, and
`buildJsonOutputRepairRetryPrompt` only embeds it for single-turn repair paths
(`!state.multiTurnFinalizing`). Since the isolation prepend runs before the
prompt is assembled for every isolated turn — including finalization and all
recovery/retry re-dispatch paths — the agent always receives the synthetic
context without duplication.

Token projection in `maybeRunProactiveCompaction` already accounts for
`buildSyntheticCastContext` as a separate projection field
(`syntheticCastContext` in the `ContextProjectionInput`, see
src/runtime/agentPromptDispatch.ts ~L262). Because the prompt no longer embeds
the synthetic context, there is no double-counting in the projection or in the
actual submitted context.

Finalization-marked `pi-materia-prompt` messages (`details.finalization === true`)
do **not** serve as isolation anchors. `findActiveMateriaPromptIndex` skips them
so the anchor resolves to the socket visit's initial hidden prompt (see
docs/multiturn-continuation-semantics.md). This has no direct impact on
compaction token accounting, but it is important context for understanding which
messages appear in the isolated slice that compaction budgets for.

## Pi-aligned proactive compaction budget

By default, Materia follows Pi's reserve model rather than selecting a percentage tier. For an effective active-model context window `W`, the usable request budget is:

```text
usableBudget = W - 16,384
```

The derived `thresholdPercent` remains available for diagnostics, but the default decision is made directly in tokens. For example, a 272,000-token model has a usable budget of 255,616 tokens, or about 93.98% (approximately 94%) of its context window.

Default boundary semantics are deliberately strict: Materia compacts when the raw token total **or** projected token total is `> usableBudget`. A total exactly equal to the budget does not compact; for the 272,000-token example, 255,616 does not cross the boundary and 255,617 does. The independent hard-window protection likewise triggers when the projected total is greater than the effective context window.

### Projected request accounting

The decision includes overhead not yet present in Pi's pre-turn `ctx.getContextUsage()` snapshot. `src/runtime/agentPromptDispatch.ts:maybeRunProactiveCompaction` estimates the same content that the next request will submit:

- `state.activeTurnPrompt` — the full hidden Materia prompt, including its wrappers and adapter instructions;
- `buildSyntheticCastContext(state)` — the synthetic user message that replaces prior visible transcript during isolation;
- `activeMateriaSystemPrompt(state, materia)` — the Materia suffix appended to the system prompt;
- a conservative 2,000-token safety margin for provider-specific tokenization variance.

Content estimates use the chars/4 heuristic that matches Pi core's fallback. The resulting `projectedOverhead` contains `promptTokens`, `castContextTokens`, `systemPromptTokens`, `safetyMarginTokens`, and `total`. `assessContextPressureForCompaction` adds that total to reported usage before applying the strict reserve-budget boundary. Consequently, a raw usage percentage around 50–55% does not itself cause default compaction; only an actual raw or projected budget crossing does.

### Configuration precedence and missing metadata

Threshold resolution uses this precedence:

1. `compaction.proactiveThresholdPercent`;
2. a matching entry in `compaction.proactiveThresholdTiers`;
3. the default 16,384-token reserve budget.

The explicit percentage and configured-tier modes preserve their existing inclusive percentage comparison (`>= thresholdPercent`) rather than adopting the default mode's strict token comparison. Configured tiers are min-inclusive/max-exclusive and must cover context windows from zero through an open-ended final tier without gaps or overlaps.

The effective context window comes from the active model when available, then from Pi's usage snapshot. If neither source provides valid context-window metadata, the default reserve budget and its diagnostic percentage remain unresolved and Materia does not proactively compact on an arbitrary fallback percentage. An explicit single percentage can still be applied from Pi's reported percentage; configured tiers require context-window metadata to select a tier.

### Telemetry and same-socket overflow recovery

`proactive_compaction_start`, `proactive_compaction_complete`, and `proactive_compaction_failed` include `projectedTokens`, `projectedPercent`, and `projectedOverhead` when projection data is available. In default reserve mode they also include `usableBudget` and `reserve`; these fields are conditional and do not alter telemetry for explicit percentage or tier overrides. Thus a 272,000-token default reports `usableBudget: 255616` and `reserve: 16384` on both successful and failed proactive compaction paths.

A provider context-window error enters the same evidence-gated recovery path. The `context_window_recovery_decision` event records pressure diagnostics, including `thresholdMode`, and conditionally `usableBudget` and `reserve` when active-model metadata resolved the default budget. With missing metadata, those reserve fields are omitted and a first strong provider signal remains a guarded retry without compaction. Explicit threshold overrides retain their normal pressure behavior.

Recovery compacts when the reserve-aware assessment is over budget, when provider token telemetry confirms an overflow, or when a strong context-window signal repeats after the guarded retry. It preserves retry allowances and redispatches the recovery prompt on the same socket. If confirmed overflow telemetry arrives again after a compact retry would otherwise exhaust the allowance, Materia grants the needed additional attempt so it can compact again and continue same-socket recovery.
