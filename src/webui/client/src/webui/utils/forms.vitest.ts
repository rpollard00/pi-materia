import { describe, expect, it } from 'vitest';
import { buildMateriaPatch, emptyMateriaForm } from './forms.js';

describe('materia editor form serialization', () => {
  it('serializes utility materia identity, appearance, execution, assign, and generator fields', () => {
    const form = {
      ...emptyMateriaForm(),
      name: 'detectVcs',
      behavior: 'tool' as const,
      label: 'Detect VCS',
      description: 'Detect repository VCS.',
      group: 'Utility',
      color: 'materia-color-cyan',
      command: 'node config/utilities/detect-vcs.mjs',
      params: '{"root":"."}',
      assign: '{"vcs":"$"}',
      outputFormat: 'json' as const,
      generator: true,
      parallel: true,
      timeoutMs: '5000',
    };

    expect(buildMateriaPatch(form)).toEqual({
      materia: {
        detectVcs: {
          type: 'utility',
          label: 'Detect VCS',
          description: 'Detect repository VCS.',
          group: 'Utility',
          utility: undefined,
          command: ['node', 'config/utilities/detect-vcs.mjs'],
          params: { root: '.' },
          assign: { vcs: '$' },
          timeoutMs: 5000,
          parse: 'json',
          generator: true,
          parallel: true,
          color: 'materia-color-cyan',
        },
      },
    });
  });

  it('persists only canonical parallel metadata and clears it with generator on edits', () => {
    const created = buildMateriaPatch({
      ...emptyMateriaForm(),
      name: 'Planner',
      prompt: 'Plan.',
      generator: true,
      parallel: true,
    });
    expect(created.materia?.Planner).toMatchObject({ generator: true, parallel: true });
    expect(created.materia?.Planner).not.toHaveProperty('parallelPlanner');

    const cleared = buildMateriaPatch({
      ...emptyMateriaForm(),
      editingSocketId: 'Planner',
      name: 'Planner',
      prompt: 'Plan.',
      generator: false,
      parallel: true,
    });
    expect(cleared.materia?.Planner).toMatchObject({ generator: null, parallel: null });
  });
});
