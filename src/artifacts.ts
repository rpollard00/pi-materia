export function safePathSegment(input: string): string {
  return input.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "task";
}

let lastSafeTimestampBase = "";
let lastSafeTimestampSequence = 0;

export function safeTimestamp(): string {
  const base = new Date().toISOString().replace(/[:.]/g, "-");
  if (base === lastSafeTimestampBase) {
    lastSafeTimestampSequence += 1;
  } else {
    lastSafeTimestampBase = base;
    lastSafeTimestampSequence = 0;
  }
  return lastSafeTimestampSequence === 0 ? base : `${base}-${lastSafeTimestampSequence}`;
}
