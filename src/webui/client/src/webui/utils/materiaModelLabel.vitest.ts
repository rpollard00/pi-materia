import { describe, expect, it } from 'vitest';
import type { MateriaBehaviorConfig } from '../../loadoutModel.js';
import { isDeterministicMateria, resolveMateriaModelLabel } from './materiaModelLabel.js';

describe('resolveMateriaModelLabel', () => {
  it('returns the trimmed configured model for agent materia', () => {
    expect(resolveMateriaModelLabel({ prompt: 'build', model: 'zai/glm-4.6' })).toBe('zai/glm-4.6');
    expect(resolveMateriaModelLabel({ type: 'agent', model: '  anthropic/claude-opus-4  ' })).toBe('anthropic/claude-opus-4');
  });

  it('returns the raw configured value even when the model is unavailable in any catalog', () => {
    // The helper has no catalog dependency, so an unrecognized/private model is
    // surfaced verbatim rather than swapped for a friendly name or suppressed.
    expect(resolveMateriaModelLabel({ prompt: 'build', model: 'private-internal/model-x' })).toBe('private-internal/model-x');
  });

  it('suppresses blank model selections', () => {
    expect(resolveMateriaModelLabel({ prompt: 'build', model: '' })).toBeUndefined();
    expect(resolveMateriaModelLabel({ prompt: 'build', model: '   ' })).toBeUndefined();
  });

  it('suppresses missing model selections without substituting an active model', () => {
    expect(resolveMateriaModelLabel({ prompt: 'build' })).toBeUndefined();
    expect(resolveMateriaModelLabel({ type: 'agent', prompt: 'build' })).toBeUndefined();
  });

  it('treats legacy agent definitions (no explicit type) as agents when a model is configured', () => {
    expect(resolveMateriaModelLabel({ prompt: 'build', model: 'zai/glm-4.6' })).toBe('zai/glm-4.6');
    // Legacy agent without a model still yields no label.
    expect(resolveMateriaModelLabel({ prompt: 'build' })).toBeUndefined();
  });

  it('returns undefined for deterministic utility-typed materia even when a model is configured', () => {
    expect(resolveMateriaModelLabel({ type: 'utility', utility: 'vcs.detect', model: 'zai/glm-4.6' })).toBeUndefined();
    expect(resolveMateriaModelLabel({ type: 'utility', model: 'zai/glm-4.6' })).toBeUndefined();
    expect(resolveMateriaModelLabel({ type: 'utility' })).toBeUndefined();
  });

  it('returns undefined for materia identified by utility, command, or script', () => {
    expect(resolveMateriaModelLabel({ utility: 'shell.run', model: 'zai/glm-4.6' })).toBeUndefined();
    expect(resolveMateriaModelLabel({ command: ['echo', 'hi'], model: 'zai/glm-4.6' })).toBeUndefined();
    expect(resolveMateriaModelLabel({ script: 'tools/x.mjs', model: 'zai/glm-4.6' })).toBeUndefined();
    // Deterministic detection wins over an agent-typed definition.
    expect(resolveMateriaModelLabel({ type: 'agent', command: ['echo'], model: 'zai/glm-4.6' })).toBeUndefined();
  });

  it('returns undefined for missing or non-string model values', () => {
    expect(resolveMateriaModelLabel(undefined)).toBeUndefined();
    expect(resolveMateriaModelLabel({ prompt: 'build', model: null as unknown as string })).toBeUndefined();
    expect(resolveMateriaModelLabel({ prompt: 'build', model: 42 as unknown as string })).toBeUndefined();
  });

  it('never substitutes a model-catalog friendly name (returns the configured value only)', () => {
    // The raw provider/model string is the result; no friendly-name lookup is
    // performed even for values a catalog might otherwise label "GLM 4.6".
    expect(resolveMateriaModelLabel({ model: 'zai/glm-4.6' })).toBe('zai/glm-4.6');
  });
});

describe('isDeterministicMateria', () => {
  it('classifies utility-typed and utility/command/script definitions as deterministic', () => {
    expect(isDeterministicMateria({ type: 'utility' })).toBe(true);
    expect(isDeterministicMateria({ utility: 'shell.run' })).toBe(true);
    expect(isDeterministicMateria({ command: ['echo'] })).toBe(true);
    expect(isDeterministicMateria({ script: 'tools/x.mjs' })).toBe(true);
  });

  it('classifies agent and legacy definitions as non-deterministic', () => {
    expect(isDeterministicMateria({ type: 'agent' })).toBe(false);
    expect(isDeterministicMateria({ prompt: 'build' })).toBe(false);
  });

  it('returns false for missing definitions', () => {
    expect(isDeterministicMateria(undefined)).toBe(false);
  });
});
