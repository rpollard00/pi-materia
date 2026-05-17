import { canonicalGeneratorConfigFor } from "./generator.js";
import { TERMINAL_GRAPH_TARGET } from "./graphSemantics.js";
import { getLoadoutSocket } from "../loadout/loadoutAccessors.js";
import { reconcileLoadoutLoopConsumersFromGraphInPlace } from "./loadoutGraphAnalysis.js";
import type { MateriaAdvanceConfig, MateriaConfig, MateriaEdgeCondition, MateriaGeneratorConfig, MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineSocketConfig, PiMateriaConfig } from "../types.js";

const JSON_CONTROL_CONDITIONS = new Set<MateriaEdgeCondition>(["satisfied", "not_satisfied"]);

export interface LoopSemanticMaterializationOptions {
  loadoutName?: string;
}

/**
 * Compile declarative loop intent into the canonical runtime fields used by
 * native execution: parse, advance, and canonical loop exit routes.
 *
 * New materialization treats advance as cursor movement/exhaustion detection
 * only. Post-loop routing is encoded in loops.<id>.exits; when no canonical exit
 * route exists, runtime falls through to the terminal `end` sentinel. Existing
 * socket edges, including satisfied/not_satisfied retry or forward edges and UI
 * descriptive graph decorations, are preserved as normal control-flow edges.
 */
export function materializeLoadoutLoopSemantics(config: Pick<PiMateriaConfig, "materia">, pipeline: MateriaPipelineConfig, options: LoopSemanticMaterializationOptions = {}): void {
  reconcileLoadoutLoopConsumersFromGraphInPlace(pipeline, config.materia ?? {});
  for (const [loopId, loop] of Object.entries(pipeline.loops ?? {})) {
    materializeLoopExit(config.materia ?? {}, pipeline, loopId, loop, options);
  }
}

export function materializeConfigLoadoutLoopSemantics(config: PiMateriaConfig): void {
  for (const [loadoutName, pipeline] of Object.entries(config.loadouts ?? {})) {
    materializeLoadoutLoopSemantics(config, pipeline, { loadoutName });
  }
}

function materializeLoopExit(materia: Record<string, MateriaConfig>, pipeline: MateriaPipelineConfig, loopId: string, loop: MateriaLoopConfig, options: LoopSemanticMaterializationOptions): void {
  if (!loop.exit || !loop.consumes) return;
  const socket = getLoadoutSocket(pipeline, loop.exit.from);
  if (!socket) return;
  const generator = generatorForLoop(materia, pipeline, loop);
  if (!generator) return;

  const expectedAdvance = advanceForLoopExit(loop, generator);
  const source = loopSource(options.loadoutName, loopId, loop.exit.from);

  if (JSON_CONTROL_CONDITIONS.has(loop.exit.when)) materializeJsonParse(socket, source, loop.exit.when);
  materializeCanonicalLoopExitRoute(loop);
  materializeAdvance(socket, expectedAdvance, source);
}

function materializeJsonParse(socket: MateriaPipelineSocketConfig, source: string, when: MateriaEdgeCondition): void {
  if (socket.parse === "json") return;
  if (socket.parse === undefined) {
    socket.parse = "json";
    return;
  }
  throw new Error(`${source} uses loop exit condition "${when}", which requires parse: "json" on the exit source so the canonical satisfied field can be read. Current parse is "${socket.parse}".`);
}

function materializeAdvance(socket: MateriaPipelineSocketConfig, expected: MateriaAdvanceConfig, source: string): void {
  if (!socket.advance) {
    socket.advance = expected;
    return;
  }

  const conflicts = Object.entries(expected).flatMap(([key, expectedValue]) => {
    const actualValue = socket.advance?.[key as keyof MateriaAdvanceConfig];
    return actualValue === expectedValue ? [] : [`${key}: current ${JSON.stringify(actualValue)}, expected ${JSON.stringify(expectedValue)}`];
  });
  if (conflicts.length > 0) {
    throw new Error(`${source} has an existing advance block that conflicts with loop exit/consumes materialization (${conflicts.join("; ")}). Keep the authored advance aligned with loops.consumes and loops.exit, or remove it so it can be materialized.`);
  }
}

function materializeCanonicalLoopExitRoute(loop: MateriaLoopConfig): void {
  const exit = loop.exit;
  if (!exit || exit.to === TERMINAL_GRAPH_TARGET) return;
  const route = { id: `exit:${exit.from}:${exit.when}`, from: exit.from, condition: exit.when, targetSocketId: exit.to };
  const routes = (loop.exits ?? []).filter((candidate) => !(candidate.from === route.from && candidate.condition === route.condition));
  loop.exits = [...routes, route];
}

function advanceForLoopExit(loop: MateriaLoopConfig, generator: MateriaGeneratorConfig): MateriaAdvanceConfig {
  const output = loop.consumes?.output ?? generator.output;
  return {
    cursor: loop.consumes?.cursor ?? generator.cursor ?? `${output}Index`,
    items: generator.items ?? `state.${output}`,
    when: loop.exit?.when,
  };
}

function generatorForLoop(materia: Record<string, MateriaConfig>, pipeline: MateriaPipelineConfig, loop: MateriaLoopConfig): MateriaGeneratorConfig | undefined {
  const source = loop.consumes ? getLoadoutSocket(pipeline, loop.consumes.from) : undefined;
  if (!source || !isMateriaSocket(source)) return undefined;
  const generator = canonicalGeneratorConfigFor(materia[source.materia]);
  if (!generator) return undefined;
  const output = loop.consumes?.output ?? generator.output;
  return { ...generator, output };
}

function isMateriaSocket(socket: MateriaPipelineSocketConfig): socket is MateriaPipelineSocketConfig & { materia: string } {
  return (socket.type === "agent" || socket.type === "utility") && typeof socket.materia === "string";
}

function loopSource(loadoutName: string | undefined, loopId: string, socketId: string): string {
  return `${loadoutName ? `Materia loadout "${loadoutName}" ` : ""}loop "${loopId}" exit source "${socketId}"`;
}
