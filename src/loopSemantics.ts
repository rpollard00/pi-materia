import { canonicalGeneratorConfigFor } from "./generator.js";
import { reconcileLoadoutLoopConsumersFromGraphInPlace } from "./loadoutGraphAnalysis.js";
import type { MateriaAdvanceConfig, MateriaConfig, MateriaEdgeCondition, MateriaGeneratorConfig, MateriaLoopConfig, MateriaPipelineConfig, MateriaPipelineNodeConfig, PiMateriaConfig } from "./types.js";

const JSON_CONTROL_CONDITIONS = new Set<MateriaEdgeCondition>(["satisfied", "not_satisfied"]);

export interface LoopSemanticMaterializationOptions {
  loadoutName?: string;
}

/**
 * Compile declarative loop intent into the canonical runtime fields used by
 * native execution: parse, advance, and existing ordered edges.
 *
 * This intentionally does not add a second loop router and does not delete
 * unconditional back-edges. applyAdvance() runs before edge selection, so an
 * unconditional back-edge remains the correct continuation route for non-final
 * consumed items while advance.done controls final completion.
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
  const node = pipeline.nodes?.[loop.exit.from];
  if (!node) return;
  const generator = generatorForLoop(materia, pipeline, loop);
  if (!generator) return;

  const expectedAdvance = advanceForLoopExit(loop, generator);
  const source = loopSource(options.loadoutName, loopId, loop.exit.from);

  if (JSON_CONTROL_CONDITIONS.has(loop.exit.when)) materializeJsonParse(node, source, loop.exit.when);
  materializeAdvance(node, expectedAdvance, source);
}

function materializeJsonParse(node: MateriaPipelineNodeConfig, source: string, when: MateriaEdgeCondition): void {
  if (node.parse === "json") return;
  if (node.parse === undefined) {
    node.parse = "json";
    return;
  }
  throw new Error(`${source} uses loop exit condition "${when}", which requires parse: "json" on the exit source so the canonical satisfied field can be read. Current parse is "${node.parse}".`);
}

function materializeAdvance(node: MateriaPipelineNodeConfig, expected: MateriaAdvanceConfig, source: string): void {
  if (!node.advance) {
    node.advance = expected;
    return;
  }

  const conflicts = Object.entries(expected).flatMap(([key, expectedValue]) => {
    const actualValue = node.advance?.[key as keyof MateriaAdvanceConfig];
    return actualValue === expectedValue ? [] : [`${key}: current ${JSON.stringify(actualValue)}, expected ${JSON.stringify(expectedValue)}`];
  });
  if (conflicts.length > 0) {
    throw new Error(`${source} has an existing advance block that conflicts with loop exit/consumes materialization (${conflicts.join("; ")}). Keep the authored advance aligned with loops.consumes and loops.exit, or remove it so it can be materialized.`);
  }
}

function advanceForLoopExit(loop: MateriaLoopConfig, generator: MateriaGeneratorConfig): MateriaAdvanceConfig {
  const output = loop.consumes?.output ?? generator.output;
  return {
    cursor: loop.consumes?.cursor ?? generator.cursor ?? `${output}Index`,
    items: generator.items ?? `state.${output}`,
    done: loop.exit?.to,
    when: loop.exit?.when,
  };
}

function generatorForLoop(materia: Record<string, MateriaConfig>, pipeline: MateriaPipelineConfig, loop: MateriaLoopConfig): MateriaGeneratorConfig | undefined {
  const source = loop.consumes ? pipeline.nodes?.[loop.consumes.from] : undefined;
  if (!source || source.type !== "agent") return undefined;
  const generator = canonicalGeneratorConfigFor(materia[source.materia]);
  if (!generator) return undefined;
  const output = loop.consumes?.output ?? generator.output;
  return { ...generator, output };
}

function loopSource(loadoutName: string | undefined, loopId: string, nodeId: string): string {
  return `${loadoutName ? `Materia loadout "${loadoutName}" ` : ""}loop "${loopId}" exit source "${nodeId}"`;
}
