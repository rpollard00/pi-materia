import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { publishActiveLoadoutChange } from "../src/presentation/activeLoadoutEvents.js";
import { createMateriaSemanticTheme } from "../src/presentation/theme.js";
import { renderLoadoutListThemed, updateMateriaLoadoutWidget } from "../src/presentation/loadoutWidget.js";
import { FakePiHarness } from "./fakePi.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
}

describe("Materia loadout widget", () => {
  test("themes the persistent loadout widget while preserving its plain list", () => {
    const calls: Array<[string, string]> = [];
    const harness = new FakePiHarness(process.cwd(), {
      theme: {
        fg: (token, text) => {
          calls.push([token, text]);
          return `\u001b[35m${text}\u001b[0m`;
        },
      },
    });
    const config = {
      activeLoadout: "Build",
      materia: {},
      loadouts: {
        Build: {} as never,
        Review: {} as never,
        Maintain: {} as never,
      },
    };
    const plain = ["⌘ Build (Build*, Review, Maintain)"];

    updateMateriaLoadoutWidget(harness.ctx, config, "test");
    const themed = harness.renderWidget("materia-loadouts", 200) ?? [];

    expect(themed.map(stripAnsi)).toEqual(plain);
    expect(renderLoadoutListThemed(config, createMateriaSemanticTheme(undefined))).toEqual(plain);
    expect(themed.every((line) => visibleWidth(line) <= 200)).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      ["accent", "⌘"],
      ["accent", "Build"],
      ["success", "Build"],
      ["success", "*"],
      ["muted", "Review"],
    ]));
  });

  test("themes command and WebUI loadout changes without changing event payloads", () => {
    for (const source of ["command", "webui"] as const) {
      const calls: string[] = [];
      const harness = new FakePiHarness(process.cwd(), {
        theme: {
          fg: (token, text) => {
            calls.push(token);
            return `\u001b[35m${text}\u001b[0m`;
          },
        },
      });
      const config = {
        activeLoadout: "Build",
        materia: {},
        loadouts: {
          Build: {} as never,
          Review: {} as never,
        },
      };
      const result = publishActiveLoadoutChange(harness.pi, harness.ctx, {
        source,
        loaded: { config, source: "test-config" },
      });

      expect(result.event).toMatchObject({ source, activeLoadout: "Build", loadouts: ["Build", "Review"] });
      expect(harness.renderWidget("materia-loadouts", 200)?.map(stripAnsi)).toEqual(result.lines);
      expect(harness.appendedEntries.at(-1)).toMatchObject({
        customType: "pi-materia-active-loadout-changed",
        data: { source, activeLoadout: "Build" },
      });
      expect(calls).toEqual(expect.arrayContaining(["accent", "success", "muted"]));
    }
  });
});
