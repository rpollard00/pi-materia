import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadProfileConfig } from "../config/config.js";
import { CANONICAL_WORK_ITEMS_GENERATOR_CONFIG } from "../graph/generator.js";
import { getActiveModelInfo } from "../config/modelSettings.js";
import type { MateriaGeneratorConfig, MateriaRoleGenerationProfileConfig } from "../types.js";

export interface MateriaRolePromptGenerationRequest {
  brief: string;
  generates?: MateriaGeneratorConfig | null;
}

export interface MateriaRoleGenerationModelResolution {
  requestedModel: string | null;
  effectiveModel: string | null;
  fallback: boolean;
  warnings: string[];
}

export type MateriaRolePromptGenerationResult =
  | { ok: true; prompt: string; model?: string; provider?: string; api?: string; thinking?: string; isolated: true; warnings?: string[]; modelResolution: MateriaRoleGenerationModelResolution }
  | { ok: false; error: string; code: "invalid_brief" | "disabled" | "generation_failed" };

export interface MateriaRolePromptGenerationSettings {
  model?: Model<Api>;
  modelLabel?: string;
  provider?: string;
  api?: string;
  thinking?: ThinkingLevel;
  warnings?: string[];
  modelResolution: MateriaRoleGenerationModelResolution;
}

export interface MateriaRolePromptGeneratorInput {
  brief: string;
  generates?: MateriaGeneratorConfig | null;
  settings: MateriaRolePromptGenerationSettings;
  profile: MateriaRoleGenerationProfileConfig;
  cwd: string;
}

export type MateriaRolePromptGenerator = (input: MateriaRolePromptGeneratorInput) => Promise<string>;

export interface GenerateMateriaRolePromptOptions {
  profile?: MateriaRoleGenerationProfileConfig;
  generator?: MateriaRolePromptGenerator;
}

const MAX_BRIEF_CHARS = 4_000;

export async function generateMateriaRolePrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: MateriaRolePromptGenerationRequest,
  options: GenerateMateriaRolePromptOptions = {},
): Promise<MateriaRolePromptGenerationResult> {
  const validation = validateMateriaRoleBrief(request.brief);
  if (!validation.ok) return validation;

  const profile = options.profile ?? (await loadProfileConfig()).roleGeneration ?? {};
  if (profile.enabled === false) return { ok: false, code: "disabled", error: "Materia role prompt generation is disabled in the profile config." };

  try {
    const settings = await resolveRoleGenerationSettings(pi, ctx, profile);
    const prompt = (await (options.generator ?? defaultMateriaRolePromptGenerator)({
      brief: validation.brief,
      generates: request.generates ?? null,
      settings,
      profile,
      cwd: ctx.cwd,
    })).trim();
    if (!prompt) return { ok: false, code: "generation_failed", error: "Role prompt generation returned empty text." };
    return {
      ok: true,
      prompt,
      isolated: true,
      model: settings.modelLabel,
      provider: settings.provider,
      api: settings.api,
      thinking: settings.thinking,
      warnings: settings.warnings,
      modelResolution: settings.modelResolution,
    };
  } catch (error) {
    return { ok: false, code: "generation_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export function validateMateriaRoleBrief(brief: unknown): { ok: true; brief: string } | Extract<MateriaRolePromptGenerationResult, { ok: false }> {
  if (typeof brief !== "string") return { ok: false, code: "invalid_brief", error: "Expected brief to be a string." };
  const trimmed = brief.trim();
  if (!trimmed) return { ok: false, code: "invalid_brief", error: "Role brief cannot be empty." };
  if (trimmed.length > MAX_BRIEF_CHARS) return { ok: false, code: "invalid_brief", error: `Role brief is too long; limit is ${MAX_BRIEF_CHARS} characters.` };
  return { ok: true, brief: trimmed };
}

export async function resolveRoleGenerationSettings(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  profile: MateriaRoleGenerationProfileConfig,
): Promise<MateriaRolePromptGenerationSettings> {
  const active = getActiveModelInfo(pi, ctx);
  const choice = await resolveRoleGenerationModelChoice(ctx, profile, active.model);
  const model = choice.model;
  const thinking = normalizeRoleGenerationThinking(profile.thinking) ?? active.thinking;
  return {
    model,
    modelLabel: model ? `${model.provider}/${model.id}` : active.modelId,
    provider: model?.provider ?? active.provider,
    api: profile.api ?? model?.api ?? active.api,
    thinking,
    warnings: choice.resolution.warnings,
    modelResolution: choice.resolution,
  };
}

export interface ResolvedRoleGenerationModelChoice {
  model?: Model<Api>;
  resolution: MateriaRoleGenerationModelResolution;
}

export async function resolveRoleGenerationModelChoice(
  ctx: ExtensionContext,
  profile: MateriaRoleGenerationProfileConfig,
  activeModel: Model<Api> | undefined,
): Promise<ResolvedRoleGenerationModelChoice> {
  const requestedModel = profile.model?.trim() || null;
  const activeLabel = activeModel ? `${activeModel.provider}/${activeModel.id}` : null;
  const fallback = (warnings: string[]): ResolvedRoleGenerationModelChoice => ({
    model: activeModel,
    resolution: { requestedModel, effectiveModel: activeLabel, fallback: requestedModel !== null, warnings },
  });

  if (!requestedModel) return fallback([]);

  const unavailableWarning = 'Saved generation model is unavailable; using Active Pi Model.';
  const qualified = parseProviderAndModel(requestedModel);
  if (!qualified) return fallback([unavailableWarning]);

  let available: Model<Api>[] | undefined;
  try {
    const getAvailable = (ctx.modelRegistry as unknown as { getAvailable?: () => Model<Api>[] | Promise<Model<Api>[]> } | undefined)?.getAvailable;
    if (typeof getAvailable !== "function") return fallback([unavailableWarning]);
    const result = await getAvailable.call(ctx.modelRegistry);
    if (!Array.isArray(result)) return fallback([unavailableWarning]);
    available = result;
  } catch {
    return fallback([unavailableWarning]);
  }

  const matches = available.filter((model) => model.provider === qualified.provider && model.id === qualified.modelId);
  if (matches.length !== 1) return fallback([unavailableWarning]);
  const model = matches[0];
  return {
    model,
    resolution: { requestedModel, effectiveModel: `${model.provider}/${model.id}`, fallback: false, warnings: [] },
  };
}

async function defaultMateriaRolePromptGenerator(input: MateriaRolePromptGeneratorInput): Promise<string> {
  const { session } = await createAgentSession({
    cwd: input.cwd,
    sessionManager: SessionManager.inMemory(input.cwd),
    model: input.settings.model,
    thinkingLevel: input.settings.thinking,
    noTools: "all",
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });

  const prompt = buildRoleGenerationPrompt(input.brief, input.profile, input.generates);
  await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
  const text = lastAssistantText((session as unknown as { messages?: unknown[] }).messages);
  if (!text) throw new Error("No assistant response was produced for the role prompt brief.");
  return text;
}

export function buildRoleGenerationPrompt(
  brief: string,
  profile: MateriaRoleGenerationProfileConfig = {},
  generates?: MateriaGeneratorConfig | null,
): string {
  return [
    "You generate concise pi-materia role prompt instructions.",
    "Return only the role prompt text to place in a Materia config `prompt` field.",
    "The prompt should define the agent's responsibilities, operating style, constraints, and expected output behavior.",
    "When the generated role prompt asks for JSON or handoff output, describe only socket-relevant payload fields and never ask for the entire canonical envelope unless the brief explicitly requires every field.",
    "Do not include markdown fences, commentary about generation, or UI instructions.",
    roleGenerationContext(generates),
    profile.extraInstructions ? `Additional operator instructions:\n${profile.extraInstructions}` : undefined,
    `User brief:\n${brief}`,
  ].filter(Boolean).join("\n\n");
}

function roleGenerationContext(generates: MateriaGeneratorConfig | null | undefined): string {
  if (!generates) return "Generator role: none configured.";
  const canonical = CANONICAL_WORK_ITEMS_GENERATOR_CONFIG;
  return [
    "Generator role: produce a workItems list for downstream loop regions.",
    `- output key: ${canonical.output}`,
    `- list type: ${canonical.listType}`,
    `- item type: ${canonical.itemType}`,
    `- items path: state.${canonical.output}`,
    `- cursor: ${canonical.cursor}`,
    `- done behavior: ${canonical.done}`,
    "Treat this as socket adapter metadata for assignment and iteration. The generated role prompt should place generated units of work in workItems and ask for only useful generator payload fields such as a concise summary plus workItems.",
  ].join("\n");
}

function parseProviderAndModel(value: string): { provider: string; modelId: string } | undefined {
  const separator = value.includes("/") ? "/" : value.includes(":") ? ":" : undefined;
  if (!separator) return undefined;
  const [provider, ...rest] = value.split(separator);
  const modelId = rest.join(separator);
  return provider && modelId ? { provider, modelId } : undefined;
}

function normalizeRoleGenerationThinking(value: string | undefined): ThinkingLevel | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
  if (!allowed.has(normalized)) throw new Error(`Unknown role generation thinking level "${value}".`);
  return normalized as ThinkingLevel;
}

function lastAssistantText(messages: unknown[] | undefined): string | undefined {
  for (const message of [...(messages ?? [])].reverse()) {
    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate.role === "assistant") {
      const text = contentText(candidate.content).trim();
      if (text) return text;
    }
  }
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? item.text : "";
  }).join("\n");
}
