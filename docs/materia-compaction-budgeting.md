# Materia compaction and request budgeting audit

This note documents the current Pi-native Materia context path as of this audit.

## Code paths

- Transcript/tool accumulation is owned by Pi core. Materia appends cast state with `pi.appendEntry("pi-materia-cast-state", ...)`, visible status messages with `pi.sendMessage({ customType: "pi-materia", ... })`, and hidden role prompts with `pi.sendMessage({ customType: "pi-materia-prompt", content: prompt }, { triggerTurn: true })` in `src/native.ts:sendMateriaTurn`.
- Pi core context-usage reporting flows through `dist/core/extensions/runner.js:createContext().getContextUsage()` to `dist/core/agent-session.js:AgentSession.getContextUsage()`. That method reads the active model `contextWindow`, rejects stale post-compaction usage, then calls `estimateContextTokens(this.messages)` from `dist/core/compaction/compaction.js`. `estimateContextTokens` uses the last assistant provider usage plus local `estimateTokens` for trailing messages, or chars/4 for all messages if there is no assistant usage. It operates on `this.messages` as they exist before Materia sends the next hidden prompt and before context/system hooks run.
- Pi compaction itself uses `dist/core/agent-session.js:compactContext()`/`_runAutoCompaction()`, `dist/core/compaction/compaction.js:prepareCompaction()` and `compact()`, then rebuilds `agent.state.messages` with `dist/core/session-manager.js:buildSessionContext()` after appending a compaction entry.
- Context isolation happens in `src/index.ts` on the Pi `context` event. It calls `buildIsolatedMateriaContext(...)`, which replaces prior visible transcript before the active Materia prompt with a synthetic user message from `buildSyntheticCastContext(state)`, then keeps messages from the active role prompt onward. Tool and assistant messages from the active role turn are intentionally kept.
- System/developer prompt augmentation happens separately in `src/index.ts` on `before_agent_start`, which appends `activeRoleSystemPrompt(...)` to Pi's existing system prompt.
- Proactive compaction is checked only in `src/native.ts:sendMateriaTurn` before writing the context artifact and before sending the hidden prompt. It calls `maybeRunProactiveCompaction`, which uses Pi's pre-turn `ctx.getContextUsage()` snapshot and a tiered default threshold selected from the effective active model context window: 75% below 128,000 tokens, 65% from 128,000 through 199,999, and 55% at 200,000 or above. If context-window metadata is unavailable, Materia falls back to the conservative 55% tier. It then calls `ctx.compact(...)` when the reported/recomputed percentage is high enough.
- Provider request assembly/submission starts with the later hidden prompt send in `sendMateriaTurn` via `{ triggerTurn: true }`. Pi core handles that in `dist/core/agent-session.js:sendCustomMessage()`, which calls `agent.prompt(appMessage)`. `@mariozechner/pi-agent-core/dist/agent.js:Agent.createContextSnapshot()` copies the current system prompt, messages, and tools, then `dist/agent-loop.js:streamAssistantResponse()` runs `transformContext` (wired in `dist/core/sdk.js` to `ExtensionRunner.emitContext()`), converts messages with `convertToLlm`, builds `{ systemPrompt, messages, tools }`, and calls `streamSimple(...)`. Provider modules then build the provider-specific payload and call `options.onPayload`/`before_provider_request` immediately before network submission.

## Mismatch found

The current proactive compaction decision is based on Pi's pre-turn `ctx.getContextUsage()` snapshot. That snapshot does not include all bytes/tokens that are added after the check or by hooks during request assembly:

- the hidden Materia prompt that is sent after the check,
- the synthetic isolated cast context inserted by the `context` event,
- the role-system prompt appended by `before_agent_start`, plus Pi's base system/developer prompts,
- active-turn tool results retained after the active Materia prompt,
- provider-specific tokenization overhead/variance.

Therefore a log such as `[compaction] Compacted from 20,789 tokens` can still be followed by an oversized provider request: the compacted transcript can be small, while the next request adds large Materia synthetic context, role prompt material, and/or large tool output that were not part of the proactive threshold snapshot.

The focused regression test `tests/compactionBudgetNative.test.ts` captures this risk with a large grep-like request: reported context usage stays below the threshold, no proactive compaction runs, yet the hidden role prompt and isolated synthetic context both contain large content that will be submitted on the next provider turn.
