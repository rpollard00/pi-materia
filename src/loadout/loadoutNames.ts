export function makeDuplicateLoadoutName(existingNames: Iterable<string> | Record<string, unknown>, name: string): string {
  const names = existingNames instanceof Set
    ? existingNames
    : Array.isArray(existingNames)
      ? new Set(existingNames)
      : new Set(Object.keys(existingNames));
  const baseName = `${name} Copy`;
  if (!names.has(baseName)) return baseName;
  let suffix = 2;
  while (names.has(`${baseName} ${suffix}`)) suffix += 1;
  return `${baseName} ${suffix}`;
}
