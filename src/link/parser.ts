import { ok, type DomainIssue, type DomainResult } from "../domain/result.js";
import { LINK_COMMAND_NAME, type LinkCommandParseResult, type LinkTargetPrefix, type LinkTargetRef } from "./types.js";

/**
 * Parser boundary for `/materia link`.
 *
 * Responsibility: tokenize and validate command grammar only. It must not look up
 * materia/loadout names, load previous casts, compile graphs, or launch casts.
 */
export interface LinkCommandParser {
  parse(argumentsText: string, rawCommand?: string): DomainResult<LinkCommandParseResult>;
}

export type ParseLinkCommand = LinkCommandParser["parse"];

export function createLinkCommandParser(): LinkCommandParser {
  return { parse: parseLinkCommandArguments };
}

export function parseLinkCommandArguments(argumentsText: string, rawCommand?: string): DomainResult<LinkCommandParseResult> {
  const source = argumentsText ?? "";
  const delimiter = findPromptDelimiter(source);
  if (delimiter < 0) {
    return failure("link", "missing prompt delimiter `--`; usage: /materia link [--from <castId>] <target> [<target> ...] -- <prompt>");
  }

  const targetText = source.slice(0, delimiter).trim();
  const prompt = source.slice(delimiter + 2).trim();
  if (prompt.length === 0) return failure("link.prompt", "missing prompt text after `--`");

  const tokensResult = tokenizeTargetSection(targetText);
  if (!tokensResult.ok) return tokensResult;

  const issues: DomainIssue[] = [];
  const tokens = tokensResult.value;
  let fromCastId: string | undefined;
  const targetTokens: LinkToken[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "--from") {
      if (targetTokens.length > 0) issues.push({ path: `link.targets.${targetTokens.length}`, message: "`--from <castId>` must appear before link targets" });
      if (fromCastId !== undefined) issues.push({ path: "link.fromCastId", message: "duplicate `--from` option" });
      const next = tokens[index + 1];
      if (!next || next.value.length === 0 || next.value.startsWith("--")) {
        issues.push({ path: "link.fromCastId", message: "missing cast id after `--from`" });
      } else {
        fromCastId = next.value;
        index += 1;
      }
      continue;
    }
    targetTokens.push(token);
  }

  if (targetTokens.length === 0) issues.push({ path: "link.targets", message: "at least one link target is required before `--`" });

  const targets = targetTokens.map((token, order) => parseTargetToken(token, order, issues));
  if (issues.length > 0) return { ok: false, issues };

  return ok({
    invocation: {
      command: LINK_COMMAND_NAME,
      arguments: source.trim(),
      ...(rawCommand ? { raw: rawCommand } : {}),
    },
    targets,
    prompt,
    ...(fromCastId ? { fromCastId } : {}),
  });
}

interface LinkToken {
  raw: string;
  value: string;
}

function parseTargetToken(token: LinkToken, order: number, issues: DomainIssue[]): LinkTargetRef {
  const prefix = parsePrefix(token.value, `link.targets.${order}`, issues);
  const name = prefix ? token.value.slice(prefix.length + 1) : token.value;
  if (name.trim().length === 0) issues.push({ path: `link.targets.${order}`, message: "target name is required; use materia:<name> or loadout:<name>" });
  return {
    order,
    raw: token.raw,
    ...(prefix ? { prefix } : {}),
    name,
  };
}

function parsePrefix(value: string, path: string, issues: DomainIssue[]): LinkTargetPrefix | undefined {
  const colon = value.indexOf(":");
  if (colon <= 0) return undefined;
  const candidate = value.slice(0, colon);
  if (candidate === "materia" || candidate === "loadout") return candidate;
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(candidate)) {
    issues.push({ path, message: `unsupported target prefix ${JSON.stringify(candidate)}; use materia:<name> or loadout:<name>` });
  }
  return undefined;
}

function findPromptDelimiter(source: string): number {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "-" && source[index + 1] === "-" && isBoundary(source[index - 1]) && isBoundary(source[index + 2])) return index;
  }
  return -1;
}

function tokenizeTargetSection(source: string): DomainResult<LinkToken[]> {
  const issues: DomainIssue[] = [];
  const tokens: LinkToken[] = [];
  let raw = "";
  let value = "";
  let quote: string | undefined;
  let escaped = false;
  let tokenStarted = false;

  const flush = () => {
    if (!tokenStarted) return;
    tokens.push({ raw, value });
    raw = "";
    value = "";
    tokenStarted = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      raw += char;
      value += char;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      raw += char;
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      raw += char;
      if (char === quote) quote = undefined;
      else value += char;
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      raw += char;
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    raw += char;
    value += char;
    tokenStarted = true;
  }
  if (escaped) issues.push({ path: "link", message: "unterminated escape in link target section" });
  if (quote) issues.push({ path: "link", message: `unterminated ${quote === "'" ? "single" : "double"} quote in link target section` });
  flush();

  return issues.length > 0 ? { ok: false, issues } : ok(tokens);
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function failure(path: string, message: string): DomainResult<never> {
  return { ok: false, issues: [{ path, message }] };
}
