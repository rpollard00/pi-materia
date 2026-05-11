import { describe, expect, test } from 'vitest';
import { modelSelectOptions } from './webui/utils/modelCatalog.js';

describe('modelSelectOptions', () => {
  test('keeps Active Pi Model first before catalog-provided models', () => {
    const options = modelSelectOptions({
      ok: true,
      activeModel: null,
      activeModelValue: null,
      activeThinking: null,
      models: [
        { value: 'openai-codex/gpt-5.5', label: 'GPT 5.5 Codex', supportedThinkingLevels: ['off', 'high'] },
        { value: 'anthropic/claude-haiku-test', label: 'Claude Haiku Test', supportedThinkingLevels: ['off'] },
      ],
    }, undefined);

    expect(options).toEqual([
      { value: '', label: 'Active Pi Model' },
      { value: 'openai-codex/gpt-5.5', label: 'GPT 5.5 Codex' },
      { value: 'anthropic/claude-haiku-test', label: 'Claude Haiku Test' },
    ]);
  });

  test('preserves only the unavailable saved model for the current selection', () => {
    const catalog = {
      ok: true,
      activeModel: null,
      activeModelValue: null,
      activeThinking: null,
      models: [
        { value: 'openai-codex/gpt-5.5', label: 'GPT 5.5 Codex', supportedThinkingLevels: ['off', 'high'] },
      ],
    };

    expect(modelSelectOptions(catalog, {
      editingSocketId: 'agent-a',
      model: 'legacy-provider/legacy-model',
      thinking: 'high',
    })).toContainEqual({
      value: 'legacy-provider/legacy-model',
      label: 'legacy-provider/legacy-model (unavailable)',
      unavailable: true,
    });

    expect(modelSelectOptions(catalog, undefined)).not.toContainEqual(expect.objectContaining({
      value: 'legacy-provider/legacy-model',
    }));
  });
});
