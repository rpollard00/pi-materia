export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = Math.min(
    ...[candidate.indexOf("{"), candidate.indexOf("[")].filter((i) => i >= 0),
  );
  if (!Number.isFinite(start)) throw new Error(`No JSON found in agent output: ${text.slice(0, 400)}`);
  return JSON.parse(candidate.slice(start)) as T;
}
