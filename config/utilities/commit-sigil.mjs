#!/usr/bin/env node

/**
 * Commit-Sigil — deterministic generator utility materia.
 * Validates Conventional Commit title semantics on every work item,
 * echoes the input workItems array unchanged, and reports
 * satisfied/context for graph routing.
 *
 * Output contract (every stdout JSON path):
 *   { workItems, satisfied, context }
 */

// Conventional Commit types per spec, plus common ecosystem additions.
const STANDARD_TYPES = new Set([
  "build", "chore", "ci", "docs", "feat", "fix", "perf",
  "refactor", "revert", "style", "test",
]);

// Matches type[(scope)][!]: summary
const CC_REGEX = /^(?<type>[a-z]+)(?<scope>\([^)]+\))?(?<breaking>!)?: (?<summary>[^\s].*)$/;

try {
  const input = await readStdinJson();

  // Consume runtime input from state.workItems, optionally top-level
  // workItems for direct script tests. Never alias tasks/work.
  const raw = Array.isArray(input?.state?.workItems)
    ? input.state.workItems
    : Array.isArray(input?.workItems)
      ? input.workItems
      : null;

  // Preserve the canonical array identity — deep-copy so we echo the
  // input unchanged while validating titles in isolation.
  const workItems = raw !== null ? structuredClone(raw) : [];

  // Empty input: no work items to validate.
  if (!Array.isArray(workItems) || workItems.length === 0) {
    writeStdoutJson({
      workItems: [],
      satisfied: true,
      context: "Commit-Sigil: no work items to validate.",
    });
    process.exit(0);
  }

  const issues = [];
  let allSatisfied = true;

  for (let i = 0; i < workItems.length; i++) {
    const item = workItems[i];
    if (!item || typeof item !== "object") continue;

    // Trim only for validation checks; never rewrite titles or add fields.
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) {
      allSatisfied = false;
      issues.push(`- Item ${i} (missing title): every work item must have a non-empty title string.`);
      continue;
    }

    const match = title.match(CC_REGEX);

    if (!match) {
      allSatisfied = false;
      const suggestion = suggestCorrection(title);
      issues.push(`- Item ${i} (${JSON.stringify(title)}): does not match Conventional Commit format.\n  Suggested: ${JSON.stringify(suggestion)}`);
      continue;
    }

    const { type } = match.groups;

    if (!STANDARD_TYPES.has(type)) {
      // Non-standard type — structurally valid but flag as advisory.
      // Don't fail on non-standard types; the structure is correct.
      issues.push(`- Item ${i} (${JSON.stringify(title)}): non-standard type "${type}" (structural format is valid).`);
    }
  }

  if (allSatisfied) {
    const advisory = issues.length > 0
      ? `\n\nAdvisories:\n${issues.join("\n")}`
      : "";
    writeStdoutJson({
      workItems,
      satisfied: true,
      context: `Commit-Sigil: all ${workItems.length} work item title(s) conform to Conventional Commit format.${advisory}`,
    });
  } else {
    writeStdoutJson({
      workItems,
      satisfied: false,
      context: `Commit-Sigil: work item title validation failed.\n\n${issues.join("\n\n")}\n\nEach work item title must match Conventional Commit format: type[(scope)][!]: summary (e.g. "feat: add login", "fix(auth): handle timeout"). Accepted types: ${[...STANDARD_TYPES].join(", ")}.`,
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeStdoutJson({
    workItems: [],
    satisfied: false,
    context: `Commit-Sigil: unexpected error: ${message}`,
  });
}

function suggestCorrection(title) {
  if (!title || typeof title !== "string") return "chore: update";

  const trimmed = title.trim();

  // Detect uppercase start and try lowercase conversion
  const loweredType = lowercaseFirstWord(trimmed);
  const loweredMatch = loweredType.match(CC_REGEX);
  if (loweredMatch && STANDARD_TYPES.has(loweredMatch.groups.type)) {
    return loweredType;
  }

  // Try to find a colon anywhere and restructure
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0 && colonIdx < trimmed.length - 1) {
    const prefix = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const summary = trimmed.slice(colonIdx + 1).trim();
    if (summary.length > 0) {
      // Check if prefix looks like a type (alphabetic)
      if (/^[a-z]+(\([^)]*\))?!?$/.test(prefix)) {
        const type = prefix.replace(/[(!].*$/, "");
        if (STANDARD_TYPES.has(type) || /^[a-z]+$/.test(type)) {
          // Strip empty parens / malformed scope from the reconstructed prefix
          const cleanPrefix = stripEmptyScope(prefix);
          return `${cleanPrefix}: ${summary}`;
        }
      }
      // Try extracting a type-like first word
      const firstWord = prefix.split(/[ (]/)[0].toLowerCase();
      if (STANDARD_TYPES.has(firstWord)) {
        return `${firstWord}: ${summary}`;
      }
      // Fallback: use prefix as scope
      const cleanPrefix = prefix.replace(/[^a-z0-9-]/g, "").slice(0, 36);
      if (cleanPrefix) {
        return `chore(${cleanPrefix}): ${summary}`;
      }
      return `chore: ${summary}`;
    }
  }

  // No colon — try to produce a sensible conventional commit
  const words = trimmed.split(/\s+/);
  if (words.length === 0) return "chore: update";

  // If the first word looks like a type, use it
  const first = words[0].toLowerCase().replace(/[^a-z]/g, "");
  if (STANDARD_TYPES.has(first)) {
    return `${first}: ${trimmed}`;
  }

  // Default: prefix with chore
  return `chore: ${trimmed}`;
}

function stripEmptyScope(prefix) {
  return prefix.replace(/\(\s*\)/, "");
}

function lowercaseFirstWord(text) {
  const idx = text.search(/[a-zA-Z]/);
  if (idx < 0) return text;
  const before = text.slice(0, idx);
  const first = text[idx];
  const after = text.slice(idx + 1);
  const lowered = first.toLowerCase();
  if (lowered === first) return text;
  return before + lowered + after;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeStdoutJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
