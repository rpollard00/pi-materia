import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [file] : [];
  });
}

test("Materia architecture keeps display cards out of sendMessage", () => {
  const violations: string[] = [];
  let intentionalPromptDispatches = 0;

  for (const file of sourceFiles(path.resolve("src"))) {
    // This guard is deliberately source-level: the presentation contract must
    // remain enforceable even when a runtime test does not execute a command.
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    for (const call of source.matchAll(/(?:\b\w+\.)?sendMessage\s*\([\s\S]*?\)\s*;/g)) {
      if (/customType\s*:\s*["']pi-materia["']/.test(call[0])) violations.push(file);
      if (/customType\s*:\s*["']pi-materia-presentation["']/.test(call[0])) violations.push(file);
      if (/customType\s*:\s*["']pi-materia-prompt["']/.test(call[0])) intentionalPromptDispatches += 1;
    }
  }

  expect(violations).toEqual([]);
  expect(intentionalPromptDispatches).toBeGreaterThan(0);
});
