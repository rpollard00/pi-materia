import { activeModelOptionLabel, activeThinkingOptionLabel, thinkingLevelLabels } from '../constants.js';
import type { MateriaFormState, ModelCatalogModel, ModelCatalogResponse, OriginalMateriaModelSettings, SelectOption } from '../types.js';

export function emptyModelCatalog(): ModelCatalogResponse {
  return { ok: true, activeModel: null, activeModelValue: null, activeThinking: null, models: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeThinkingLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const levels: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const level = stringField(item);
    if (!level || seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  return levels;
}

export function normalizeModelCatalogModel(value: unknown): ModelCatalogModel | undefined {
  if (!isRecord(value)) return undefined;
  const modelValue = stringField(value.value);
  if (!modelValue) return undefined;
  const label = stringField(value.label) ?? modelValue;
  const provider = stringField(value.provider);
  const id = stringField(value.id);
  return {
    value: modelValue,
    label,
    ...(provider ? { provider } : {}),
    ...(id ? { id } : {}),
    supportedThinkingLevels: normalizeThinkingLevels(value.supportedThinkingLevels),
  };
}

export function normalizeModelCatalog(value: unknown): ModelCatalogResponse {
  if (!isRecord(value)) return emptyModelCatalog();
  const models = Array.isArray(value.models) ? uniqueCatalogModels(value.models.map(normalizeModelCatalogModel).filter((model): model is ModelCatalogModel => Boolean(model))) : [];
  const activeModel = normalizeModelCatalogModel(value.activeModel) ?? null;
  const activeModelValue = stringField(value.activeModelValue) ?? activeModel?.value ?? null;
  const activeThinking = stringField(value.activeThinking) ?? null;
  const warnings = Array.isArray(value.warnings) ? value.warnings.map(stringField).filter((warning): warning is string => Boolean(warning)) : [];
  return {
    ok: value.ok !== false,
    activeModel,
    activeModelValue,
    activeThinking,
    models,
    ...(warnings.length ? { warnings } : {}),
  };
}

function uniqueCatalogModels(models: ModelCatalogModel[]): ModelCatalogModel[] {
  const seen = new Set<string>();
  const unique: ModelCatalogModel[] = [];
  for (const model of models) {
    if (!model.value || seen.has(model.value)) continue;
    seen.add(model.value);
    unique.push(model);
  }
  return unique;
}

function findCatalogModel(catalog: ModelCatalogResponse, modelValue: string): ModelCatalogModel | undefined {
  return catalog.models.find((model) => model.value === modelValue);
}

export function selectedCatalogModel(catalog: ModelCatalogResponse, modelValue: string): ModelCatalogModel | undefined {
  const selectedValue = modelValue.trim();
  if (selectedValue) return findCatalogModel(catalog, selectedValue);
  return catalog.activeModel ?? (catalog.activeModelValue ? findCatalogModel(catalog, catalog.activeModelValue) : undefined);
}

function supportedThinkingLevelsForSelection(catalog: ModelCatalogResponse, modelValue: string): string[] {
  return selectedCatalogModel(catalog, modelValue)?.supportedThinkingLevels ?? [];
}

export function thinkingLabel(level: string): string {
  return thinkingLevelLabels[level] ?? level;
}

function isOriginalSavedThinking(form: Pick<MateriaFormState, 'editingSocketId'>, original: OriginalMateriaModelSettings | undefined, modelValue: string, thinkingValue: string): boolean {
  return Boolean(original && form.editingSocketId === original.editingSocketId && modelValue.trim() === original.model && thinkingValue.trim() === original.thinking && original.thinking);
}

export function canKeepThinkingForModel(catalog: ModelCatalogResponse, modelValue: string, thinkingValue: string, form: Pick<MateriaFormState, 'editingSocketId'>, original: OriginalMateriaModelSettings | undefined): boolean {
  const normalizedThinking = thinkingValue.trim();
  if (!normalizedThinking) return true;
  const supported = supportedThinkingLevelsForSelection(catalog, modelValue);
  if (supported.includes(normalizedThinking)) return true;
  return isOriginalSavedThinking(form, original, modelValue, normalizedThinking);
}

export function modelSelectOptions(catalog: ModelCatalogResponse, original: OriginalMateriaModelSettings | undefined): SelectOption[] {
  const models = uniqueCatalogModels(catalog.models);
  const options: SelectOption[] = [{ value: '', label: activeModelOptionLabel }, ...models.map((model) => ({ value: model.value, label: model.label }))];
  const originalModel = original?.model.trim();
  if (originalModel && !models.some((model) => model.value === originalModel)) {
    options.push({ value: originalModel, label: `${originalModel} (unavailable)`, unavailable: true });
  }
  return options;
}

export function thinkingSelectOptions(catalog: ModelCatalogResponse, form: Pick<MateriaFormState, 'editingSocketId' | 'model' | 'thinking'>, original: OriginalMateriaModelSettings | undefined): SelectOption[] {
  const supported = supportedThinkingLevelsForSelection(catalog, form.model);
  const options: SelectOption[] = [
    { value: '', label: activeThinkingOptionLabel },
    ...supported.map((level) => ({ value: level, label: thinkingLabel(level) })),
  ];
  const currentThinking = form.thinking.trim();
  if (currentThinking && !supported.includes(currentThinking) && isOriginalSavedThinking(form, original, form.model, currentThinking)) {
    options.push({ value: currentThinking, label: `${currentThinking} (unsupported saved value)`, unavailable: true });
  }
  return options;
}
