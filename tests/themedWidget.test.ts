import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createMateriaSemanticTheme,
  MATERIA_THEME_TOKENS,
} from "../src/presentation/theme.js";
import {
  createMateriaThemedWidgetFactory,
  renderMateriaWidgetPlain,
} from "../src/presentation/themedWidget.js";
import { FakePiHarness } from "./fakePi.js";

describe("Materia semantic widget theming", () => {
  test("maps semantic roles to active Pi tokens without hardcoded colors", () => {
    const calls: Array<[string, string]> = [];
    const semantic = createMateriaSemanticTheme({
      fg: (token, text) => {
        calls.push([token, text]);
        return `<${token}>${text}`;
      },
    });

    expect(semantic.fg("accent", "active")).toBe("<accent>active");
    expect(semantic.style("success")("ready")).toBe("<success>ready");
    expect(semantic.blink("warning", "busy")).toBe("<warning>\u001b[5mbusy\u001b[25m");
    expect(semantic.token("warning")).toBe(MATERIA_THEME_TOKENS.warning);
    expect(calls).toEqual([
      ["accent", "active"],
      ["success", "ready"],
      ["warning", "\u001b[5mbusy\u001b[25m"],
    ]);
  });

  test("scopes blink reset after the target glyph while retaining ANSI foreground styling", () => {
    const semantic = createMateriaSemanticTheme({
      fg: (token, text) => `\u001b[38;5;${token === "warning" ? "214" : "39"}m${text}\u001b[39m`,
    });

    const rendered = semantic.blink("warning", "|");
    expect(rendered).toBe("\u001b[38;5;214m\u001b[5m|\u001b[25m\u001b[39m");
    expect(rendered).not.toContain("|\u001b[0m");
    expect(semantic.fg("text", "next")).toBe("\u001b[38;5;39mnext\u001b[39m");
  });

  test("keeps blink ANSI-free when no live Pi theme is available", () => {
    const semantic = createMateriaSemanticTheme(undefined);

    expect(semantic.blink("warning", "|")).toBe("|");
    expect(semantic.fg("warning", "next")).toBe("next");
  });

  test("uses a late-bound factory, invalidates without cached ANSI, and bounds visible width", () => {
    const calls: string[] = [];
    const harness = new FakePiHarness(process.cwd(), {
      theme: {
        fg: (token, text) => {
          calls.push(token);
          return `\u001b[35m${text}\u001b[0m`;
        },
      },
    });
    let value = "first value";
    const factory = createMateriaThemedWidgetFactory((theme) => [
      theme.fg("accent", value),
    ]);
    harness.ctx.ui.setWidget("themed", factory, { placement: "belowEditor" });

    const first = harness.renderWidget("themed", 5);
    expect(visibleWidth(first?.[0] ?? "")).toBeLessThanOrEqual(5);
    expect(first?.[0]).not.toContain("first value");

    value = "second";
    harness.invalidateWidget("themed");
    const second = harness.renderWidget("themed", 5);
    expect(second?.[0]).toContain("seco");
    expect(second?.[0]).not.toContain("first");
    expect(calls).toEqual(["accent", "accent"]);
  });

  test("keeps plain rendering separate from the themed TUI path", () => {
    const plain = renderMateriaWidgetPlain(() => ["Usage total 1k tokens"]);
    expect(plain).toEqual(["Usage total 1k tokens"]);
  });
});
