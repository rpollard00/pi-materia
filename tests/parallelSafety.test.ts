import { describe, expect, test } from "bun:test";
import { parallelSafetyIssuesForMateria, validateParallelSafeMateria } from "../src/domain/parallelSafety.js";
import { validatePipelineGraph } from "../src/graph/graphValidation.js";
import type { MateriaConfig, MateriaPipelineConfig } from "../src/types.js";

const parallelGraph = (): MateriaPipelineConfig => ({
  entry: "Socket-1",
  sockets: {
    "Socket-1": { materia: "Planner", edges: [{ when: "always", to: "Socket-2" }] },
    "Socket-2": { materia: "Setup", edges: [{ when: "always", to: "Socket-3" }] },
    "Socket-3": { materia: "Build", edges: [{ when: "always", to: "Socket-4" }] },
    "Socket-4": { materia: "Eval", edges: [{ when: "always", to: "Socket-3" }] },
    "Socket-5": { materia: "Join" },
  },
  loops: {
    work: {
      sockets: ["Socket-3", "Socket-4"],
      consumes: { from: "Socket-1", output: "workItems" },
      exit: { from: "Socket-4", when: "satisfied", to: "Socket-5" },
    },
  },
});

const agent = (parallelSafe?: boolean): MateriaConfig => ({ type: "agent", tools: "readOnly", prompt: "run", ...(parallelSafe === undefined ? {} : { parallelSafe }) });

const safeCatalog: Record<string, MateriaConfig> = {
  Planner: agent(true),
  Setup: { type: "utility", command: ["prepare"], parallelSafe: true },
  Build: agent(true),
  Eval: agent(true),
  Join: agent(true),
  Resolve: agent(true),
};

describe("parallel child materia safety", () => {
  test("requires explicit permission and warns that cwd isolation is not implied", () => {
    expect(validateParallelSafeMateria("Custom", agent()).ok).toBe(false);
    const issue = parallelSafetyIssuesForMateria("Custom", agent())[0];
    expect(issue?.path).toBe("materia.Custom.parallelSafe");
    expect(issue?.message).toContain("multiple scopes may share one cwd");
    expect(validateParallelSafeMateria("Custom", agent(true)).ok).toBe(true);
  });

  test("trusts opted-in utilities to enforce scope-specific safety", () => {
    expect(validateParallelSafeMateria("Publisher", { type: "utility", utility: "publish", parallelSafe: true }).ok).toBe(true);
    expect(validateParallelSafeMateria("Blackbelt-Maintain", { type: "utility", script: { name: "blackbelt-maintain.mjs" }, parallelSafe: true }).ok).toBe(true);
    expect(validateParallelSafeMateria("Publisher", { type: "utility", utility: "publish" }).ok).toBe(false);
  });

  test("continues to reject interactive and multi-turn child behavior", () => {
    expect(parallelSafetyIssuesForMateria("Planner", { ...agent(true), multiTurn: true })[0]?.message).toContain("multi-turn/user-interactive");
    expect(parallelSafetyIssuesForMateria("Prompt", { ...agent(true), requiresUserInput: true })[0]?.message).toContain("multi-turn/user-interactive");
  });

  test("reports exact prelude and loop sockets for intrinsic parallel regions", () => {
    const materia = { ...safeCatalog, Setup: { ...safeCatalog.Setup, parallelSafe: false }, Eval: agent(false) };
    const result = validatePipelineGraph(parallelGraph(), {
      materia,
      isParallelGeneratorSocket: (socketId) => socketId === "Socket-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      source: "parallelRegions.Socket-1.prelude[0].parallelSafe",
      from: "Socket-2",
    }));
    expect(result.errors).toContainEqual(expect.objectContaining({
      source: "loops.work.sockets[1].parallelSafe",
      from: "Socket-4",
    }));
    expect(result.errors.find((error) => error.from === "Socket-4")?.message).toContain("Eval");
  });
});
