# Materia compaction and request budgeting audit

This note documents the current Pi-native Materia context path as of this audit.

## Code paths

- Transcript/tool accumulation is owned by Pi core. Materia appends cast state with `pi.appendEntry("pi-materia-cast-state", ...)`, visible status messages with `pi.sendMessage({ customType: "pi-materia", ... })`, and hidden materia prompts with `pi.sendMessage({ customType: "pi-materia-prompt", content: prompt }, { triggerTurn: true })` in `src/castRuntime.ts:sendMateriaTurn`.
- Pi core context-usage reporting flows through `dist/core/extensions/runner.js:createContext().getContextUsage()` to `dist/core/agent-session.js:AgentSession.getContextUsage()`. That method reads the active model `contextWindow`, rejects stale post-compaction usage, then calls `estimateContextTokens(this.messages)` from `dist/core/compaction/compaction.js`. `estimateContextTokens` uses the last assistant provider usage plus local `estimateTokens` for trailing messages, or chars/4 for all messages if there is no assistant usage. It operates on `this.messages` as they exist before Materia sends the next hidden prompt and before context/system hooks run.
- Pi compaction itself uses `dist/core/agent-session.js:compactContext()`/`_runAutoCompaction()`, `dist/core/compaction/compaction.js:prepareCompaction()` and `compact()`, then rebuilds `agent.state.messages` with `dist/core/session-manager.js:buildSessionContext()` after appending a compaction entry.
- Context isolation happens in `src/index.ts` on the Pi `context` event. It calls `buildIsolatedMateriaContext(...)`, which replaces prior visible transcript before the active Materia prompt with a synthetic user message from `buildSyntheticCastContext(state)`, then keeps messages from the active materia prompt onward. Tool and assistant messages from the active materia turn are intentionally kept.
- System/developer prompt augmentation happens separately in `src/index.ts` on `before_agent_start`, which appends `activeMateriaSystemPrompt(...)` to Pi's existing system prompt.
- Proactive compaction is checked only in `src/castRuntime.ts:sendMateriaTurn` before writing the context artifact and before sending the hidden prompt. It calls `maybeRunProactiveCompaction`, which computes a projected next-request overhead from the hidden Materia prompt content (`state.activeTurnPrompt`), synthetic isolated cast context (`buildSyntheticCastContext`), and system-prompt suffix (`activeMateriaSystemPrompt`), plus a conservative 2,000-token safety margin. The projection is passed to `assessContextPressureForCompaction` in `src/application/compactionWorkflow.ts`, which adds it to Pi's pre-turn `ctx.getContextUsage()` snapshot. Compaction triggers when the raw or projected percentage crosses a threshold resolved by `src/runtime/compaction.ts`: the backward-compatible `compaction.proactiveThresholdPercent` first, then configured `compaction.proactiveThresholdTiers`, otherwise the default tiers selected from the effective active model context window (75% below 128,000 tokens, 65% from 128,000 through 199,999, and 55% at 200,000 or above). Configured tiers are min-inclusive/max-exclusive and must cover 0..infinity without gaps or overlaps; if context-window metadata is unavailable, Materia falls back to the conservative 55% default unless a single configured percent is present. Compaction also triggers when projected tokens exceed the effective context window, guarding against requests that would immediately fail. It then calls `ctx.compact(...)` when any of these conditions are met. Projection fields are included in proactive compaction events for diagnostics.
- Same-socket context-window recovery is evidence-gated in `src/application/recoveryWorkflow.ts`. Provider `context_length_exceeded` responses can be transient or misleading, so a strong provider context signal is not enough by itself to force compaction on first sight. Recovery retries without compaction unless current context usage is near/over the proactive threshold or the same scoped recovery key has already retried once without compaction and then receives another strong `context_length_exceeded`/`input` signal.
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

## Proactive compaction with projected next-request overhead

The proactive compaction decision now includes projected next-request overhead in addition to Pi's pre-turn `ctx.getContextUsage()` snapshot. Before deciding whether to compact, Materia estimates the token cost of the pending hidden Materia prompt, the synthetic isolated cast context (built by `buildSyntheticCastContext`), and the active Materia system-prompt suffix (built by `activeMateriaSystemPrompt`), plus a conservative 2,000-token safety margin for provider-specific tokenization variance. These estimates use a chars/4 heuristic matching Pi core's fallback.

The projection is computed in `src/runtime/nativeLifecycle.ts:maybeRunProactiveCompaction` from the same content that will be submitted on the next turn:

- `state.activeTurnPrompt` — the full hidden Materia prompt (including `<materia-instructions>` wrappers and adapter instructions),
- `buildSyntheticCastContext(state)` — the synthetic user message that replaces prior visible transcript during context isolation,
- `activeMateriaSystemPrompt(state, materia)` — the materia system-prompt suffix appended by `before_agent_start`.

The projected overhead breakdown (`promptTokens`, `castContextTokens`, `systemPromptTokens`, `safetyMarginTokens`, `total`) is passed to `assessContextPressureForCompaction` in `src/application/compactionWorkflow.ts`, which adds it to the reported token count. Compaction is triggered when:

1. The raw pre-turn percentage crosses the configured threshold (existing behavior),
2. The projected percentage (after overhead) crosses the configured threshold, or
3. The projected token total exceeds the effective context window.

Projection fields (`projectedTokens`, `projectedPercent`, `projectedOverhead`) are included in `proactive_compaction_start`, `proactive_compaction_complete`, and `proactive_compaction_failed` events so that operators and diagnostics can distinguish threshold crossings that were detected via projection from those visible in the raw snapshot.
