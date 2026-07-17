import type { QuestMovePlacement } from "../../domain/questBoard.js";
import type { QuestListFilter, QuestListOptions } from "../../presentation/questBoard.js";

export type QuestListArgs = QuestListOptions;

export type QuestListParseResult =
  | { ok: true; args: QuestListArgs }
  | { ok: false; error: string };

export interface QuestMoveArgs {
  questRef: string;
  placement: QuestMovePlacement;
  targetRef?: string;
}

export type QuestMoveParseResult =
  | { ok: true; args: QuestMoveArgs }
  | { ok: false; error: string };

export type QuestAddParseResult =
  | { ok: true; prompt: string; loadoutOverride?: string }
  | { ok: false; error: string };

export function tokenizeCommandArgs(args: string): string[] {
  return args.match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\S+/g)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
    return token;
  }) ?? [];
}

export function parseQuestListArgs(tokens: string[]): QuestListParseResult {
  const usage = "Usage: /materia quest list [pending|all|succeeded|failed] [--limit <n>]";
  const filters = new Set<QuestListFilter>(["pending", "all", "succeeded", "failed"]);
  let filter: QuestListFilter = "pending";
  let sawFilter = false;
  let limit = 10;
  let sawLimit = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--limit") {
      if (sawLimit) return { ok: false, error: `${usage}. Specify --limit only once.` };
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, error: usage };
      const parsed = parsePositiveSafeInteger(value);
      if (!parsed.ok) return { ok: false, error: `${usage}. Limit must be a positive safe integer.` };
      limit = parsed.value;
      sawLimit = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--limit=")) {
      if (sawLimit) return { ok: false, error: `${usage}. Specify --limit only once.` };
      const parsed = parsePositiveSafeInteger(token.slice("--limit=".length));
      if (!parsed.ok) return { ok: false, error: `${usage}. Limit must be a positive safe integer.` };
      limit = parsed.value;
      sawLimit = true;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, error: `Unknown /materia quest list option ${token}. ${usage}` };
    if (!filters.has(token as QuestListFilter)) return { ok: false, error: `Unknown /materia quest list filter ${token}. Expected pending, all, succeeded, or failed.` };
    if (sawFilter) return { ok: false, error: `${usage}. Specify at most one filter.` };
    filter = token as QuestListFilter;
    sawFilter = true;
  }

  return { ok: true, args: { filter, limit } };
}

export function parseQuestMoveArgs(tokens: string[]): QuestMoveParseResult {
  const usage = "Usage: /materia quest move <quest> --first|--before <target>|--onto <target> (--onto means after target). Quest IDs accept unambiguous prefixes.";
  const questRef = tokens[0];
  if (!questRef || questRef.startsWith("--")) return { ok: false, error: usage };
  let placement: QuestMovePlacement | undefined;
  let targetRef: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const setPlacement = (next: QuestMovePlacement, target?: string): { ok: true } | { ok: false; error: string } => {
      if (placement !== undefined) return { ok: false, error: `${usage} Specify exactly one placement option.` };
      placement = next;
      targetRef = target;
      return { ok: true };
    };
    if (token === "--first") {
      const set = setPlacement("first");
      if (!set.ok) return set;
      continue;
    }
    if (token === "--before" || token === "--onto") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, error: usage };
      const set = setPlacement(token === "--before" ? "before" : "after", value);
      if (!set.ok) return set;
      index += 1;
      continue;
    }
    if (token.startsWith("--before=")) {
      const value = token.slice("--before=".length).trim();
      if (!value) return { ok: false, error: usage };
      const set = setPlacement("before", value);
      if (!set.ok) return set;
      continue;
    }
    if (token.startsWith("--onto=")) {
      const value = token.slice("--onto=".length).trim();
      if (!value) return { ok: false, error: usage };
      const set = setPlacement("after", value);
      if (!set.ok) return set;
      continue;
    }
    return { ok: false, error: token.startsWith("--") ? `Unknown /materia quest move option ${token}. ${usage}` : usage };
  }

  if (placement === undefined) return { ok: false, error: usage };
  return { ok: true, args: { questRef, placement, ...(targetRef ? { targetRef } : {}) } };
}

export function parseQuestAddArgs(tokens: string[]): QuestAddParseResult {
  let loadoutOverride: string | undefined;
  const promptTokens: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--loadout") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, error: "Usage: /materia quest add [--loadout <name>] <prompt>" };
      loadoutOverride = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--loadout=")) {
      const value = token.slice("--loadout=".length).trim();
      if (!value) return { ok: false, error: "Usage: /materia quest add [--loadout <name>] <prompt>" };
      loadoutOverride = value;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, error: `Unknown /materia quest add option ${token}.` };
    promptTokens.push(token);
  }
  const prompt = promptTokens.join(" ").trim();
  if (!prompt) return { ok: false, error: "Usage: /materia quest add [--loadout <name>] <prompt>" };
  return { ok: true, prompt, ...(loadoutOverride ? { loadoutOverride } : {}) };
}

function parsePositiveSafeInteger(value: string): { ok: true; value: number } | { ok: false } {
  if (!/^[1-9]\d*$/.test(value)) return { ok: false };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { ok: false };
  return { ok: true, value: parsed };
}
