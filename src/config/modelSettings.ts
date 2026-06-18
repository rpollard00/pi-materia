import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

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
  modelFallbackReason?: string;
  thinkingFallbackReason?: string;
  fallbackReason?: string;
  warnings?: string[];
  /** True when pi.setModel was called, succeeded, and the model actually differs
   *  from the previously-active model (by provider/id). False for omitted/blank
   *  model settings, failed fallback, same-model continuation, and thinking-only
   *  changes. This signals a context-window reset and callers may suppress
   *  proactive compaction for the immediate turn. */
  modelSwitched?: boolean;
}

export class MateriaModelSettingsError extends Error {
  constructor(materiaName: string, field: "model" | "thinking", message: string) {
    super(`Materia "${materiaName}" ${field} setting is unsupported: ${message}`);
    this.name = "MateriaModelSettingsError";
  }
}

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_ORDER);
const STANDARD_REASONING_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const NON_REASONING_THINKING_LEVELS: ThinkingLevel[] = ["off"];

type MaybePromise<T> = T | Promise<T>;
type ModelFallbackReason = "unknown_model" | "ambiguous_model" | "credentials_missing" | "model_registry_unavailable";
type ThinkingFallbackReason = "unknown_thinking" | "unsupported_thinking" | "thinking_runtime_unavailable";

type ModelRegistryLike = {
  getAvailable?: () => MaybePromise<unknown>;
  getAll?: () => unknown;
  find?: (provider: string, modelId: string) => unknown;
};

type ModelReferenceMatch =
  | { kind: "none" }
  | { kind: "single"; model: Model<Api> }
  | { kind: "ambiguous"; message: string };

type ConfiguredModelResolution =
  | { ok: true; model: Model<Api> }
  | { ok: false; reason: ModelFallbackReason; detail: string };

type ConfiguredThinkingResolution =
  | { ok: true; level: ThinkingLevel }
  | { ok: false; reason: ThinkingFallbackReason; detail: string };

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
 * Apply explicit per-materia model settings, if present. Omitting model/thinking or
 * configuring blank strings is a no-op that preserves the active Pi session state.
 *
 * If a configured model is unknown, unavailable, or cannot be selected because the
 * provider credentials are missing, the cast continues with the active Pi session
 * model and emits/records a warning instead of failing the turn.
 */
export async function applyMateriaModelSettings(pi: ExtensionAPI, ctx: ExtensionContext, settings: MateriaModelSettings): Promise<AppliedMateriaModelSettings> {
  const requestedModel = normalizeOptionalSetting(settings.model);
  const requestedThinking = normalizeOptionalSetting(settings.thinking);
  const modelExplicit = requestedModel !== undefined;
  const thinkingExplicit = requestedThinking !== undefined;
  const warnings: string[] = [];
  let modelFallbackReason: ModelFallbackReason | undefined;
  let thinkingFallbackReason: ThinkingFallbackReason | undefined;

  if (!modelExplicit && !thinkingExplicit) {
    return { ...getActiveModelInfo(pi, ctx), modelExplicit, thinkingExplicit };
  }

  const initialActive = getActiveModelInfo(pi, ctx);
  let appliedModel: Model<Api> | undefined;
  let appliedThinking: ThinkingLevel | undefined;

  let modelSwitched: boolean | undefined;

  if (modelExplicit) {
    const resolved = await resolveConfiguredModel(ctx, requestedModel);
    if (resolved.ok) {
      const setModel = maybeSetModel(pi);
      if (typeof setModel !== "function") {
        throw new MateriaModelSettingsError(settings.materiaName, "model", "this Pi runtime does not expose pi.setModel(model)");
      }
      let ok = false;
      let setModelError: unknown;
      try {
        ok = await setModel.call(pi, resolved.model);
      } catch (error) {
        setModelError = error;
      }
      if (ok) {
        appliedModel = resolved.model;
        // Model was explicitly applied and setModel succeeded.
        // Signal a switch only if the provider or id actually changed
        // compared to the active model before application.
        modelSwitched = initialActive.provider !== resolved.model.provider
          || initialActive.modelId !== resolved.model.id;
      } else {
        modelFallbackReason = "credentials_missing";
        const detail = setModelError
          ? `unable to switch to ${modelLabel(resolved.model)}: ${errorMessage(setModelError)}`
          : `no configured API key or credentials for ${modelLabel(resolved.model)}`;
        warnings.push(modelFallbackWarning(settings.materiaName, requestedModel, detail, initialActive));
      }
    } else {
      modelFallbackReason = resolved.reason;
      warnings.push(modelFallbackWarning(settings.materiaName, requestedModel, resolved.detail, initialActive));
    }
  }

  if (thinkingExplicit) {
    const activeAfterModel = getActiveModelInfo(pi, ctx);
    const effectiveModel = appliedModel ?? activeAfterModel.model ?? initialActive.model;
    const resolvedThinking = resolveConfiguredThinking(requestedThinking);
    const supportedLevels = supportedThinkingLevelsFor(effectiveModel);
    if (!resolvedThinking.ok) {
      thinkingFallbackReason = resolvedThinking.reason;
      appliedThinking = await applyThinkingFallback(pi, ctx, supportedLevels);
      warnings.push(thinkingFallbackWarning(settings.materiaName, requestedThinking, resolvedThinking.detail, effectiveModel, appliedThinking));
    } else if (supportedLevels && !supportedLevels.includes(resolvedThinking.level)) {
      thinkingFallbackReason = "unsupported_thinking";
      appliedThinking = await applyThinkingFallback(pi, ctx, supportedLevels);
      warnings.push(thinkingFallbackWarning(settings.materiaName, requestedThinking, `supported levels for the effective model are ${supportedLevels.join(", ")}`, effectiveModel, appliedThinking));
    } else {
      const setThinkingLevel = maybeSetThinkingLevel(pi);
      if (typeof setThinkingLevel !== "function") {
        throw new MateriaModelSettingsError(settings.materiaName, "thinking", "this Pi runtime does not expose pi.setThinkingLevel(level)");
      }
      appliedThinking = resolvedThinking.level;
      setThinkingLevel.call(pi, appliedThinking);
    }
  }

  for (const warning of warnings) ctx.ui.notify(warning, "warning");

  const active = getActiveModelInfo(pi, ctx);
  const model = appliedModel ?? active.model ?? initialActive.model;
  const fallbackReason = modelFallbackReason ?? thinkingFallbackReason;
  return {
    ...active,
    model,
    provider: model?.provider ?? active.provider,
    modelId: model?.id ?? active.modelId,
    modelName: model?.name ?? active.modelName,
    api: model?.api ?? active.api,
    thinking: appliedThinking ?? active.thinking,
    requestedModel,
    requestedThinking,
    modelExplicit,
    thinkingExplicit,
    modelFallbackReason,
    thinkingFallbackReason,
    fallbackReason,
    ...(modelSwitched !== undefined ? { modelSwitched } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

async function resolveConfiguredModel(ctx: ExtensionContext, requested: string): Promise<ConfiguredModelResolution> {
  const value = requested.trim();
  const registry = ctx.modelRegistry as unknown as ModelRegistryLike | undefined;
  const available = await readAvailableModels(registry);
  if (available) {
    const availableMatch = matchModelReference(value, available);
    if (availableMatch.kind === "single") return { ok: true, model: availableMatch.model };
    if (availableMatch.kind === "ambiguous") return { ok: false, reason: "ambiguous_model", detail: availableMatch.message };
  }

  const all = readAllModels(registry);
  const allMatch = matchModelReference(value, all);
  if (allMatch.kind === "single") {
    if (!available) return { ok: true, model: allMatch.model };
    return { ok: false, reason: "credentials_missing", detail: `${modelLabel(allMatch.model)} is not available to this Pi session; credentials may be missing or unauthorized` };
  }
  if (allMatch.kind === "ambiguous") return { ok: false, reason: "ambiguous_model", detail: allMatch.message };
  if (!available && registry?.getAvailable) return { ok: false, reason: "model_registry_unavailable", detail: "available model data could not be read from Pi" };
  return { ok: false, reason: "unknown_model", detail: `unknown model "${value}"` };
}

async function readAvailableModels(registry: ModelRegistryLike | undefined): Promise<Model<Api>[] | undefined> {
  const getAvailable = registry?.getAvailable;
  if (typeof getAvailable !== "function") return undefined;
  try {
    const available = await getAvailable.call(registry);
    return Array.isArray(available) ? (available as Model<Api>[]) : undefined;
  } catch {
    return undefined;
  }
}

function readAllModels(registry: ModelRegistryLike | undefined): Model<Api>[] {
  const getAll = registry?.getAll;
  if (typeof getAll !== "function") return [];
  try {
    const all = getAll.call(registry);
    return Array.isArray(all) ? (all as Model<Api>[]) : [];
  } catch {
    return [];
  }
}

function matchModelReference(value: string, models: Model<Api>[]): ModelReferenceMatch {
  const providerAndId = parseProviderAndModel(value);
  const matches = providerAndId
    ? models.filter((model) => model.provider === providerAndId.provider && model.id === providerAndId.modelId)
    : models.filter((model) => model.id === value || `${model.provider}/${model.id}` === value);

  if (matches.length === 1) return { kind: "single", model: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", message: `model id "${value}" is ambiguous; use provider/modelId` };
  return { kind: "none" };
}

function parseProviderAndModel(value: string): { provider: string; modelId: string } | undefined {
  const separator = value.includes("/") ? "/" : value.includes(":") ? ":" : undefined;
  if (!separator) return undefined;
  const [provider, ...rest] = value.split(separator);
  const modelId = rest.join(separator);
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

function resolveConfiguredThinking(requested: string): ConfiguredThinkingResolution {
  const level = requested.trim().toLowerCase();
  if (!THINKING_LEVELS.has(level)) {
    return { ok: false, reason: "unknown_thinking", detail: `unknown thinking level "${requested}"; expected one of ${THINKING_LEVEL_ORDER.join(", ")}` };
  }
  return { ok: true, level: level as ThinkingLevel };
}

async function applyThinkingFallback(pi: ExtensionAPI, ctx: ExtensionContext, supportedLevels: ThinkingLevel[] | undefined): Promise<ThinkingLevel | undefined> {
  const active = getActiveModelInfo(pi, ctx).thinking;
  if (!supportedLevels || supportedLevels.length === 0) return active;
  const fallback = active && supportedLevels.includes(active) ? active : supportedLevels[0];
  if (fallback !== active) {
    const setThinkingLevel = maybeSetThinkingLevel(pi);
    if (typeof setThinkingLevel === "function") setThinkingLevel.call(pi, fallback);
  }
  return fallback;
}

function supportedThinkingLevelsFor(model: Model<Api> | undefined): ThinkingLevel[] | undefined {
  if (!model) return undefined;
  if (model.reasoning === false) return [...NON_REASONING_THINKING_LEVELS];

  const map = thinkingLevelMapFor(model as unknown as Record<string, unknown>);
  if (map) {
    return THINKING_LEVEL_ORDER.filter((level) => {
      const mapped = map[level];
      if (mapped === null) return false;
      if (level === "xhigh") return mapped !== undefined;
      return true;
    });
  }

  return safelySupportsXhigh(model) ? [...THINKING_LEVEL_ORDER] : [...STANDARD_REASONING_THINKING_LEVELS];
}

function thinkingLevelMapFor(model: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isPlainObject(model.thinkingLevelMap)) return model.thinkingLevelMap;
  if (isPlainObject(model.reasoningEffortMap)) return model.reasoningEffortMap;
  const compat = model.compat;
  if (!isPlainObject(compat)) return undefined;
  if (isPlainObject(compat.thinkingLevelMap)) return compat.thinkingLevelMap;
  if (isPlainObject(compat.reasoningEffortMap)) return compat.reasoningEffortMap;
  return undefined;
}

function safelySupportsXhigh(model: Model<Api>): boolean {
  try {
    return getSupportedThinkingLevels(model).includes("xhigh");
  } catch {
    return false;
  }
}

function modelFallbackWarning(materiaName: string, requestedModel: string, detail: string, active: ActiveModelInfo): string {
  return `Materia "${materiaName}" configured model "${requestedModel}" is unavailable (${detail}); using the active Pi session model${activeModelLabelSuffix(active)}.`;
}

function thinkingFallbackWarning(materiaName: string, requestedThinking: string, detail: string, model: Model<Api> | undefined, fallback: ThinkingLevel | undefined): string {
  const modelText = model ? modelLabel(model) : "the active Pi session model";
  const fallbackText = fallback ? `; using ${fallback} instead` : "; using the active Pi thinking setting instead";
  return `Materia "${materiaName}" configured thinking "${requestedThinking}" is unsupported for ${modelText} (${detail})${fallbackText}.`;
}

function activeModelLabelSuffix(active: ActiveModelInfo): string {
  const label = activeModelLabel(active);
  return label ? ` (${label})` : "";
}

function activeModelLabel(active: ActiveModelInfo): string | undefined {
  const model = active.modelId ?? active.modelName;
  return [active.provider, model].filter(Boolean).join("/") || model || undefined;
}

function modelLabel(model: Model<Api>): string {
  return [model.provider, model.id].filter(Boolean).join("/") || model.name || "unknown model";
}

function normalizeOptionalSetting(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
