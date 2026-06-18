import { describe, expect, test } from "bun:test";
import {
  MATERIA_TEXT_OUTPUT_EVENT_TYPE,
  buildMateriaTextOutputMessage,
  extractMateriaTextOutput,
  formatMateriaTextOutputContent,
} from "../src/presentation/textOutput.js";
import { HANDOFF_TEXT_FIELD } from "../src/handoff/handoffContract.js";

describe("materia text output extraction", () => {
  test("returns trimmed prose for a handoff object with a non-empty text field", () => {
    expect(extractMateriaTextOutput({ [HANDOFF_TEXT_FIELD]: "  narration prose  " })).toBe("narration prose");
  });

  test("ignores transport metadata and only reads the canonical text field", () => {
    const parsed = {
      workItems: [{ title: "feat: x", context: "do x" }],
      satisfied: true,
      context: "handoff notes",
      [HANDOFF_TEXT_FIELD]: "Clean narration for the user.",
    };
    expect(extractMateriaTextOutput(parsed)).toBe("Clean narration for the user.");
  });

  test("returns undefined when text is missing, empty, or not a string", () => {
    expect(extractMateriaTextOutput({ satisfied: true })).toBeUndefined();
    expect(extractMateriaTextOutput({ [HANDOFF_TEXT_FIELD]: "   " })).toBeUndefined();
    expect(extractMateriaTextOutput({ [HANDOFF_TEXT_FIELD]: 42 })).toBeUndefined();
    expect(extractMateriaTextOutput({ [HANDOFF_TEXT_FIELD]: ["nested"] })).toBeUndefined();
  });

  test("returns undefined for raw (non-JSON) text outputs so plain-text materia are not duplicated", () => {
    expect(extractMateriaTextOutput("just some prose")).toBeUndefined();
    expect(extractMateriaTextOutput(undefined)).toBeUndefined();
    expect(extractMateriaTextOutput([[HANDOFF_TEXT_FIELD, "x"]])).toBeUndefined();
  });
});

describe("materia text output content formatting", () => {
  test("trims block edges and trailing whitespace while preserving paragraph breaks", () => {
    const formatted = formatMateriaTextOutputContent("  First paragraph.   \n\n  Second paragraph.  \n");
    expect(formatted).toBe("First paragraph.\n\n  Second paragraph.");
  });

  test("is a one-way transform that does not collapse internal indentation", () => {
    expect(formatMateriaTextOutputContent("\n- bullet one\n- bullet two\n")).toBe("- bullet one\n- bullet two");
  });
});

describe("materia text output message builder", () => {
  test("builds a clean pi-materia display message hiding transport metadata", () => {
    const message = buildMateriaTextOutputMessage({
      parsed: { workItems: [{ title: "t", context: "c" }], satisfied: true, [HANDOFF_TEXT_FIELD]: "  Narration.  " },
      materiaName: "Narrate",
      socketId: "Socket-3",
      socketOrdinal: 3,
      itemKey: "WI-1",
      itemLabel: "narration item",
    });
    expect(message).toEqual({
      customType: "pi-materia",
      content: "Narration.",
      display: true,
      details: {
        prefix: "materia",
        eventType: MATERIA_TEXT_OUTPUT_EVENT_TYPE,
        socketId: "Socket-3",
        materiaName: "Narrate",
        socketOrdinal: 3,
        itemKey: "WI-1",
        itemLabel: "narration item",
      },
    });
  });

  test("omits undefined optional detail fields", () => {
    const message = buildMateriaTextOutputMessage({
      parsed: { [HANDOFF_TEXT_FIELD]: "prose" },
      materiaName: "Narrate",
      socketId: "Socket-1",
    });
    expect(message?.details).toEqual({
      prefix: "materia",
      eventType: MATERIA_TEXT_OUTPUT_EVENT_TYPE,
      socketId: "Socket-1",
      materiaName: "Narrate",
    });
    expect(message?.details).not.toHaveProperty("socketOrdinal");
    expect(message?.details).not.toHaveProperty("itemKey");
  });

  test("returns undefined when there is no renderable text payload", () => {
    expect(buildMateriaTextOutputMessage({ parsed: { satisfied: true }, materiaName: "Narrate", socketId: "Socket-1" })).toBeUndefined();
    expect(buildMateriaTextOutputMessage({ parsed: "raw text", materiaName: "Narrate", socketId: "Socket-1" })).toBeUndefined();
  });
});
