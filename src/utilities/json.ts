export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = Math.min(
    ...[candidate.indexOf("{"), candidate.indexOf("[")].filter((i) => i >= 0),
  );
  if (!Number.isFinite(start)) throw new Error(`No JSON found in agent output: ${text.slice(0, 400)}`);

  const jsonish = candidate.slice(start);
  try {
    return JSON.parse(jsonish) as T;
  } catch {
    const balanced = extractBalancedJson(jsonish);
    if (!balanced) throw new Error(`Could not parse JSON from agent output: ${text.slice(0, 400)}`);
    return JSON.parse(balanced) as T;
  }
}

function extractBalancedJson(value: string): string | undefined {
  const opener = value[0];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : undefined;
  if (!closer) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) return value.slice(0, i + 1);
    }
  }
  return undefined;
}
