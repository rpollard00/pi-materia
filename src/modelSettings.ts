import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

export interface ActiveModelInfo {
  model?: Model<Api>;
  provider?: string;
  modelId?: string;
  modelName?: string;
  api?: string;
  thinking?: ThinkingLevel;
}

export interface MateriaModelSettings {
  materiaName: string;
  model?: string;
  thinking?: string;
}

export interface AppliedMateriaModelSettings extends ActiveModelInfo {
  requestedModel?: string;
  requestedThinking?: string;
  modelExplicit: boolean;
  thinkingExplicit: boolean;
}

export class MateriaModelSettingsError extends Error {
  constructor(materiaName: string, field: "model" | "thinking", message: string) {
    super(`Materia "${materiaName}" ${field} setting is unsupported: ${message}`);
    this.name = "MateriaModelSettingsError";
  }
}

const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Read the active Pi model/thinking state through the extension runtime.
 * Missing fields are tolerated so older Pi runtimes can still run model-free materia.
 */
export function getActiveModelInfo(pi: ExtensionAPI, ctx: ExtensionContext): ActiveModelInfo {
  const model = ctx.model as Model<Api> | undefined;
  const thinking = typeof maybeGetThinkingLevel(pi) === "function" ? maybeGetThinkingLevel(pi)?.call(pi) : undefined;
  return {
    model,
    provider: model?.provider,
    modelId: model?.id,
    modelName: model?.name,
    api: model?.api,
    thinking,
  };
}

/**
 * Apply explicit per-materia model settings, if present. Omitting both fields is a no-op
 * that preserves the user's active Pi model and thinking level.
 */
export async function applyMateriaModelSettings(pi: ExtensionAPI, ctx: ExtensionContext, settings: MateriaModelSettings): Promise<AppliedMateriaModelSettings> {
  const modelExplicit = settings.model !== undefined;
  const thinkingExplicit = settings.thinking !== undefined;

  if (!modelExplicit && !thinkingExplicit) {
    return { ...getActiveModelInfo(pi, ctx), modelExplicit, thinkingExplicit };
  }

  let appliedModel: Model<Api> | undefined;
  let appliedThinking: ThinkingLevel | undefined;

  if (modelExplicit) {
    const setModel = maybeSetModel(pi);
    if (typeof setModel !== "function") {
      throw new MateriaModelSettingsError(settings.materiaName, "model", "this Pi runtime does not expose pi.setModel(model)");
    }
    appliedModel = resolveConfiguredModel(ctx, settings.materiaName, settings.model);
    const ok = await setModel.call(pi, appliedModel);
    if (!ok) {
      throw new MateriaModelSettingsError(settings.materiaName, "model", `no configured API key or credentials for ${appliedModel.provider}/${appliedModel.id}`);
    }
  }

  if (thinkingExplicit) {
    const setThinkingLevel = maybeSetThinkingLevel(pi);
    if (typeof setThinkingLevel !== "function") {
      throw new MateriaModelSettingsError(settings.materiaName, "thinking", "this Pi runtime does not expose pi.setThinkingLevel(level)");
    }
    appliedThinking = normalizeThinkingLevel(settings.materiaName, settings.thinking);
    setThinkingLevel.call(pi, appliedThinking);
  }

  const active = getActiveModelInfo(pi, ctx);
  const model = appliedModel ?? active.model;
  return {
    ...active,
    model,
    provider: model?.provider ?? active.provider,
    modelId: model?.id ?? active.modelId,
    modelName: model?.name ?? active.modelName,
    api: model?.api ?? active.api,
    thinking: appliedThinking ?? active.thinking,
    requestedModel: settings.model,
    requestedThinking: settings.thinking,
    modelExplicit,
    thinkingExplicit,
  };
}

function resolveConfiguredModel(ctx: ExtensionContext, materiaName: string, requested: string | undefined): Model<Api> {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new MateriaModelSettingsError(materiaName, "model", "expected a non-empty model string");
  }
  const value = requested.trim();
  const registry = ctx.modelRegistry;
  const providerAndId = parseProviderAndModel(value);
  if (providerAndId) {
    const model = registry.find(providerAndId.provider, providerAndId.modelId) as Model<Api> | undefined;
    if (!model) throw new MateriaModelSettingsError(materiaName, "model", `unknown model ${providerAndId.provider}/${providerAndId.modelId}`);
    return model;
  }

  const matches = registry.getAll().filter((model) => model.id === value || `${model.provider}/${model.id}` === value);
  if (matches.length === 1) return matches[0] as Model<Api>;
  if (matches.length > 1) {
    throw new MateriaModelSettingsError(materiaName, "model", `model id "${value}" is ambiguous; use provider/modelId`);
  }
  throw new MateriaModelSettingsError(materiaName, "model", `unknown model "${value}"; use provider/modelId or a unique model id`);
}

function parseProviderAndModel(value: string): { provider: string; modelId: string } | undefined {
  const separator = value.includes("/") ? "/" : value.includes(":") ? ":" : undefined;
  if (!separator) return undefined;
  const [provider, ...rest] = value.split(separator);
  const modelId = rest.join(separator);
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

function normalizeThinkingLevel(materiaName: string, requested: string | undefined): ThinkingLevel {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new MateriaModelSettingsError(materiaName, "thinking", "expected a non-empty thinking string");
  }
  const level = requested.trim().toLowerCase();
  if (!THINKING_LEVELS.has(level)) {
    throw new MateriaModelSettingsError(materiaName, "thinking", `unknown thinking level "${requested}"; expected one of ${Array.from(THINKING_LEVELS).join(", ")}`);
  }
  return level as ThinkingLevel;
}

function maybeGetThinkingLevel(pi: ExtensionAPI): (() => ThinkingLevel) | undefined {
  return (pi as unknown as { getThinkingLevel?: () => ThinkingLevel }).getThinkingLevel;
}

function maybeSetThinkingLevel(pi: ExtensionAPI): ((level: ThinkingLevel) => void) | undefined {
  return (pi as unknown as { setThinkingLevel?: (level: ThinkingLevel) => void }).setThinkingLevel;
}

function maybeSetModel(pi: ExtensionAPI): ((model: Model<Api>) => Promise<boolean>) | undefined {
  return (pi as unknown as { setModel?: (model: Model<Api>) => Promise<boolean> }).setModel;
}
