import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { deriveSocketOutputRequirements } from "../src/handoff/socketOutputRequirements.js";
import {
  createToolBackedHandoffPrototype,
  TOOL_BACKED_HANDOFF_NAMES,
} from "../src/prototype/toolBackedHandoffTools.js";
import type { ToolBackedHandoffCommit } from "../src/prototype/toolBackedHandoffSubmission.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "finalization");
const malformedFixtureNames = [
  "malformed-unescaped-quote.txt",
  "malformed-literal-newline.txt",
  "malformed-backslash.txt",
] as const;

function validateArguments(tool: ToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: `call-${tool.name}`,
    name: tool.name,
    arguments: args,
  };
  return validateToolArguments(tool, toolCall) as Record<string, unknown>;
}

async function invoke(tool: ToolDefinition, args: Record<string, unknown> = {}) {
  const validated = validateArguments(tool, args);
  return tool.execute(`call-${tool.name}`, validated, undefined, undefined, {} as ExtensionContext);
}

describe("tool-backed handoff submission prototype", () => {
  test("accumulates small calls and runtime-serializes a canonical escaping-heavy envelope", async () => {
    const commits: ToolBackedHandoffCommit[] = [];
    const requirements = deriveSocketOutputRequirements({
      socket: {
        parse: "json",
        assign: {
          workItems: "$.workItems",
          finalContext: "$.context",
          finalText: "$.text",
        },
        edges: [{ when: "satisfied", to: "end" }],
      },
      renderableTextIntent: true,
    });
    const prototype = createToolBackedHandoffPrototype({
      socketId: "Prototype-Socket",
      requirements,
      onCommit: (commit) => commits.push(commit),
    });

    // Submit out of envelope order to verify that serialization order belongs
    // to runtime code rather than the model/tool invocation sequence.
    const context = "Quoted \"command\"\r\nWindows C:\\Users\\materia\\repo and literal \\n; 東京 🧪";
    const text = "First line\nSecond line with regex ^foo\\s+bar$ and emoji 🚀";
    await invoke(prototype.tools.setContext, { context });
    await invoke(prototype.tools.setText, { text });
    await invoke(prototype.tools.setSatisfied, { satisfied: true });
    await invoke(prototype.tools.addWorkItem, {
      title: "feat: preserve \"quoted\" values",
      context: "Run `npm test -- --filter=\"handoff\"` from C:\\repo.\nKeep \\n literal.",
    });
    await invoke(prototype.tools.addWorkItem, {
      title: "test: cover Unicode 東京 🧪",
      context: "Preserve combining é, tabs\t, CRLF\r\n, and a UNC path \\\\server\\share.",
    });
    const result = await invoke(prototype.tools.commit);

    expect(result.terminate).toBe(true);
    expect(commits).toHaveLength(1);
    const committed = commits[0];
    expect(Object.keys(committed.envelope)).toEqual(["workItems", "satisfied", "context", "text"]);
    expect(committed.json).not.toContain("\n");
    expect(JSON.parse(committed.json)).toEqual({
      workItems: [
        {
          title: "feat: preserve \"quoted\" values",
          context: "Run `npm test -- --filter=\"handoff\"` from C:\\repo.\nKeep \\n literal.",
        },
        {
          title: "test: cover Unicode 東京 🧪",
          context: "Preserve combining é, tabs\t, CRLF\r\n, and a UNC path \\\\server\\share.",
        },
      ],
      satisfied: true,
      context,
      text,
    });
  });

  test("eliminates malformed envelope syntax for the deterministic fixture replay once strings arrive as parsed arguments", async () => {
    let directJsonFailures = 0;
    let toolCommitFailures = 0;

    for (const fixtureName of malformedFixtureNames) {
      const malformedDirectOutput = await readFile(path.join(fixtureRoot, fixtureName), "utf8");
      try {
        JSON.parse(malformedDirectOutput);
      } catch {
        directJsonFailures += 1;
      }

      let committed: ToolBackedHandoffCommit | undefined;
      const prototype = createToolBackedHandoffPrototype({
        onCommit: (value) => { committed = value; },
      });
      await invoke(prototype.tools.setContext, { context: malformedDirectOutput });
      try {
        await invoke(prototype.tools.commit);
        expect(JSON.parse(committed!.json).context).toBe(malformedDirectOutput);
      } catch {
        toolCommitFailures += 1;
      }
    }

    expect(directJsonFailures).toBe(3);
    expect(toolCommitFailures).toBe(0);
  });

  test("uses Pi's tool-call validation before execution and domain validation before commit", async () => {
    const prototype = createToolBackedHandoffPrototype();
    const add = prototype.tools.addWorkItem;

    expect(() => validateArguments(add, { title: "feat: missing context" })).toThrow(/Validation failed/);
    expect(() => validateArguments(add, { title: "feat: array context", context: [] })).toThrow(/Validation failed/);
    expect(() => validateArguments(add, {
      title: "feat: unexpected field",
      context: "valid",
      acceptance: ["not canonical"],
    })).toThrow(/Validation failed/);
    expect(prototype.submission.snapshot()).toEqual({});

    // minLength cannot express trim-aware non-empty semantics, so the domain
    // accumulator remains the second validation layer.
    await expect(invoke(add, { title: "   ", context: "valid" })).rejects.toThrow(/title is required/);
    expect(prototype.submission.snapshot()).toEqual({});
  });

  test("supports an explicitly empty required workItems array and rejects duplicate commits", async () => {
    const requirements = deriveSocketOutputRequirements({
      socket: { parse: "json" },
      workItemsProducer: true,
    });
    const prototype = createToolBackedHandoffPrototype({ requirements, workItemsProducer: true });

    await expect(invoke(prototype.tools.commit)).rejects.toThrow(/Missing required field "workItems"/);
    await invoke(prototype.tools.beginWorkItems);
    await invoke(prototype.tools.commit);

    expect(prototype.submission.committedValue()?.envelope).toEqual({ workItems: [] });
    await expect(invoke(prototype.tools.commit)).rejects.toThrow(/already been committed/);
    await expect(invoke(prototype.tools.setContext, { context: "late" })).rejects.toThrow(/already been committed/);
  });

  test("keeps the accumulator retryable when the host commit callback fails", async () => {
    let attempts = 0;
    const prototype = createToolBackedHandoffPrototype({
      onCommit: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("prototype persistence unavailable");
      },
    });
    await invoke(prototype.tools.setContext, { context: "retry safely" });

    await expect(invoke(prototype.tools.commit)).rejects.toThrow(/persistence unavailable/);
    expect(prototype.submission.committedValue()).toBeUndefined();
    await invoke(prototype.tools.commit);
    expect(prototype.submission.committedValue()?.envelope).toEqual({ context: "retry safely" });
  });

  test("retains socket-aware canonical validation at the commit boundary", async () => {
    const requirements = deriveSocketOutputRequirements({
      socket: { parse: "json" },
      renderableTextIntent: false,
    });
    const prototype = createToolBackedHandoffPrototype({ requirements });

    await invoke(prototype.tools.setText, { text: "misplaced prose" });
    await expect(invoke(prototype.tools.commit)).rejects.toThrow(/not configured for renderable text output/);
    expect(TOOL_BACKED_HANDOFF_NAMES.commit).toBe("materia_handoff_commit");
  });
});
