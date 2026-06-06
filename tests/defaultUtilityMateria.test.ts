import { describe, expect, test } from "bun:test";
import { access, readFile, readdir, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PiMateriaConfig } from "../src/types.js";
import { paletteColors } from "../src/webui/client/src/loadoutModel.js";

const executableSocketFields = ["utility", "command", "params", "timeoutMs", "parse", "assign"] as const;

async function loadDefaultConfig(): Promise<PiMateriaConfig> {
  return JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
}

describe("bundled utility materia defaults", () => {
  test("default software loadouts start with canonical utility materia references", async () => {
    const config = await loadDefaultConfig();

    for (const loadoutName of ["Full-Auto", "Planning-Consult", "Hojo-Consult"] as const) {
      const loadout = config.loadouts?.[loadoutName];
      expect(loadout, loadoutName).toBeTruthy();
      expect(loadout?.entry).toBe("Socket-1");
      expect(loadout?.sockets?.["Socket-1"]).toMatchObject({
        socketKind: "entry",
        materia: "Ignore-Artifacts",
        edges: [{ when: "always", to: "Socket-2" }],
      });
      expect(loadout?.sockets?.["Socket-2"]).toMatchObject({
        socketKind: "normal",
        materia: "Detect-VCS",
        edges: [{ when: "always", to: "Socket-3" }],
      });

      for (const socketId of ["Socket-1", "Socket-2"] as const) {
        const socket = loadout?.sockets?.[socketId] as Record<string, unknown> | undefined;
        expect(socket, `${loadoutName}.${socketId}`).toBeTruthy();
        for (const field of executableSocketFields) {
          expect(socket?.[field], `${loadoutName}.${socketId}.${field}`).toBeUndefined();
        }
      }
    }
  });

  test("default utility materia are shipped-script backed and package-listed", async () => {
    const [config, packageJson] = await Promise.all([
      loadDefaultConfig(),
      readFile(path.resolve("package.json"), "utf8").then((text) => JSON.parse(text) as { files?: string[] }),
    ]);

    expect(config.materia?.["Ignore-Artifacts"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "ensure-ignored.mjs", runtime: "node" },
      parse: "json",
    });
    expect(config.materia?.["Detect-VCS"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "detect-vcs.mjs", runtime: "node" },
      parse: "json",
    });
    expect(config.materia?.["Blackbelt-Bootstrap"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "blackbelt-bootstrap.mjs", runtime: "node" },
      parse: "json",
    });
    expect(config.materia?.["Blackbelt-Maintain"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "blackbelt-maintain.mjs", runtime: "node" },
      parse: "json",
    });
    expect((config.materia?.["Ignore-Artifacts"] as { assign?: unknown }).assign).toBeUndefined();
    expect((config.materia?.["Detect-VCS"] as { assign?: unknown }).assign).toBeUndefined();
    expect((config.materia?.["Blackbelt-Bootstrap"] as { assign?: unknown }).assign).toBeUndefined();
    expect((config.materia?.["Blackbelt-Maintain"] as { assign?: unknown }).assign).toBeUndefined();
    expect((config.materia?.["Ignore-Artifacts"] as { command?: unknown }).command).toBeUndefined();
    expect((config.materia?.["Detect-VCS"] as { command?: unknown }).command).toBeUndefined();
    expect((config.materia?.["Blackbelt-Bootstrap"] as { command?: unknown }).command).toBeUndefined();
    expect((config.materia?.["Blackbelt-Maintain"] as { command?: unknown }).command).toBeUndefined();
    expect(packageJson.files).toContain("config/default.json");
    expect(config.materia?.ensureArtifactsIgnored).toBeUndefined();
    expect(config.materia?.detectVcs).toBeUndefined();
    expect(packageJson.files).toContain("config/utilities/*.mjs");
    expect(packageJson.files).not.toContain(".pi/pi-materia");
    expect(packageJson.files).not.toContain(".pi/pi-materia/**");
  });

  test("package manifest and shipped utility sources support dry-run packaging checks", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { files?: string[]; scripts?: Record<string, string> };

    expect(packageJson.files).toEqual(expect.arrayContaining(["config/default.json", "config/utilities/*.mjs", "docs/*.md"]));
    expect(packageJson.scripts?.["pack:dry-run"]).toBe("npm pack --dry-run");
    await expect(access(path.resolve("config", "utilities", "detect-vcs.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "ensure-ignored.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "blackbelt-bootstrap.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "blackbelt-maintain.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "commit-sigil.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "blackbelt-pr.mjs"))).resolves.toBeNull();
  });

  test("Blackbelt-Bootstrap has correct shipped-utility config shape, parse, color, and metadata", async () => {
    const config = await loadDefaultConfig();
    const materia = config.materia?.["Blackbelt-Bootstrap"];

    expect(materia).toBeDefined();
    expect(materia?.type).toBe("utility");
    expect(materia?.label).toBe("Blackbelt-Bootstrap");
    expect(materia?.group).toBe("Utility");
    expect(materia?.parse).toBe("json");
    expect(materia?.script).toEqual({ kind: "shippedUtility", name: "blackbelt-bootstrap.mjs", runtime: "node" });
    expect(typeof materia?.description).toBe("string");
    expect((materia?.description as string).includes("bookmark")).toBe(true);
    expect((materia?.description as string).includes("jj")).toBe(true);
    expect(typeof materia?.color).toBe("string");
    const allowedColors = new Set(paletteColors);
    expect(allowedColors.has(materia?.color as string)).toBe(true);
    expect((materia as { assign?: unknown }).assign).toBeUndefined();
    expect((materia as { command?: unknown }).command).toBeUndefined();
  });

  test("Blackbelt-Maintain has correct shipped-utility config shape, parse, color, and metadata", async () => {
    const config = await loadDefaultConfig();
    const materia = config.materia?.["Blackbelt-Maintain"];

    expect(materia).toBeDefined();
    expect(materia?.type).toBe("utility");
    expect(materia?.label).toBe("Blackbelt-Maintain");
    expect(materia?.group).toBe("Utility");
    expect(materia?.parse).toBe("json");
    expect(materia?.script).toEqual({ kind: "shippedUtility", name: "blackbelt-maintain.mjs", runtime: "node" });
    expect(typeof materia?.description).toBe("string");
    expect((materia?.description as string).includes("checkpoint")).toBe(true);
    expect((materia?.description as string).includes("jj")).toBe(true);
    expect(typeof materia?.color).toBe("string");
    const allowedColors = new Set(paletteColors);
    expect(allowedColors.has(materia?.color as string)).toBe(true);
    expect((materia as { assign?: unknown }).assign).toBeUndefined();
    expect((materia as { command?: unknown }).command).toBeUndefined();
  });

  test("no bundled loadout socket references Blackbelt utilities", async () => {
    const config = await loadDefaultConfig();

    for (const [loadoutName, loadout] of Object.entries(config.loadouts ?? {})) {
      for (const [socketId, socket] of Object.entries((loadout as { sockets?: Record<string, { materia?: string }> }).sockets ?? {})) {
        expect(socket.materia, `${loadoutName}.${socketId} should not reference Blackbelt-Bootstrap`).not.toBe("Blackbelt-Bootstrap");
        expect(socket.materia, `${loadoutName}.${socketId} should not reference Blackbelt-Maintain`).not.toBe("Blackbelt-Maintain");
      }
    }

    // Ensure Maintain and GitMaintain entries still exist in config
    expect(config.materia?.Maintain).toBeDefined();
    expect(config.materia?.GitMaintain).toBeDefined();
  });

  test("profile sync copies and resolves Blackbelt utility scripts through shipped utility resolution", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-shipped-"));
    const profileDir = path.join(temp, "profile");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      // Dynamically import loadConfig to trigger profile sync
      const { loadConfig } = await import("../src/config/config.js");
      await loadConfig(temp);

      const utilitiesDir = path.join(profileDir, "utilities");
      const entries = await readdir(utilitiesDir);
      expect(entries).toContain("blackbelt-bootstrap.mjs");
      expect(entries).toContain("blackbelt-maintain.mjs");
      expect(entries).toContain("blackbelt-pr.mjs");

      // Verify each script is copied with content
      for (const name of ["blackbelt-bootstrap.mjs", "blackbelt-maintain.mjs", "blackbelt-pr.mjs"]) {
        const scriptContent = await readFile(path.join(utilitiesDir, name), "utf8");
        expect(scriptContent).toBeTruthy();
      }

      const manifest = JSON.parse(await readFile(path.join(utilitiesDir, ".pi-materia-shipped-utilities.json"), "utf8"));
      expect(manifest.utilities["blackbelt-bootstrap.mjs"]).toBeDefined();
      expect(manifest.utilities["blackbelt-bootstrap.mjs"].profileFile).toBe("blackbelt-bootstrap.mjs");
      expect(manifest.utilities["blackbelt-maintain.mjs"]).toBeDefined();
      expect(manifest.utilities["blackbelt-maintain.mjs"].profileFile).toBe("blackbelt-maintain.mjs");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });
});

describe("Commit-Sigil generator utility", () => {
  test("default config marks Commit-Sigil as generator:true utility materia", async () => {
    const config = await loadDefaultConfig();
    const materia = config.materia?.["Commit-Sigil"];
    expect(materia).toBeDefined();
    expect(materia?.type).toBe("utility");
    expect(materia?.generator).toBe(true);
    expect(materia?.parse).toBe("json");
    expect(materia?.script).toEqual({ kind: "shippedUtility", name: "commit-sigil.mjs", runtime: "node" });
    // Generator utility materia must keep executable behavior on the materia, not on socket
    expect((materia as Record<string, unknown>).command).toBeUndefined();
  });

  test("resolving Release loadout materializes Socket-9 Commit-Sigil with workItems assignment", async () => {
    const config = await loadDefaultConfig();
    config.activeLoadout = "Release";
    const { resolvePipeline } = await import("../src/runtime/pipeline.js");
    const { effectiveResolvedSocketConfig } = await import("../src/runtime/resolvedMateria.js");
    const pipeline = resolvePipeline(config);

    const s9 = pipeline.sockets["Socket-9"];
    expect(s9).toBeDefined();
    expect(s9.materiaId).toBe("Commit-Sigil");
    expect(s9.materia.type).toBe("utility");
    expect(s9.materia.generator).toBe(true);
    // parse:json and assign:workItems are derived at runtime by effectiveResolvedSocketConfig
    const effective = effectiveResolvedSocketConfig(s9);
    expect(effective.parse).toBe("json");
    expect(effective.assign).toEqual({ lastFeedback: "$.context", workItems: "$.workItems" });
    // Satisfied/not_satisfied routing edges are preserved
    expect(s9.socket.edges).toEqual([
      { when: "satisfied", to: "Socket-8" },
      { when: "not_satisfied", to: "Socket-3", maxTraversals: 3 },
    ]);
  });

  test("Release loop still consumes from Socket-8 Auto-Architect, not Socket-9 Commit-Sigil", async () => {
    const config = await loadDefaultConfig();
    config.activeLoadout = "Release";
    const { resolvePipeline } = await import("../src/runtime/pipeline.js");
    const pipeline = resolvePipeline(config);

    // LoopSelection consumes workItems from Auto-Architect (Socket-8), not Commit-Sigil
    const loop = pipeline.loops?.loopSelection;
    expect(loop).toBeDefined();
    expect(loop?.consumes?.from).toBe("Socket-8");
    expect(loop?.consumes?.output).toBe("workItems");
    expect(loop?.exit).toEqual({ from: "Socket-6", when: "satisfied", to: "end" });
    // Loop sockets are Build/Eval/Maintain (Socket-4/5/6)
    expect(loop?.sockets).toEqual(["Socket-4", "Socket-5", "Socket-6"]);
    // Commit-Sigil (Socket-9) is NOT in the loop
    expect(loop?.sockets).not.toContain("Socket-9");
  });

  test("Socket-5 Auto-Eval lastFeedback/context assignment is preserved in Release", async () => {
    const config = await loadDefaultConfig();
    config.activeLoadout = "Release";
    const { resolvePipeline } = await import("../src/runtime/pipeline.js");
    const pipeline = resolvePipeline(config);

    const s5 = pipeline.sockets["Socket-5"];
    expect(s5).toBeDefined();
    expect(s5.socket.materia).toBe("Auto-Eval");
    expect(s5.socket.assign).toMatchObject({ lastFeedback: "$.context" });
  });

  test("commit-sigil.mjs echoes workItems unmodified for valid Conventional Commit titles", async () => {
    const scriptPath = path.resolve("config", "utilities", "commit-sigil.mjs");
    const { stdout } = await runScriptWithInput(scriptPath, {
      workItems: [
        { title: "feat: add login", context: "Implement login flow" },
        { title: "fix(auth): handle timeout", context: "Fix auth timeout" },
      ],
    });
    const output = JSON.parse(stdout);
    expect(output.workItems).toEqual([
      { title: "feat: add login", context: "Implement login flow" },
      { title: "fix(auth): handle timeout", context: "Fix auth timeout" },
    ]);
    expect(output.satisfied).toBe(true);
    expect(typeof output.context).toBe("string");
    expect(output.context).toContain("conform to Conventional Commit format");
    // No extraneous envelope fields
    expect(output.tasks).toBeUndefined();
    expect(output.envelope).toBeUndefined();
    expect(output.state).toBeUndefined();
  });

  test("commit-sigil.mjs rejects invalid titles with satisfied:false and actionable context", async () => {
    const scriptPath = path.resolve("config", "utilities", "commit-sigil.mjs");
    const { stdout } = await runScriptWithInput(scriptPath, {
      workItems: [
        { title: "not a conventional commit", context: "Missing colon" },
      ],
    });
    const output = JSON.parse(stdout);
    // Work items echoed unchanged
    expect(output.workItems).toEqual([
      { title: "not a conventional commit", context: "Missing colon" },
    ]);
    expect(output.satisfied).toBe(false);
    expect(typeof output.context).toBe("string");
    expect(output.context).toContain("validation failed");
    expect(output.context).toContain("Conventional Commit format");
    // No extraneous envelope fields
    expect(output.tasks).toBeUndefined();
    expect(output.envelope).toBeUndefined();
  });

  test("commit-sigil.mjs handles empty input with satisfied:true", async () => {
    const scriptPath = path.resolve("config", "utilities", "commit-sigil.mjs");
    const { stdout } = await runScriptWithInput(scriptPath, {});
    const output = JSON.parse(stdout);
    expect(output.workItems).toEqual([]);
    expect(output.satisfied).toBe(true);
    expect(output.context).toContain("no work items to validate");
  });

  test("commit-sigil.mjs reads state.workItems when top-level workItems is absent", async () => {
    const scriptPath = path.resolve("config", "utilities", "commit-sigil.mjs");
    const { stdout } = await runScriptWithInput(scriptPath, {
      state: {
        workItems: [
          { title: "docs: update readme", context: "Update docs" },
        ],
      },
    });
    const output = JSON.parse(stdout);
    expect(output.workItems).toEqual([
      { title: "docs: update readme", context: "Update docs" },
    ]);
    expect(output.satisfied).toBe(true);
  });

  test("commit-sigil.mjs ignores tasks/work aliases and never emits them", async () => {
    const scriptPath = path.resolve("config", "utilities", "commit-sigil.mjs");
    const { stdout } = await runScriptWithInput(scriptPath, {
      tasks: [{ title: "feat: ignored" }],
      work: [{ title: "fix: also ignored" }],
    });
    const output = JSON.parse(stdout);
    expect(output.workItems).toEqual([]);
    expect(output.satisfied).toBe(true);
    expect(output.tasks).toBeUndefined();
    expect(output.work).toBeUndefined();
  });

  test("commit-sigil.mjs does not rewrite titles or add fields to work items", async () => {
    const scriptPath = path.resolve("config", "utilities", "commit-sigil.mjs");
    const original = { title: "chore: update deps", context: "Routine" };
    const { stdout } = await runScriptWithInput(scriptPath, {
      workItems: [original],
    });
    const output = JSON.parse(stdout);
    expect(output.workItems).toEqual([original]);
    // No extra fields added
    const keys = Object.keys(output.workItems[0]).sort();
    expect(keys).toEqual(["context", "title"]);
  });

  test("commit-sigil.mjs flag non-standard types as advisory while keeping satisfied:true", async () => {
    const scriptPath = path.resolve("config", "utilities", "commit-sigil.mjs");
    const { stdout } = await runScriptWithInput(scriptPath, {
      workItems: [
        { title: "customtype: do something", context: "Non-standard type" },
      ],
    });
    const output = JSON.parse(stdout);
    expect(output.satisfied).toBe(true);
    expect(output.context).toContain("non-standard type");
  });
});

async function runScriptWithInput(scriptPath: string, input: unknown): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", scriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
