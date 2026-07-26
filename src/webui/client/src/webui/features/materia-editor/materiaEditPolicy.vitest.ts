import { describe, expect, it } from 'vitest';
import type { LoadoutSourceScope } from '../../types.js';
import type { MateriaBehaviorConfig } from '../../../loadoutModel.js';
import { buildMateriaSelectorItems, type MateriaSelectorItem } from './materiaEditPolicy.js';

type Materia = Record<string, MateriaBehaviorConfig>;

function build(materia: Materia, sources: Record<string, LoadoutSourceScope> = {}, defaults: string[] = []): Record<string, MateriaSelectorItem> {
  const byId: Record<string, MateriaSelectorItem> = {};
  for (const item of buildMateriaSelectorItems(materia, sources, defaults)) byId[item.id] = item;
  return byId;
}

describe('buildMateriaSelectorItems modelLabel projection', () => {
  it('projects the raw configured provider/model value for eligible agent materia', () => {
    const items = build({
      Build: { prompt: 'build', model: 'zai/glm-4.6' },
      Audit: { prompt: 'audit', model: '  anthropic/claude-opus-4  ' },
    });

    // The exact configured value is used verbatim, never a friendly catalog
    // name, and surrounding whitespace is trimmed.
    expect(items.Build.modelLabel).toBe('zai/glm-4.6');
    expect(items.Audit.modelLabel).toBe('anthropic/claude-opus-4');
  });

  it('keeps provider-dense labels distinguishable across providers for the same model', () => {
    const items = build({
      ViaAnthropic: { prompt: 'p', model: 'anthropic/claude-opus-4' },
      ViaProxy: { prompt: 'p', model: 'openrouter/anthropic/claude-opus-4' },
    });

    expect(items.ViaAnthropic.modelLabel).toBe('anthropic/claude-opus-4');
    expect(items.ViaProxy.modelLabel).toBe('openrouter/anthropic/claude-opus-4');
  });

  it('suppresses the label for agent materia without a selected model', () => {
    const items = build({
      NoModel: { prompt: 'no model here' },
      EmptyModel: { prompt: 'empty model', model: '' },
      WhitespaceModel: { prompt: 'blank model', model: '   ' },
    });

    expect(items.NoModel.modelLabel).toBeUndefined();
    expect(items.EmptyModel.modelLabel).toBeUndefined();
    expect(items.WhitespaceModel.modelLabel).toBeUndefined();
  });

  it('suppresses the label for utility-typed materia even when a model is configured', () => {
    const items = build({
      detectVcs: { type: 'utility', utility: 'vcs.detect', model: 'zai/glm-4.6', label: 'Detect VCS' },
      plainUtility: { type: 'utility', model: 'zai/glm-4.6' },
    });

    expect(items.detectVcs.modelLabel).toBeUndefined();
    expect(items.plainUtility.modelLabel).toBeUndefined();
  });

  it('suppresses the label for command/script deterministic definitions', () => {
    const items = build({
      runShell: { command: ['echo', 'hi'], model: 'zai/glm-4.6' },
      runScript: { script: 'tools/x.mjs', model: 'zai/glm-4.6' },
      // An agent-typed definition still counts as deterministic when it carries
      // a command/script, so it stays unlabeled.
      agentWithCommand: { type: 'agent', command: ['echo'], model: 'zai/glm-4.6' },
    });

    expect(items.runShell.modelLabel).toBeUndefined();
    expect(items.runScript.modelLabel).toBeUndefined();
    expect(items.agentWithCommand.modelLabel).toBeUndefined();
  });

  it('coerces non-string model values to no label rather than rendering them', () => {
    const items = build({
      badModel: { prompt: 'p', model: 42 as unknown as string },
      nullModel: { prompt: 'p', model: null as unknown as string },
    });

    expect(items.badModel.modelLabel).toBeUndefined();
    expect(items.nullModel.modelLabel).toBeUndefined();
  });

  it('does not project an inherited active-session model or substitute a default', () => {
    // The projection only surfaces an explicitly configured model; a materia
    // with no model field never receives a label even alongside configured
    // peers, so the active-session model cannot leak into catalog chrome.
    const items = build({
      Configured: { prompt: 'p', model: 'zai/glm-4.6' },
      Inherits: { prompt: 'p' },
    });

    expect(items.Configured.modelLabel).toBe('zai/glm-4.6');
    expect(items.Inherits.modelLabel).toBeUndefined();
  });

  it('preserves the rest of the selector item shape alongside the projected label', () => {
    const items = build({ Build: { type: 'agent', prompt: 'build', model: 'zai/glm-4.6', label: 'Build label', group: 'Core', description: 'Builds the work' } }, { Build: 'user' });

    const buildItem = items.Build;
    expect(buildItem.label).toBe('Build label');
    expect(buildItem.group).toBe('Core');
    expect(buildItem.type).toBe('agent');
    expect(buildItem.description).toBe('Builds the work');
    expect(buildItem.color).toBeTruthy();
    expect(buildItem.modelLabel).toBe('zai/glm-4.6');
  });
});
