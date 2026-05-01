# Usage cost underreporting investigation

Task: `task-1` from cast `2026-05-01T18-28-31-129Z`.

## Real current-run payload shape

The current run artifact `.pi/pi-materia/2026-05-01T18-28-31-129Z/usage.json` shows that the `openai-codex/gpt-5.5` assistant message usage captured by pi-materia is already normalized into Pi's assistant usage shape:

```json
{
  "tokens": {
    "input": 11009,
    "output": 671,
    "cacheRead": 5120,
    "cacheWrite": 0,
    "total": 16800
  },
  "cost": {
    "input": 0.055045000000000004,
    "output": 0.020130000000000002,
    "cacheRead": 0.0025599999999999998,
    "cacheWrite": 0,
    "total": 0.077735
  },
  "model": "gpt-5.5",
  "provider": "openai-codex",
  "api": "openai-codex-responses",
  "thinkingLevel": "medium"
}
```

The component costs match model-registry estimated USD pricing, not a billed Codex subscription charge:

- input: `11009 * $5 / 1_000_000 = $0.055045`
- output: `671 * $30 / 1_000_000 = $0.02013`
- cache read: `5120 * $0.50 / 1_000_000 = $0.00256`
- total: `$0.077735`

This same shape is what would aggregate into summaries such as the reported `312737 tokens, $0.5316`; it is an estimated token value derived from components, not evidence of actual per-token billing for a Codex subscription.

## Pi provider behavior inspected

The installed Pi provider code for OpenAI/Codex responses constructs assistant usage from raw response usage and then calls model-registry pricing:

- `@mariozechner/pi-ai/dist/providers/openai-responses-shared.js` maps raw `response.usage.input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`, and `total_tokens` into `usage.input`, `usage.output`, `usage.cacheRead`, and `usage.totalTokens`.
- `@mariozechner/pi-ai/dist/models.js` calculates `usage.cost.{input,output,cacheRead,cacheWrite,total}` as USD from configured per-million-token model costs.
- `@mariozechner/pi-ai/dist/providers/openai-codex-responses.js` can additionally apply a service-tier multiplier, then recomputes total from components.

So, for the observed `openai-codex/gpt-5.5` path, costs do not arrive from the Codex subscription API as cents or microdollars. Pi estimates USD from token counts.

## src/usage.ts flaw identified

`src/usage.ts` extracts component costs and then prefers any provider/Pi total alias directly:

```ts
const providedCostTotal = firstNumber(cost, ["total", "totalCost", "totalUsd", "costUsd", "usd"])
  ?? numberOrUndefined(costValue)
  ?? firstNumber(usage, ["totalCost", "totalCostUsd", "totalUsd", "costUsd", "usd"]);
const costTotal = providedCostTotal ?? costInput + costOutput + costCacheRead + costCacheWrite;
```

That means a stale, rounded, or partial `total` can underreport the sum of trustworthy normalized component costs. A regression test was added that models this payload shape and currently fails, proving the extractor can report a total lower than its own components.

A separate display issue remains: current UI labels the value as `cost: $...`, which implies billed charges even though Codex subscription usage is represented here as estimated token value.
