import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { loadProfileConfig } from "./config.js";
import { HANDOFF_CONTRACT_PROMPT_TEXT } from "./handoffContract.js";
import { getActiveModelInfo } from "./modelSettings.js";
import type { MateriaGeneratorConfig, MateriaRoleGenerationProfileConfig } from "./types.js";

export interface MateriaRolePromptGenerationRequest {
  brief: string;
  generates?: MateriaGeneratorConfig | null;
}

export type MateriaRolePromptGenerationResult =
  | { ok: true; prompt: string; model?: string; provider?: string; api?: string; thinking?: string; isolated: true }
  | { ok: false; error: string; code: "invalid_brief" | "disabled" | "generation_failed" };

export interface MateriaRolePromptGenerationSettings {
  model?: Model<Api>;
  modelLabel?: string;
  provider?: string;
  api?: string;
  thinking?: ThinkingLevel;
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
    const settings = resolveRoleGenerationSettings(pi, ctx, profile);
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

export function resolveRoleGenerationSettings(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  profile: MateriaRoleGenerationProfileConfig,
): MateriaRolePromptGenerationSettings {
  const active = getActiveModelInfo(pi, ctx);
  const model = resolveRoleGenerationModel(ctx, profile) ?? active.model;
  const thinking = normalizeRoleGenerationThinking(profile.thinking) ?? active.thinking;
  return {
    model,
    modelLabel: model ? `${model.provider}/${model.id}` : active.modelId,
    provider: model?.provider ?? profile.provider ?? active.provider,
    api: profile.api ?? model?.api ?? active.api,
    thinking,
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
    "When the generated role prompt asks for JSON or handoff output, it must instruct the materia to follow this central contract instead of inventing a local JSON contract:",
    HANDOFF_CONTRACT_PROMPT_TEXT,
    "Do not include markdown fences, commentary about generation, or UI instructions.",
    roleGenerationContext(generates),
    profile.extraInstructions ? `Additional operator instructions:\n${profile.extraInstructions}` : undefined,
    `User brief:\n${brief}`,
  ].filter(Boolean).join("\n\n");
}

function roleGenerationContext(generates: MateriaGeneratorConfig | null | undefined): string {
  if (!generates) return "Generator role: none configured.";
  return [
    "Generator role: produce the canonical workItems list for downstream loop regions.",
    `- canonical output key: ${generates.output}`,
    `- list type: ${generates.listType}`,
    `- item type: ${generates.itemType}`,
    generates.items ? `- items path: ${generates.items}` : undefined,
    generates.as ? `- work item alias: ${generates.as}` : undefined,
    generates.cursor ? `- cursor: ${generates.cursor}` : undefined,
    generates.done ? `- done behavior: ${generates.done}` : undefined,
    "Treat this as node/socket adapter metadata for assignment and iteration. The generated role prompt must use the canonical handoff envelope and put generated units of work in workItems, not in reserved evaluator/route fields or legacy placement-specific outputs such as tasks. Preserve and augment existing envelope context when refining or evaluating JSON output.",
  ].filter(Boolean).join("\n");
}

function resolveRoleGenerationModel(ctx: ExtensionContext, profile: MateriaRoleGenerationProfileConfig): Model<Api> | undefined {
  const modelText = profile.model?.trim();
  const providerText = profile.provider?.trim();
  if (!modelText) return undefined;
  const registry = ctx.modelRegistry;
  const qualified = parseProviderAndModel(modelText);
  const provider = qualified?.provider ?? providerText;
  const modelId = qualified?.modelId ?? modelText;
  if (provider) return registry.find(provider, modelId) as Model<Api> | undefined;
  const matches = registry.getAll().filter((model) => model.id === modelId || `${model.provider}/${model.id}` === modelText);
  if (matches.length === 1) return matches[0] as Model<Api>;
  if (matches.length > 1) throw new Error(`Role generation model "${modelText}" is ambiguous; configure roleGeneration.provider or use provider/modelId.`);
  throw new Error(`Unknown role generation model "${modelText}".`);
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
