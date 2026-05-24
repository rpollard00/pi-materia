type MaybePromise<T> = T | Promise<T>;
type MateriaThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type MateriaModelRegistryLike = {
  getAvailable?: () => MaybePromise<unknown[]>;
};

export interface MateriaModelCatalogSource {
  modelRegistry?: MateriaModelRegistryLike | null;
  getActiveModel?: () => MaybePromise<unknown>;
  getActiveThinking?: () => MaybePromise<unknown>;
}

export interface MateriaModelCatalogModel {
  value: string;
  label: string;
  provider: string;
  id: string;
  name?: string;
  api?: string;
  reasoning: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  supportedThinkingLevels: MateriaThinkingLevel[];
}

export interface MateriaModelCatalogResponse {
  ok: true;
  activeModel: MateriaModelCatalogModel | null;
  activeModelValue: string | null;
  activeThinking: string | null;
  models: MateriaModelCatalogModel[];
  warnings?: string[];
}

const THINKING_LEVEL_ORDER: MateriaThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const STANDARD_REASONING_THINKING_LEVELS: MateriaThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];
const NON_REASONING_THINKING_LEVELS: MateriaThinkingLevel[] = ['off'];

export async function buildMateriaModelCatalog(source?: MateriaModelCatalogSource): Promise<MateriaModelCatalogResponse> {
  const warnings: string[] = [];
  const activeModel = await readCatalogActiveModel(source, warnings);
  const activeThinking = await readCatalogActiveThinking(source, warnings);
  const models = await readCatalogModels(source, warnings);

  return {
    ok: true,
    activeModel,
    activeModelValue: activeModel?.value ?? null,
    activeThinking,
    models,
    ...(warnings.length ? { warnings } : {}),
  };
}

async function readCatalogActiveModel(source: MateriaModelCatalogSource | undefined, warnings: string[]): Promise<MateriaModelCatalogModel | null> {
  if (typeof source?.getActiveModel !== 'function') return null;
  try {
    const raw = await source.getActiveModel();
    if (raw === undefined || raw === null) return null;
    const model = normalizeCatalogModel(raw);
    if (!model) warnings.push('Active model data was unavailable or invalid.');
    return model ?? null;
  } catch (error) {
    warnings.push(`Unable to read active model: ${errorMessage(error)}`);
    return null;
  }
}

async function readCatalogActiveThinking(source: MateriaModelCatalogSource | undefined, warnings: string[]): Promise<string | null> {
  if (typeof source?.getActiveThinking !== 'function') return null;
  try {
    const value = await source.getActiveThinking();
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch (error) {
    warnings.push(`Unable to read active thinking: ${errorMessage(error)}`);
    return null;
  }
}

async function readCatalogModels(source: MateriaModelCatalogSource | undefined, warnings: string[]): Promise<MateriaModelCatalogModel[]> {
  const modelRegistry = source?.modelRegistry;
  const getAvailable = modelRegistry?.getAvailable;
  if (typeof getAvailable !== 'function') return [];

  let available: unknown;
  try {
    available = await getAvailable.call(modelRegistry);
  } catch (error) {
    warnings.push(`Unable to read available models: ${errorMessage(error)}`);
    return [];
  }

  if (!Array.isArray(available)) {
    warnings.push('Model registry getAvailable() did not return an array.');
    return [];
  }

  const models: MateriaModelCatalogModel[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of available.entries()) {
    let model: MateriaModelCatalogModel | undefined;
    try {
      model = normalizeCatalogModel(raw);
    } catch (error) {
      warnings.push(`Skipped invalid model registry entry at index ${index}${catalogEntryHint(raw)}: ${errorMessage(error)}`);
      continue;
    }
    if (!model) {
      warnings.push(`Skipped invalid model registry entry at index ${index}${catalogEntryHint(raw)}.`);
      continue;
    }
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    models.push(model);
  }
  return models;
}

function normalizeCatalogModel(raw: unknown): MateriaModelCatalogModel | undefined {
  if (!isPlainObject(raw)) return undefined;
  const provider = stringField(raw.provider);
  const id = stringField(raw.id);
  if (!provider || !id) return undefined;

  const name = stringField(raw.name);
  const api = stringField(raw.api);
  const value = `${provider}/${id}`;
  const reasoning = typeof raw.reasoning === 'boolean' ? raw.reasoning : Boolean(thinkingLevelMapFor(raw));
  const input = stringArrayField(raw.input);
  const contextWindow = positiveNumberField(raw.contextWindow);
  const maxTokens = positiveNumberField(raw.maxTokens);

  return {
    value,
    label: modelLabel(value, name, id),
    provider,
    id,
    ...(name ? { name } : {}),
    ...(api ? { api } : {}),
    reasoning,
    ...(input ? { input } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    supportedThinkingLevels: supportedThinkingLevelsFor(raw, reasoning),
  };
}

function supportedThinkingLevelsFor(model: Record<string, unknown>, reasoning: boolean): MateriaThinkingLevel[] {
  if (!reasoning) return [...NON_REASONING_THINKING_LEVELS];

  const map = thinkingLevelMapFor(model);
  if (map) {
    return THINKING_LEVEL_ORDER.filter((level) => {
      const mapped = map[level];
      if (mapped === null) return false;
      if (level === 'xhigh') return mapped !== undefined;
      return true;
    });
  }

  return locallySupportsXhigh(model) ? [...THINKING_LEVEL_ORDER] : [...STANDARD_REASONING_THINKING_LEVELS];
}

function locallySupportsXhigh(model: Record<string, unknown>): boolean {
  const id = stringField(model.id)?.toLowerCase();
  if (!id) return false;

  return (
    id.includes('gpt-5.2') ||
    id.includes('gpt-5.3') ||
    id.includes('gpt-5.4') ||
    id.includes('gpt-5.5') ||
    id.includes('deepseek-v4-pro') ||
    id.includes('opus-4-6') ||
    id.includes('opus-4.6') ||
    id.includes('opus-4-7') ||
    id.includes('opus-4.7')
  );
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

function modelLabel(value: string, name: string | undefined, id: string): string {
  if (!name || name === id || name === value) return value;
  return `${name} (${value})`;
}

function catalogEntryHint(raw: unknown): string {
  try {
    if (!isPlainObject(raw)) return '';
    const provider = stringField(raw.provider);
    const id = stringField(raw.id);
    if (provider && id) return ` (${provider}/${id})`;
    if (provider) return ` (provider: ${provider})`;
    if (id) return ` (id: ${id})`;
  } catch {
    return '';
  }
  return '';
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim());
  return strings.length ? strings : undefined;
}

function positiveNumberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
