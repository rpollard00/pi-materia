import { describe, expect, test } from "bun:test";
import { parallelSafetyIssuesForMateria, validateParallelSafeMateria } from "../src/domain/parallelSafety.js";
import { validatePipelineGraph } from "../src/graph/graphValidation.js";
import type { MateriaConfig, MateriaPipelineConfig } from "../src/types.js";

const parallelGraph = (): MateriaPipelineConfig => ({
  entry: "Socket-1",
  sockets: {
    "Socket-1": { materia: "Planner", edges: [{ when: "always", to: "Socket-2" }] },
    "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
    "Socket-3": { materia: "Eval", edges: [{ when: "always", to: "Socket-2" }] },
    "Socket-4": { materia: "Join" },
    "Socket-5": { materia: "Resolve" },
  },
  loops: {
    work: {
      sockets: ["Socket-2", "Socket-3"],
      consumes: { from: "Socket-1", output: "workItems" },
      exit: { from: "Socket-3", when: "satisfied", to: "end" },
      parallel: { planInput: "state.parallelPlan", maxConcurrency: 2, workspaceMode: "jj", failurePolicy: "all_terminal", fanIn: "ordered" },
      exits: [
        { id: "clean", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-4" },
        { id: "conflict", from: "Socket-3", condition: "not_satisfied", targetSocketId: "Socket-5" },
      ],
    },
  },
});

const agent = (parallelSafe?: boolean): MateriaConfig => ({ type: "agent", tools: "readOnly", prompt: "run", ...(parallelSafe === undefined ? {} : { parallelSafe }) });

const safeCatalog: Record<string, MateriaConfig> = {
  Planner: agent(true),
  Build: agent(true),
  Eval: agent(true),
  Join: agent(true),
  Resolve: agent(true),
};

describe("parallel child materia safety", () => {
  test("requires an explicit workspace-local opt-in for custom materia", () => {
    expect(validateParallelSafeMateria("Custom", agent()).ok).toBe(false);
    expect(parallelSafetyIssuesForMateria("Custom", agent())[0]?.path).toBe("materia.Custom.parallelSafe");
    expect(validateParallelSafeMateria("Custom", agent(true)).ok).toBe(true);
    expect(validateParallelSafeMateria("My-Publisher", { type: "utility", utility: "publish", parallelSafe: true }).ok).toBe(false);
    expect(validateParallelSafeMateria("Custom-Publisher", { type: "utility", command: ["publish"], parallelSafe: true }).ok).toBe(true);
  });

  test("rejects interactive and known parent-shared operations even when opted in", () => {
    expect(parallelSafetyIssuesForMateria("Planner", { ...agent(true), multiTurn: true })[0]?.message).toContain("multi-turn/user-interactive");
    expect(parallelSafetyIssuesForMateria("Blackbelt-Maintain", { type: "utility", script: { name: "blackbelt-maintain.mjs" }, parallelSafe: true })[0]?.message).toContain("parent-shared");
  });

  test("reports the exact offending loop socket through graph validation", () => {
    const materia = { ...safeCatalog, Eval: agent(false) };
    const result = validatePipelineGraph(parallelGraph(), {
      materia,
      isGeneratorSocket: (socketId) => socketId === "Socket-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      source: "loops.work.sockets[1].parallelSafe",
      from: "Socket-3",
    }));
    expect(result.errors.find((error) => error.from === "Socket-3")?.message).toContain("Eval");
  });
});
