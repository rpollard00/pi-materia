import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

function socket(materia = "Done"): { materia: string } {
  return { materia };
}

async function makeHarness(loadouts: Record<string, unknown> = {}, activeLoadout?: string): Promise<FakePiHarness> {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "pi-materia-loadout-autocomplete-profile-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-loadout-autocomplete-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  const config = {
    artifactDir: ".pi/pi-materia",
    activeLoadout: activeLoadout ?? Object.keys(loadouts)[0],
    loadouts,
    materia: {
      Done: { type: "utility", utility: "echo", params: { text: "done" } },
    },
  };
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  // Set activeContext by emitting session_start (mirrors real pi startup)
  await harness.emit("session_start", {});
  return harness;
}

/** Default loadouts from config/default.json always merge in. */
const defaultLoadoutNames = ["Full-Auto", "Planning-Consult", "Hojo-Consult"];

describe("/materia loadout autocomplete", () => {
  test("empty query returns all loadouts for arrow navigation", async () => {
    const harness = await makeHarness({
      Alpha: { id: "default:alpha", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      Beta: { id: "user:beta", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      Gamma: { id: "project:gamma", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Gamma");

    // /materia loadout<space> — returns all loadouts (defaults + custom)
    const all = await harness.getCommandCompletions("materia", "loadout ");
    expect(all).not.toBeNull();
    const values = all!.map((c) => c.value);
    // Custom loadouts are present
    expect(values).toContain("loadout Alpha");
    expect(values).toContain("loadout Beta");
    expect(values).toContain("loadout Gamma");
    // Default loadouts are also present
    for (const name of defaultLoadoutNames) {
      expect(values).toContain(`loadout ${name}`);
    }
    // Total count = defaults + custom
    expect(all!.length).toBe(defaultLoadoutNames.length + 3);
  });

  test("no trailing space also returns all loadouts", async () => {
    const harness = await makeHarness({
      Alpha: { id: "default:alpha", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      Beta: { id: "user:beta", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Alpha");

    // /materia loadout (no trailing space) — shows loadout candidates
    const completions = await harness.getCommandCompletions("materia", "loadout");
    expect(completions).not.toBeNull();
    const values = completions!.map((c) => c.value);
    expect(values).toContain("loadout Alpha");
    expect(values).toContain("loadout Beta");
    expect(completions!.length).toBeGreaterThanOrEqual(2);
  });

  test("narrowing works while typing — exact name prefix", async () => {
    const harness = await makeHarness({
      "Special-One": { id: "user:special-one", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      "Special-Two": { id: "user:special-two", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      "Other": { id: "user:other", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Special-One");

    // Typing "loadout Speci" — narrows to "Special-*" (does not fuzzy-match "Other")
    const bySpeci = await harness.getCommandCompletions("materia", "loadout Speci");
    expect(bySpeci).not.toBeNull();
    const speciValues = bySpeci!.map((c) => c.value);
    expect(speciValues).toContain("loadout Special-One");
    expect(speciValues).toContain("loadout Special-Two");
    expect(speciValues).not.toContain("loadout Other");

    // Typing "loadout Special-One" — exact match
    const byExact = await harness.getCommandCompletions("materia", "loadout Special-One");
    expect(byExact).not.toBeNull();
    expect(byExact!.map((c) => c.value)).toContain("loadout Special-One");

    // Typing "loadout zzz" — no match
    const noMatch = await harness.getCommandCompletions("materia", "loadout zzz");
    expect(noMatch).toBeNull();
  });

  test("fuzzy narrowing matches across name and id", async () => {
    const harness = await makeHarness({
      NameA: { id: "user:special-id", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      NameB: { id: "user:other", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "NameA");

    // Query by id fragment
    const byId = await harness.getCommandCompletions("materia", "loadout special");
    expect(byId).not.toBeNull();
    const idValues = byId!.map((c) => c.value);
    expect(idValues).toContain("loadout NameA");
    expect(idValues).not.toContain("loadout NameB");
  });

  test("active loadout is marked in label", async () => {
    const harness = await makeHarness({
      Active: { id: "user:active", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      Inactive: { id: "user:inactive", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Active");

    const completions = await harness.getCommandCompletions("materia", "loadout ");
    expect(completions).not.toBeNull();

    const active = completions!.find((c) => c.value === "loadout Active")!;
    const inactive = completions!.find((c) => c.value === "loadout Inactive")!;

    expect(active).toBeDefined();
    expect(active.label).toContain("*");
    expect(inactive.label).not.toContain("*");
  });

  test("description includes id metadata", async () => {
    const harness = await makeHarness({
      Hojo: { id: "user:hojo", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Hojo");

    const completions = await harness.getCommandCompletions("materia", "loadout ");
    expect(completions).not.toBeNull();

    const hojo = completions!.find((c) => c.value === "loadout Hojo")!;
    expect(hojo).toBeDefined();
    expect(hojo.description).toContain("id:user:hojo");
  });

  test("selecting a completion switches the active loadout", async () => {
    const harness = await makeHarness({
      Alpha: { id: "default:alpha", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      Beta: { id: "user:beta", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Alpha");

    // Simulate selecting the "loadout Beta" completion
    await harness.runCommand("materia", "loadout Beta");

    // Verify the switch happened — look for the notification about active loadout change
    const switchNotifications = harness.notifications.filter(
      (n) => n.message.includes("active loadout set to")
    );
    expect(switchNotifications.length).toBeGreaterThanOrEqual(1);
    expect(switchNotifications.some((n) => n.message.includes("Beta"))).toBe(true);
  });

  test("completions do not trigger turns or active-cast side effects", async () => {
    const harness = await makeHarness({
      Alpha: { id: "default:alpha", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      Beta: { id: "user:beta", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Alpha");

    const sentBefore = harness.sentMessages.length;
    const userMessagesBefore = harness.userMessages.length;
    const operationsBefore = harness.operationLog.length;

    // Request completions — should not trigger any turns or sends
    await harness.getCommandCompletions("materia", "loadout ");
    await harness.getCommandCompletions("materia", "loadout Beta");

    // No new messages should have been sent
    expect(harness.sentMessages.length).toBe(sentBefore);
    expect(harness.userMessages.length).toBe(userMessagesBefore);
    // No triggerTurn operations
    const newOps = harness.operationLog.slice(operationsBefore);
    expect(newOps.filter((op) => op === "triggerTurn" || op === "suppressedTriggerTurnDuringAgentEnd").length).toBe(0);
  });

  test("completions do not set status or affect session state", async () => {
    const harness = await makeHarness({
      Alpha: { id: "default:alpha", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Alpha");

    const statusBefore = harness.statuses.get("materia");

    await harness.getCommandCompletions("materia", "loadout ");

    // Status should not change
    expect(harness.statuses.get("materia")).toBe(statusBefore);
    // No idle wait should be triggered
    expect(harness.waitForIdleCalls).toBe(0);
  });

  test("loadout subcommand still appears in unfiltered subcommand completions", async () => {
    const harness = await makeHarness({
      Alpha: { id: "default:alpha", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "Alpha");

    // Typing partial "loa" should show "loadout" as a subcommand option (existing behavior)
    const completions = harness.getCommandCompletions("materia", "loa");
    expect(completions).not.toBeNull();
    const values = completions!.map((c) => c.value);
    expect(values).toContain("loadout");
  });

  test("multi-word loadout names with spaces are queryable", async () => {
    const harness = await makeHarness({
      "My Custom Loadout": { id: "user:my-custom", entry: "Socket-1", sockets: { "Socket-1": socket() } },
      "Another One": { id: "user:another-one", entry: "Socket-1", sockets: { "Socket-1": socket() } },
    }, "My Custom Loadout");

    // Query with partial multi-word name
    const completions = await harness.getCommandCompletions("materia", "loadout My Custom");
    expect(completions).not.toBeNull();
    const values = completions!.map((c) => c.value);
    expect(values).toContain("loadout My Custom Loadout");
    // "Another One" should not match "My Custom"
    expect(values).not.toContain("loadout Another One");
  });

  test("no loadouts configured returns loadouts from default config", async () => {
    // Even with no custom loadouts in the project config, the four default
    // loadouts are merged in.
    const harness = await makeHarness({}, "");
    const completions = await harness.getCommandCompletions("materia", "loadout ");
    expect(completions).not.toBeNull();
    const values = completions!.map((c) => c.value);
    for (const name of defaultLoadoutNames) {
      expect(values).toContain(`loadout ${name}`);
    }
  });
});
