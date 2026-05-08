import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import piMateria from "../src/index.js";
import { formatMateriaCastContent, formatMateriaNotificationDisplay } from "../src/notificationFormatting.js";
import { FakePiHarness } from "./fakePi.js";

describe("materia cast notification formatting", () => {
  test("formats materia first with compact socket ordinal", () => {
    expect(formatMateriaNotificationDisplay("interactivePlan", "Socket-3")).toEqual({
      materiaName: "interactivePlan",
      socketOrdinal: 3,
      label: "interactivePlan (3)",
    });
    expect(formatMateriaCastContent("interactivePlan", "Socket-3")).toBe("Casting **interactivePlan (3)**");
  });

  test("demotes a legacy Socket-N suffix from the displayed materia name", () => {
    expect(formatMateriaNotificationDisplay("interactivePlan Socket-3", "Socket-3").label).toBe("interactivePlan (3)");
    expect(formatMateriaCastContent("interactivePlan Socket-3", "Socket-3", "Reduce socket prominence")).toBe("Casting **interactivePlan (3)**\n\nReduce socket prominence");
  });

  test("keeps full Socket-N in metadata while visible cast text uses compact ordinal", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-notification-"));
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: { Test: { entry: "Socket-3", nodes: { "Socket-3": { type: "agent", materia: "interactivePlan", next: "end" } } } },
      materia: { interactivePlan: { tools: "none", prompt: "Plan {{request}}" } },
    }, null, 2));
    const harness = new FakePiHarness(cwd);
    piMateria(harness.pi);

    await harness.runCommand("materia", "cast reduce socket prominence");

    const message = harness.sentMessages.map(({ message }) => message as { customType?: string; content?: string; details?: Record<string, unknown> }).find((candidate) => candidate.customType === "pi-materia");
    expect(message?.content).toBe("Casting **interactivePlan (3)**");
    expect(message?.content).not.toContain("Socket-3");
    expect(message?.details).toMatchObject({ nodeId: "Socket-3", materiaName: "interactivePlan", socketOrdinal: 3, eventType: "materia_prompt" });
  });
});
