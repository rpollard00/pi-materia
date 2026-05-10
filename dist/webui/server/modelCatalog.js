import { errorMessage, isPlainObject } from './http.js';
const THINKING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const STANDARD_REASONING_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
const NON_REASONING_THINKING_LEVELS = ['off'];
export async function buildMateriaModelCatalog(source) {
    const warnings = [];
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
async function readCatalogActiveModel(source, warnings) {
    if (typeof source?.getActiveModel !== 'function')
        return null;
    try {
        const raw = await source.getActiveModel();
        if (raw === undefined || raw === null)
            return null;
        const model = normalizeCatalogModel(raw);
        if (!model)
            warnings.push('Active model data was unavailable or invalid.');
        return model ?? null;
    }
    catch (error) {
        warnings.push(`Unable to read active model: ${errorMessage(error)}`);
        return null;
    }
}
async function readCatalogActiveThinking(source, warnings) {
    if (typeof source?.getActiveThinking !== 'function')
        return null;
    try {
        const value = await source.getActiveThinking();
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }
    catch (error) {
        warnings.push(`Unable to read active thinking: ${errorMessage(error)}`);
        return null;
    }
}
async function readCatalogModels(source, warnings) {
    const modelRegistry = source?.modelRegistry;
    const getAvailable = modelRegistry?.getAvailable;
    if (typeof getAvailable !== 'function')
        return [];
    let available;
    try {
        available = await getAvailable.call(modelRegistry);
    }
    catch (error) {
        warnings.push(`Unable to read available models: ${errorMessage(error)}`);
        return [];
    }
    if (!Array.isArray(available)) {
        warnings.push('Model registry getAvailable() did not return an array.');
        return [];
    }
    const models = [];
    const seen = new Set();
    for (const [index, raw] of available.entries()) {
        let model;
        try {
            model = normalizeCatalogModel(raw);
        }
        catch (error) {
            warnings.push(`Skipped invalid model registry entry at index ${index}${catalogEntryHint(raw)}: ${errorMessage(error)}`);
            continue;
        }
        if (!model) {
            warnings.push(`Skipped invalid model registry entry at index ${index}${catalogEntryHint(raw)}.`);
            continue;
        }
        if (seen.has(model.value))
            continue;
        seen.add(model.value);
        models.push(model);
    }
    return models;
}
function normalizeCatalogModel(raw) {
    if (!isPlainObject(raw))
        return undefined;
    const provider = stringField(raw.provider);
    const id = stringField(raw.id);
    if (!provider || !id)
        return undefined;
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
function supportedThinkingLevelsFor(model, reasoning) {
    if (!reasoning)
        return [...NON_REASONING_THINKING_LEVELS];
    const map = thinkingLevelMapFor(model);
    if (map) {
        return THINKING_LEVEL_ORDER.filter((level) => {
            const mapped = map[level];
            if (mapped === null)
                return false;
            if (level === 'xhigh')
                return mapped !== undefined;
            return true;
        });
    }
    return locallySupportsXhigh(model) ? [...THINKING_LEVEL_ORDER] : [...STANDARD_REASONING_THINKING_LEVELS];
}
function locallySupportsXhigh(model) {
    const id = stringField(model.id)?.toLowerCase();
    if (!id)
        return false;
    return (id.includes('gpt-5.2') ||
        id.includes('gpt-5.3') ||
        id.includes('gpt-5.4') ||
        id.includes('gpt-5.5') ||
        id.includes('deepseek-v4-pro') ||
        id.includes('opus-4-6') ||
        id.includes('opus-4.6') ||
        id.includes('opus-4-7') ||
        id.includes('opus-4.7'));
}
function thinkingLevelMapFor(model) {
    if (isPlainObject(model.thinkingLevelMap))
        return model.thinkingLevelMap;
    if (isPlainObject(model.reasoningEffortMap))
        return model.reasoningEffortMap;
    const compat = model.compat;
    if (!isPlainObject(compat))
        return undefined;
    if (isPlainObject(compat.thinkingLevelMap))
        return compat.thinkingLevelMap;
    if (isPlainObject(compat.reasoningEffortMap))
        return compat.reasoningEffortMap;
    return undefined;
}
function modelLabel(value, name, id) {
    if (!name || name === id || name === value)
        return value;
    return `${name} (${value})`;
}
function catalogEntryHint(raw) {
    try {
        if (!isPlainObject(raw))
            return '';
        const provider = stringField(raw.provider);
        const id = stringField(raw.id);
        if (provider && id)
            return ` (${provider}/${id})`;
        if (provider)
            return ` (provider: ${provider})`;
        if (id)
            return ` (id: ${id})`;
    }
    catch {
        return '';
    }
    return '';
}
function stringField(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function stringArrayField(value) {
    if (!Array.isArray(value))
        return undefined;
    const strings = value.filter((item) => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim());
    return strings.length ? strings : undefined;
}
function positiveNumberField(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
