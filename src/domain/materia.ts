import { ok, type DomainIssue, type DomainResult } from "./result.js";
import type { Loadout, MateriaId, MateriaParseMode } from "./loadout.js";
import { validateToolScopeSpecShape, type ToolScopeSpec } from "./toolScope.js";

export type MateriaDefinitionType = "agent" | "utility";
export type MateriaAgentTools = ToolScopeSpec;

export interface MateriaBehaviorIdentity {
  /** Stable reusable behavior id; for persisted config this is the materia record key. */
  id: MateriaId;
  label?: string;
  description?: string;
  group?: string;
  color?: string;
}

export interface MateriaPromptIntentMetadata {
  /** Human-readable intent/category for prompt assembly and editor summaries. */
  intent?: string;
  /** Whether this materia normally emits the canonical handoff JSON contract. */
  includeHandoffContract?: boolean;
  /** Optional summary of the expected output shape; not a runtime parser implementation. */
  output?: string;
}

export interface MateriaGeneratorMetadata {
  output: string;
  items?: string;
  listType: "array";
  itemType: string;
  as?: string;
  cursor?: string;
  done?: string;
}

export interface MateriaDefinitionCommon {
  id: MateriaId;
  type: MateriaDefinitionType;
  behavior: MateriaBehaviorIdentity;
  parse?: MateriaParseMode;
  generator?: boolean;
  /** Obsolete metadata; generator: true is the canonical domain flag. */
  generates?: MateriaGeneratorMetadata;
  promptIntent?: MateriaPromptIntentMetadata;
}

export interface AgentMateriaDefinition extends MateriaDefinitionCommon {
  type: "agent";
  tools: MateriaAgentTools;
  prompt: string;
  model?: string;
  thinking?: string;
  multiTurn?: boolean;
}

export interface UtilityMateriaDefinition extends MateriaDefinitionCommon {
  type: "utility";
  utility?: string;
  command?: string[];
  params?: Record<string, unknown>;
  timeoutMs?: number;
  assign?: Record<string, string>;
}

export type MateriaDefinition = AgentMateriaDefinition | UtilityMateriaDefinition;
export type MateriaCatalog = Record<MateriaId, MateriaDefinition>;

/**
 * Structural compatibility input for existing src/types.ts MateriaConfig records.
 * Keep this adapter pure and data-only so domain does not import runtime/config modules.
 */
export type MateriaConfigCompatible = Record<string, unknown>;

export function normalizeMateriaDefinition(id: MateriaId, config: MateriaConfigCompatible, path = `materia.${id}`): DomainResult<MateriaDefinition> {
  if (!isPlainObject(config)) return { ok: false, issues: [{ path, message: "materia definition must be an object" }] };

  const rawType = config.type;
  if (rawType !== undefined && rawType !== "agent" && rawType !== "utility") {
    return { ok: false, issues: [{ path: `${path}.type`, message: "materia type must be agent or utility" }] };
  }
  const type: MateriaDefinitionType = rawType ?? (config.utility !== undefined || config.command !== undefined || config.script !== undefined ? "utility" : "agent");
  const behavior: MateriaBehaviorIdentity = {
    id,
    ...(typeof config.label === "string" ? { label: config.label } : {}),
    ...(typeof config.description === "string" ? { description: config.description } : {}),
    ...(typeof config.group === "string" ? { group: config.group } : {}),
    ...(typeof config.color === "string" ? { color: config.color } : {}),
  };

  const common = {
    id,
    type,
    behavior,
    ...(config.parse !== undefined ? { parse: config.parse as MateriaParseMode } : {}),
    ...(config.generator !== undefined ? { generator: config.generator === true } : {}),
    ...(isPlainObject(config.generates) ? { generates: config.generates as unknown as MateriaGeneratorMetadata } : {}),
    ...(isPlainObject(config.promptIntent) ? { promptIntent: config.promptIntent as unknown as MateriaPromptIntentMetadata } : {}),
  } satisfies MateriaDefinitionCommon;

  const definition = type === "agent"
    ? {
        ...common,
        type: "agent" as const,
        tools: normalizeMateriaTools(config.tools),
        prompt: typeof config.prompt === "string" ? config.prompt : "",
        ...(typeof config.model === "string" ? { model: config.model } : {}),
        ...(typeof config.thinking === "string" ? { thinking: config.thinking } : {}),
        ...(config.multiTurn !== undefined ? { multiTurn: config.multiTurn === true } : {}),
      }
    : {
        ...common,
        type: "utility" as const,
        ...(typeof config.utility === "string" ? { utility: config.utility } : {}),
        ...(Array.isArray(config.command) ? { command: [...config.command] as string[] } : {}),
        ...(isPlainObject(config.params) ? { params: { ...config.params } } : {}),
        ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
        ...(isStringRecord(config.assign) ? { assign: { ...config.assign } } : {}),
      };

  const validation = validateMateriaDefinition(definition, path);
  return validation.ok ? ok(definition) : validation;
}

export function normalizeMateriaCatalog(configs: Record<string, MateriaConfigCompatible>, path = "materia"): DomainResult<MateriaCatalog> {
  const issues: DomainIssue[] = [];
  const catalog: MateriaCatalog = {};
  for (const [id, config] of Object.entries(configs)) {
    const result = normalizeMateriaDefinition(id, config, `${path}.${id}`);
    if (result.ok) catalog[id] = result.value;
    else issues.push(...result.issues);
  }
  return issues.length > 0 ? { ok: false, issues } : ok(catalog);
}

export function validateMateriaDefinition(definition: MateriaDefinition, path = `materia.${definition.id}`): DomainResult<MateriaDefinition> {
  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(definition.id)) issues.push({ path: `${path}.id`, message: "materia id is required" });
  if (definition.behavior.id !== definition.id) issues.push({ path: `${path}.behavior.id`, message: "behavior id must match materia id" });
  if (definition.type !== "agent" && definition.type !== "utility") issues.push({ path: `${path}.type`, message: "materia type must be agent or utility" });
  if (definition.parse !== undefined && definition.parse !== "text" && definition.parse !== "json") issues.push({ path: `${path}.parse`, message: "parse must be text or json" });
  if (definition.generator !== undefined && typeof definition.generator !== "boolean") issues.push({ path: `${path}.generator`, message: "generator must be a boolean" });
  validateGenerator(definition.generates, `${path}.generates`, issues);
  validatePromptIntent(definition.promptIntent, `${path}.promptIntent`, issues);

  if (definition.type === "agent") {
    const toolsValidation = validateToolScopeSpecShape(definition.tools, `${path}.tools`);
    if (!toolsValidation.ok) issues.push(...toolsValidation.issues);
    if (!isNonEmptyString(definition.prompt)) issues.push({ path: `${path}.prompt`, message: "agent prompt is required" });
    if (definition.multiTurn !== undefined && typeof definition.multiTurn !== "boolean") issues.push({ path: `${path}.multiTurn`, message: "multiTurn must be a boolean" });
  } else {
    if (definition.command !== undefined && !definition.command.every(isNonEmptyString)) issues.push({ path: `${path}.command`, message: "utility command entries must be non-empty strings" });
    if (definition.timeoutMs !== undefined && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)) issues.push({ path: `${path}.timeoutMs`, message: "timeoutMs must be a positive number" });
  }

  return issues.length > 0 ? { ok: false, issues } : ok(copyMateriaDefinition(definition));
}

export function validateLoadoutMateriaReferences(loadout: Loadout, catalog: MateriaCatalog, path = "loadout"): DomainResult<Loadout> {
  const issues: DomainIssue[] = [];
  for (const [socketId, socket] of Object.entries(loadout.sockets ?? {})) {
    const materia = catalog[socket.materia];
    if (!materia) {
      issues.push({ path: `${path}.sockets.${socketId}.materia`, message: `socket references unknown materia ${JSON.stringify(socket.materia)}` });
      continue;
    }
  }
  return issues.length > 0 ? { ok: false, issues } : ok(loadout);
}

function validateGenerator(value: MateriaGeneratorMetadata | undefined, path: string, issues: DomainIssue[]): void {
  if (value === undefined) return;
  if (!isNonEmptyString(value.output)) issues.push({ path: `${path}.output`, message: "generator output is required" });
  if (value.listType !== "array") issues.push({ path: `${path}.listType`, message: "generator listType must be array" });
  if (!isNonEmptyString(value.itemType)) issues.push({ path: `${path}.itemType`, message: "generator itemType is required" });
}

function validatePromptIntent(value: MateriaPromptIntentMetadata | undefined, path: string, issues: DomainIssue[]): void {
  if (value === undefined) return;
  if (value.includeHandoffContract !== undefined && typeof value.includeHandoffContract !== "boolean") issues.push({ path: `${path}.includeHandoffContract`, message: "includeHandoffContract must be a boolean" });
}

function copyMateriaDefinition<T extends MateriaDefinition>(definition: T): T {
  return {
    ...definition,
    behavior: { ...definition.behavior },
    ...(definition.generates ? { generates: { ...definition.generates } } : {}),
    ...(definition.promptIntent ? { promptIntent: { ...definition.promptIntent } } : {}),
    ...(definition.type === "utility" && definition.command ? { command: [...definition.command] } : {}),
    ...(definition.type === "utility" && definition.params ? { params: { ...definition.params } } : {}),
    ...(definition.type === "utility" && definition.assign ? { assign: { ...definition.assign } } : {}),
  } as T;
}

function normalizeMateriaTools(value: unknown): MateriaAgentTools {
  const result = validateToolScopeSpecShape(value);
  return result.ok ? result.value : value as MateriaAgentTools;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}
