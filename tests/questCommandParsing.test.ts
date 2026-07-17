import { describe, expect, test } from "bun:test";
import {
  parseQuestListArgs as parseQuestListArgsCompatibility,
  parseQuestMoveArgs as parseQuestMoveArgsCompatibility,
} from "../src/index.js";
import {
  parseQuestAddArgs,
  parseQuestListArgs,
  parseQuestMoveArgs,
  tokenizeCommandArgs,
} from "../src/plugin/quest/commandParsing.js";

const listUsage = "Usage: /materia quest list [pending|all|succeeded|failed] [--limit <n>]";
const moveUsage = "Usage: /materia quest move <quest> --first|--before <target>|--onto <target> (--onto means after target). Quest IDs accept unambiguous prefixes.";
const addUsage = "Usage: /materia quest add [--loadout <name>] <prompt>";

describe("quest command tokenization", () => {
  test("preserves quoted arguments and strips their surrounding quotes", () => {
    expect(tokenizeCommandArgs(String.raw`  add --loadout "Full Auto" "Say \"hello\"" 'and more'  `)).toEqual([
      "add",
      "--loadout",
      "Full Auto",
      String.raw`Say \"hello\"`,
      "and more",
    ]);
  });

  test("returns no tokens for blank input", () => {
    expect(tokenizeCommandArgs("  \t ")).toEqual([]);
  });
});

describe("quest add argument parsing", () => {
  test("accepts quoted prompts and both loadout option forms", () => {
    expect(parseQuestAddArgs(tokenizeCommandArgs('--loadout "Full Auto" "Fix parser behavior"'))).toEqual({
      ok: true,
      prompt: "Fix parser behavior",
      loadoutOverride: "Full Auto",
    });
    expect(parseQuestAddArgs(["first", "--loadout=Other", "second"])).toEqual({
      ok: true,
      prompt: "first second",
      loadoutOverride: "Other",
    });
  });

  test("preserves the accepted last-loadout-wins behavior", () => {
    expect(parseQuestAddArgs(["--loadout", "First", "--loadout=Second", "do", "work"])).toEqual({
      ok: true,
      prompt: "do work",
      loadoutOverride: "Second",
    });
  });

  test("preserves usage and unknown-option errors", () => {
    expect(parseQuestAddArgs([])).toEqual({ ok: false, error: addUsage });
    expect(parseQuestAddArgs(["--loadout"])).toEqual({ ok: false, error: addUsage });
    expect(parseQuestAddArgs(["--loadout="])).toEqual({ ok: false, error: addUsage });
    expect(parseQuestAddArgs(["--other", "prompt"])).toEqual({
      ok: false,
      error: "Unknown /materia quest add option --other.",
    });
  });
});

describe("quest list argument parsing", () => {
  test("defaults to pending with limit 10", () => {
    expect(parseQuestListArgs([])).toEqual({ ok: true, args: { filter: "pending", limit: 10 } });
  });

  test("accepts explicit filters and both limit forms in either order", () => {
    expect(parseQuestListArgs(["pending"])).toEqual({ ok: true, args: { filter: "pending", limit: 10 } });
    expect(parseQuestListArgs(["all", "--limit", "25"])).toEqual({ ok: true, args: { filter: "all", limit: 25 } });
    expect(parseQuestListArgs(["--limit=3", "succeeded"])).toEqual({ ok: true, args: { filter: "succeeded", limit: 3 } });
    expect(parseQuestListArgs(["failed", "--limit=1"])).toEqual({ ok: true, args: { filter: "failed", limit: 1 } });
  });

  test("preserves validation errors", () => {
    expect(parseQuestListArgs(["blocked"])).toEqual({
      ok: false,
      error: "Unknown /materia quest list filter blocked. Expected pending, all, succeeded, or failed.",
    });
    expect(parseQuestListArgs(["--foo"])).toEqual({
      ok: false,
      error: `Unknown /materia quest list option --foo. ${listUsage}`,
    });
    expect(parseQuestListArgs(["--limit"])).toEqual({ ok: false, error: listUsage });
    expect(parseQuestListArgs(["--limit", "0"])).toEqual({
      ok: false,
      error: `${listUsage}. Limit must be a positive safe integer.`,
    });
    expect(parseQuestListArgs(["--limit=-1"])).toEqual({
      ok: false,
      error: `${listUsage}. Limit must be a positive safe integer.`,
    });
    expect(parseQuestListArgs(["--limit", "1.5"])).toEqual({
      ok: false,
      error: `${listUsage}. Limit must be a positive safe integer.`,
    });
    expect(parseQuestListArgs(["--limit", String(Number.MAX_SAFE_INTEGER + 1)])).toEqual({
      ok: false,
      error: `${listUsage}. Limit must be a positive safe integer.`,
    });
    expect(parseQuestListArgs(["--limit=1", "--limit", "2"])).toEqual({
      ok: false,
      error: `${listUsage}. Specify --limit only once.`,
    });
    expect(parseQuestListArgs(["pending", "all"])).toEqual({
      ok: false,
      error: `${listUsage}. Specify at most one filter.`,
    });
  });
});

describe("quest move argument parsing", () => {
  test("accepts exactly one placement option", () => {
    expect(parseQuestMoveArgs(["quest-a", "--first"])).toEqual({ ok: true, args: { questRef: "quest-a", placement: "first" } });
    expect(parseQuestMoveArgs(["abc", "--before", "def"])).toEqual({ ok: true, args: { questRef: "abc", placement: "before", targetRef: "def" } });
    expect(parseQuestMoveArgs(["abc", "--before=def"])).toEqual({ ok: true, args: { questRef: "abc", placement: "before", targetRef: "def" } });
    expect(parseQuestMoveArgs(["abc", "--onto=def"])).toEqual({ ok: true, args: { questRef: "abc", placement: "after", targetRef: "def" } });
  });

  test("preserves placement validation errors", () => {
    expect(parseQuestMoveArgs(["abc"])).toEqual({ ok: false, error: moveUsage });
    expect(parseQuestMoveArgs(["abc", "--onto"])).toEqual({ ok: false, error: moveUsage });
    expect(parseQuestMoveArgs(["abc", "--last"])).toEqual({
      ok: false,
      error: `Unknown /materia quest move option --last. ${moveUsage}`,
    });
    expect(parseQuestMoveArgs(["abc", "--first", "--onto", "def"])).toEqual({
      ok: false,
      error: `${moveUsage} Specify exactly one placement option.`,
    });
  });
});

describe("quest parsing compatibility exports", () => {
  test("keeps list and move parsers available from the package entrypoint", () => {
    expect(parseQuestListArgsCompatibility).toBe(parseQuestListArgs);
    expect(parseQuestMoveArgsCompatibility).toBe(parseQuestMoveArgs);
  });
});
