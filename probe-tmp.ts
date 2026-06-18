import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "./src/index.js";
import { FakePiHarness } from "./tests/fakePi.js";

async function main() {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "probe-"));
  await writeFile(path.join(process.env.PI_MATERIA_PROFILE_DIR, "config.json"), JSON.stringify({ questDefaultLoadoutId: null }));
  const cwd = await mkdtemp(path.join(tmpdir(), "probe-cwd-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  const config = {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    questDefaultLoadoutId: null,
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
    materia: { Build: { type: "agent", tools: "none", prompt: "Build {{request}}" } },
  };
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  await harness.runCommand("materia", "quest add Build the thing");
  await harness.runCommand("materia", "quest run");
  console.log("=== sentMessages order ===");
  for (const { message, options } of harness.sentMessages) {
    const m = message as any;
    if (m.customType && String(m.customType).startsWith("pi-materia")) {
      console.log(JSON.stringify({ customType: m.customType, display: m.display, prefix: m.details?.prefix, orchestration: m.details?.orchestration, eventType: m.details?.eventType, triggerTurn: (options as any)?.triggerTurn, contentHead: String(m.content).slice(0, 50) }));
    }
  }
}
main();
