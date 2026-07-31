import { describe, expect, test } from "bun:test";
import { appendMateriaPresentation, MATERIA_PRESENTATION_ENTRY_TYPE } from "../src/presentation/materiaPresentation.js";
import { registerMateriaRenderer } from "../src/presentation/renderer.js";
import { FakePiHarness } from "./fakePi.js";

describe("Materia presentation entries", () => {
  test("persist a visible card without creating a context-bearing message", () => {
    const harness = new FakePiHarness();
    registerMateriaRenderer(harness.pi);

    appendMateriaPresentation(harness.pi, {
      content: "Current token limit: 100",
      details: { prefix: "budget", materiaName: "orchestrator", eventType: "budget" },
    });

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.appendedEntries).toEqual([{
      customType: MATERIA_PRESENTATION_ENTRY_TYPE,
      data: {
        content: "Current token limit: 100",
        details: { prefix: "budget", materiaName: "orchestrator", eventType: "budget" },
      },
    }]);
    expect(harness.sessionManager.getEntries().map((entry) => entry.type)).toEqual(["custom"]);
  });

  test("registers and renders presentation entries through the shared card renderer", () => {
    const harness = new FakePiHarness();
    registerMateriaRenderer(harness.pi);
    const renderer = harness.registeredEntryRenderers.get(MATERIA_PRESENTATION_ENTRY_TYPE) as ((
      entry: unknown,
      options: { expanded: boolean },
      theme: { fg(color: string, text: string): string; bg(color: string, text: string): string },
    ) => unknown) | undefined;
    expect(renderer).toBeDefined();

    appendMateriaPresentation(harness.pi, {
      content: "Narration prose",
      details: { prefix: "materia", materiaName: "Narrate", eventType: "materia_text" },
    });
    const entry = harness.sessionManager.getEntries().at(-1);
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    };

    expect(renderer?.(entry, { expanded: false }, theme)).toBeDefined();
    expect(renderer?.(entry, { expanded: true }, theme)).toBeDefined();
    expect(harness.sentMessages).toHaveLength(0);
  });
});
