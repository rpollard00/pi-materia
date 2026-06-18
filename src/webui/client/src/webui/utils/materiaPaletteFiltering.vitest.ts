import { describe, expect, it } from 'vitest';
import type { MateriaBehaviorConfig } from '../../loadoutModel.js';
import {
  buildPaletteSearchText,
  filterMateriaPalette,
  resolvePaletteMateriaType,
  selectMateriaPaletteRows,
  sortMateriaPalette,
  type MateriaPaletteEntry,
} from './materiaPaletteFiltering.js';

type Materia = Record<string, MateriaBehaviorConfig>;

const materia: Materia = {
  Build: { prompt: 'build', group: 'Core', description: 'Builds the work items' },
  AutoEval: { prompt: 'eval', group: 'Core', description: 'Evaluates satisfaction' },
  detectVcs: { type: 'utility', utility: 'vcs.detect', label: 'Detect VCS', group: 'Utility', description: 'Detects the vcs provider', parse: 'json', assign: { vcs: '$' } },
  ensureIgnored: { type: 'utility', utility: 'project.ensureIgnored', label: 'Ensure Ignored', group: 'Utility', description: 'Ensures ignore patterns' },
  planner: { prompt: 'plan', generator: true, description: 'Produces the canonical workItems list' },
  watcher: { prompt: 'watch', foreach: { items: 'state.events', as: 'event', done: 'end' }, description: 'Iterates over events' },
  zetaAgent: { prompt: 'z', group: 'Extras' },
};

function entriesOf(definitions: Materia): MateriaPaletteEntry[] {
  return Object.keys(definitions).map((id, index) => ({ id, socket: { materia: id }, index }));
}

const ids = (rows: MateriaPaletteEntry[]) => rows.map((row) => row.id);

describe('resolvePaletteMateriaType', () => {
  it('classifies utility materia via type, utility, command, or script', () => {
    expect(resolvePaletteMateriaType(materia.Build)).toBe('agent');
    expect(resolvePaletteMateriaType(materia.detectVcs)).toBe('utility');
    expect(resolvePaletteMateriaType({ type: 'utility', prompt: 'x' })).toBe('utility');
    expect(resolvePaletteMateriaType({ command: ['echo'] })).toBe('utility');
    expect(resolvePaletteMateriaType({ script: 'x.js' })).toBe('utility');
    expect(resolvePaletteMateriaType(undefined)).toBe('agent');
  });
});

describe('sortMateriaPalette', () => {
  it('sorts by label ascending by default and tiebreaks by id', () => {
    const rows = entriesOf({ zed: { prompt: 'a' }, alpha: { prompt: 'b' }, beta: { prompt: 'c' } });
    expect(ids(sortMateriaPalette(rows, { zed: {}, alpha: {}, beta: {} }, 'name', 'asc'))).toEqual(['alpha', 'beta', 'zed']);
  });

  it('reverses for descending', () => {
    const rows = entriesOf({ zed: { prompt: 'a' }, alpha: { prompt: 'b' }, beta: { prompt: 'c' } });
    expect(ids(sortMateriaPalette(rows, { zed: {}, alpha: {}, beta: {} }, 'name', 'desc'))).toEqual(['zed', 'beta', 'alpha']);
  });

  it('groups agents before utilities when ascending by type, then by name', () => {
    expect(ids(sortMateriaPalette(entriesOf(materia), materia, 'type', 'asc'))).toEqual([
      'AutoEval',
      'Build',
      'planner',
      'watcher',
      'zetaAgent',
      'detectVcs',
      'ensureIgnored',
    ]);
  });

  it('flips utilities before agents when descending by type', () => {
    expect(ids(sortMateriaPalette(entriesOf(materia), materia, 'type', 'desc'))).toEqual([
      'ensureIgnored',
      'detectVcs',
      'zetaAgent',
      'watcher',
      'planner',
      'Build',
      'AutoEval',
    ]);
  });

  it('sorts by group with named groups first and ungrouped last when ascending', () => {
    expect(ids(sortMateriaPalette(entriesOf(materia), materia, 'group', 'asc'))).toEqual([
      'AutoEval',
      'Build',
      'zetaAgent',
      'detectVcs',
      'ensureIgnored',
      'planner',
      'watcher',
    ]);
  });

  it('reverses group ordering (ungrouped first) when descending', () => {
    expect(ids(sortMateriaPalette(entriesOf(materia), materia, 'group', 'desc'))).toEqual([
      'watcher',
      'planner',
      'ensureIgnored',
      'detectVcs',
      'zetaAgent',
      'Build',
      'AutoEval',
    ]);
  });

  it('preserves the original palette index so fallback colors stay stable', () => {
    const rows = entriesOf(materia);
    const sorted = sortMateriaPalette(rows, materia, 'type', 'desc');
    for (const row of sorted) {
      expect(row.index).toBe(rows.find((original) => original.id === row.id)?.index);
    }
  });
});

describe('filterMateriaPalette and buildPaletteSearchText', () => {
  it('matches id, label, group, description, type, generator, and iterator tags (case-insensitive)', () => {
    const rows = entriesOf(materia);

    expect(ids(filterMateriaPalette(rows, materia, 'Build'))).toEqual(['Build']);
    expect(ids(filterMateriaPalette(rows, materia, 'detect'))).toEqual(['detectVcs']);
    expect(ids(filterMateriaPalette(rows, materia, 'utility'))).toEqual(['detectVcs', 'ensureIgnored']);
    expect(ids(filterMateriaPalette(rows, materia, 'agent'))).toEqual(['Build', 'AutoEval', 'planner', 'watcher', 'zetaAgent']);
    expect(ids(filterMateriaPalette(rows, materia, 'generator'))).toEqual(['planner']);
    expect(ids(filterMateriaPalette(rows, materia, 'iterator'))).toEqual(['planner', 'watcher']);
    expect(ids(filterMateriaPalette(rows, materia, 'core'))).toEqual(['Build', 'AutoEval']);
    expect(ids(filterMateriaPalette(rows, materia, 'satisfaction'))).toEqual(['AutoEval']);
  });

  it('requires every whitespace-separated token to match (AND semantics)', () => {
    const rows = entriesOf(materia);
    expect(ids(filterMateriaPalette(rows, materia, 'utility core'))).toEqual([]);
    expect(ids(filterMateriaPalette(rows, materia, 'detect vcs'))).toEqual(['detectVcs']);
  });

  it('returns all entries for an empty query', () => {
    const rows = entriesOf(materia);
    expect(filterMateriaPalette(rows, materia, '   ')).toHaveLength(rows.length);
  });

  it('exposes searchable text that lower-cases all matched fields', () => {
    expect(buildPaletteSearchText('detectVcs', { materia: 'detectVcs' }, materia)).toBe('detectvcs detect vcs utility detects the vcs provider utility');
  });
});

describe('selectMateriaPaletteRows', () => {
  it('combines filtering and sorting with name/asc defaults', () => {
    const palette: Array<[string, MateriaPaletteEntry['socket']]> = Object.keys(materia).map((id, index) => [id, { materia: id }] as [string, MateriaPaletteEntry['socket']]);
    // Reverse the palette tuple order so we can prove the default sort reorders by name, not by input.
    const reversed = [...palette].reverse();

    const result = selectMateriaPaletteRows(reversed, { materia });
    expect(ids(result)).toEqual(['AutoEval', 'Build', 'detectVcs', 'ensureIgnored', 'planner', 'watcher', 'zetaAgent']);
    for (const row of result) {
      expect(row.index).toBe(reversed.findIndex(([id]) => id === row.id));
    }
  });

  it('returns an empty list when nothing matches', () => {
    const palette: Array<[string, MateriaPaletteEntry['socket']]> = [['Build', { materia: 'Build' }]];
    expect(selectMateriaPaletteRows(palette, { materia, query: 'nomatch' })).toEqual([]);
  });
});
