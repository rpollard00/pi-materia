import type { AppliedMateriaModelSettings } from "../config/modelSettings.js";
import type { MateriaModelSelection } from "../types.js";

export function materiaModelSelection(applied: AppliedMateriaModelSettings): MateriaModelSelection {
  const model = applied.modelId ?? applied.modelName;
  const provider = applied.provider;
  const label = [provider, model].filter(Boolean).join("/") || model || "active Pi model";
  const thinking = applied.thinking ? String(applied.thinking) : undefined;
  const source = applied.modelFallbackReason ? "active" : applied.modelExplicit || applied.thinkingExplicit ? "configured" : "active";
  return {
    model,
    provider,
    api: applied.api,
    thinking,
    requestedModel: applied.requestedModel,
    requestedThinking: applied.requestedThinking,
    effectiveModel: label === "active Pi model" ? undefined : label,
    effectiveThinking: thinking,
    modelFallbackReason: applied.modelFallbackReason,
    thinkingFallbackReason: applied.thinkingFallbackReason,
    fallbackReason: applied.fallbackReason,
    modelExplicit: applied.modelExplicit,
    thinkingExplicit: applied.thinkingExplicit,
    source,
    label,
  };
}

export function formatModelSource(materiaModel: MateriaModelSelection | undefined): string {
  if (!materiaModel?.modelExplicit) return "active Pi model fallback";
  if (!materiaModel.modelFallbackReason) return "configured materia setting";
  const requested = materiaModel.requestedModel ? ` \"${materiaModel.requestedModel}\"` : "";
  return `active Pi model fallback (configured model${requested} unavailable: ${materiaModel.modelFallbackReason})`;
}

export function formatThinkingSource(materiaModel: MateriaModelSelection | undefined): string {
  if (!materiaModel?.thinkingExplicit) return "active Pi thinking fallback";
  if (!materiaModel.thinkingFallbackReason) return "configured materia setting";
  const requested = materiaModel.requestedThinking ? ` \"${materiaModel.requestedThinking}\"` : "";
  return `safe thinking fallback (configured thinking${requested} unsupported: ${materiaModel.thinkingFallbackReason})`;
}
