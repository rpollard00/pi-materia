import { describe, expect, it } from 'vitest';
import type { LoadoutSourceScope } from '../../types.js';
import type { MateriaSelectorItem } from './materiaEditPolicy.js';
import {
  buildCatalogSearchText,
  catalogOriginStatusLabel,
  catalogSourceLabel,
  filterMateriaCatalog,
  resolveCatalogMateriaType,
  selectMateriaCatalogRows,
  sortMateriaCatalog,
} from './materiaCatalogFiltering.js';

function item(overrides: Partial<MateriaSelectorItem> & Pick<MateriaSelectorItem, 'id' | 'label' | 'group' | 'type' | 'description'>): MateriaSelectorItem {
  return {
    source: undefined,
    isBuiltIn: false,
    isOverriddenBuiltIn: false,
    lockState: 'unlocked',
    saveScope: 'user',
    canSave: true,
    saveBlockedReason: null,
    canDelete: true,
    deleteTitle: `Delete ${overrides.id}`,
    canToggleLock: true,
    lockTitle: `Lock ${overrides.id}`,
    color: 'materia-color-slate',
    ...overrides,
  };
}

const items: MateriaSelectorItem[] = [
  item({ id: 'Build', label: 'Build', group: 'Core', type: 'agent', description: 'Builds the work items', source: 'default', isBuiltIn: true }),
  item({ id: 'AutoEval', label: 'Auto Eval', group: 'Core', type: 'agent', description: 'Evaluates satisfaction', source: 'default', isBuiltIn: true }),
  item({ id: 'detectVcs', label: 'Detect VCS', group: 'Utility', type: 'utility', description: 'Detects the vcs provider', source: 'user', lockState: 'locked' }),
  item({ id: 'ensureIgnored', label: 'Ensure Ignored', group: 'Utility', type: 'utility', description: 'Ensures ignore patterns', source: 'project', isBuiltIn: true, isOverriddenBuiltIn: true }),
  item({ id: 'zetaAgent', label: 'Zeta', group: 'Extras', type: 'agent', description: '', source: undefined }),
  item({ id: 'ghost', label: 'Ghost', group: '', type: 'unknown', description: 'Ungrouped materia', source: 'user' }),
];

const ids = (rows: MateriaSelectorItem[]) => rows.map((row) => row.id);

describe('resolveCatalogMateriaType', () => {
  it('classifies utility materia as utility and agent/unknown as agent, mirroring the palette default', () => {
    expect(resolveCatalogMateriaType(items[0])).toBe('agent'); // Build
    expect(resolveCatalogMateriaType(items[2])).toBe('utility'); // detectVcs
    expect(resolveCatalogMateriaType(items[5])).toBe('agent'); // ghost (unknown -> agent)
  });
});

describe('catalogSourceLabel and catalogOriginStatusLabel', () => {
  it('maps every origin scope to its visible label', () => {
    const scopes: Array<LoadoutSourceScope | undefined> = ['default', 'central', 'user', 'project', 'explicit', undefined];
    expect(scopes.map(catalogSourceLabel)).toEqual(['Built-in', 'Central', 'User', 'Project', 'Explicit', 'Unsaved']);
  });

  it('derives the origin status badge label from built-in/override flags', () => {
    expect(catalogOriginStatusLabel(items[0])).toBe('Built-in'); // Build
    expect(catalogOriginStatusLabel(items[3])).toBe('Customized'); // ensureIgnored override
    expect(catalogOriginStatusLabel(items[4])).toBe('Custom'); // zetaAgent
  });
});

describe('sortMateriaCatalog', () => {
  it('sorts by displayed label ascending with id as a deterministic tiebreaker', () => {
    expect(ids(sortMateriaCatalog(items, 'name', 'asc'))).toEqual([
      'AutoEval',
      'Build',
      'detectVcs',
      'ensureIgnored',
      'ghost',
      'zetaAgent',
    ]);
  });

  it('reverses for descending', () => {
    expect(ids(sortMateriaCatalog(items, 'name', 'desc'))).toEqual([
      'zetaAgent',
      'ghost',
      'ensureIgnored',
      'detectVcs',
      'Build',
      'AutoEval',
    ]);
  });

  it('groups agents before utilities when ascending by type, then by name', () => {
    expect(ids(sortMateriaCatalog(items, 'type', 'asc'))).toEqual([
      'AutoEval',
      'Build',
      'ghost',
      'zetaAgent',
      'detectVcs',
      'ensureIgnored',
    ]);
  });

  it('flips utilities before agents when descending by type', () => {
    expect(ids(sortMateriaCatalog(items, 'type', 'desc'))).toEqual([
      'ensureIgnored',
      'detectVcs',
      'zetaAgent',
      'ghost',
      'Build',
      'AutoEval',
    ]);
  });

  it('sorts by group with named groups first and ungrouped last when ascending', () => {
    expect(ids(sortMateriaCatalog(items, 'group', 'asc'))).toEqual([
      'AutoEval',
      'Build',
      'zetaAgent',
      'detectVcs',
      'ensureIgnored',
      'ghost',
    ]);
  });

  it('reverses group ordering (ungrouped first) when descending', () => {
    expect(ids(sortMateriaCatalog(items, 'group', 'desc'))).toEqual([
      'ghost',
      'ensureIgnored',
      'detectVcs',
      'zetaAgent',
      'Build',
      'AutoEval',
    ]);
  });

  it('tiebreaks equal labels by id ascending', () => {
    const tied: MateriaSelectorItem[] = [
      item({ id: 'beta', label: 'Same', group: '', type: 'agent', description: '' }),
      item({ id: 'alpha', label: 'Same', group: '', type: 'agent', description: '' }),
      item({ id: 'gamma', label: 'Same', group: '', type: 'agent', description: '' }),
    ];
    expect(ids(sortMateriaCatalog(tied, 'name', 'asc'))).toEqual(['alpha', 'beta', 'gamma']);
    expect(ids(sortMateriaCatalog(tied, 'name', 'desc'))).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('tiebreaks equal groups by name (then id)', () => {
    const tied: MateriaSelectorItem[] = [
      item({ id: 'zeta', label: 'Zeta', group: 'Core', type: 'agent', description: '' }),
      item({ id: 'alpha', label: 'Alpha', group: 'Core', type: 'agent', description: '' }),
    ];
    expect(ids(sortMateriaCatalog(tied, 'group', 'asc'))).toEqual(['alpha', 'zeta']);
  });

  it('orders two ungrouped rows by name when sorting by group', () => {
    const tied: MateriaSelectorItem[] = [
      item({ id: 'zeta', label: 'Zeta', group: '   ', type: 'agent', description: '' }),
      item({ id: 'alpha', label: 'Alpha', group: '', type: 'agent', description: '' }),
    ];
    expect(ids(sortMateriaCatalog(tied, 'group', 'asc'))).toEqual(['alpha', 'zeta']);
  });

  it('does not mutate the source array and returns the same item references', () => {
    const source = [...items];
    const result = sortMateriaCatalog(items, 'type', 'desc');
    expect(ids(items)).toEqual(ids(source)); // source order preserved
    expect(result.every((row) => items.includes(row))).toBe(true); // same references
  });
});

describe('filterMateriaCatalog and buildCatalogSearchText', () => {
  it('matches id, label, group, description, and agent/utility type (case-insensitive)', () => {
    expect(ids(filterMateriaCatalog(items, 'Build'))).toEqual(['Build']);
    expect(ids(filterMateriaCatalog(items, 'detect'))).toEqual(['detectVcs']);
    expect(ids(filterMateriaCatalog(items, 'utility'))).toEqual(['detectVcs', 'ensureIgnored']);
    expect(ids(filterMateriaCatalog(items, 'agent'))).toEqual(['Build', 'AutoEval', 'zetaAgent', 'ghost']);
    expect(ids(filterMateriaCatalog(items, 'core'))).toEqual(['Build', 'AutoEval']);
    expect(ids(filterMateriaCatalog(items, 'satisfaction'))).toEqual(['AutoEval']);
  });

  it('covers visible origin metadata: origin status, source scope, and locked state', () => {
    expect(ids(filterMateriaCatalog(items, 'built-in'))).toEqual(['Build', 'AutoEval']);
    expect(ids(filterMateriaCatalog(items, 'customized'))).toEqual(['ensureIgnored']);
    expect(ids(filterMateriaCatalog(items, 'project'))).toEqual(['ensureIgnored']);
    expect(ids(filterMateriaCatalog(items, 'user'))).toEqual(['detectVcs', 'ghost']);
    expect(ids(filterMateriaCatalog(items, 'unsaved'))).toEqual(['zetaAgent']);
    expect(ids(filterMateriaCatalog(items, 'locked'))).toEqual(['detectVcs']);
  });

  it('indexes ordinary and parallel generator capabilities', () => {
    const generators = [
      item({ id: 'Plan', label: 'Plan', group: '', type: 'agent', description: '', generator: true }),
      item({ id: 'ParallelPlan', label: 'Parallel Plan', group: '', type: 'agent', description: '', generator: true, parallel: true }),
    ];
    expect(ids(filterMateriaCatalog(generators, 'generator'))).toEqual(['Plan', 'ParallelPlan']);
    expect(ids(filterMateriaCatalog(generators, 'parallel generation'))).toEqual(['ParallelPlan']);
  });

  it('requires every whitespace-separated token to match (AND semantics)', () => {
    expect(ids(filterMateriaCatalog(items, 'utility core'))).toEqual([]);
    expect(ids(filterMateriaCatalog(items, 'detect vcs'))).toEqual(['detectVcs']);
  });

  it('returns all rows for an empty or whitespace-only query without filtering', () => {
    expect(filterMateriaCatalog(items, '')).toHaveLength(items.length);
    expect(filterMateriaCatalog(items, '   ')).toHaveLength(items.length);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterMateriaCatalog(items, 'nomatch')).toEqual([]);
  });

  it('exposes searchable text that lower-cases id, label, group, description, type, origin, source, and lock', () => {
    expect(buildCatalogSearchText(items[2])).toBe(
      'detectvcs detect vcs utility detects the vcs provider utility custom user locked',
    );
    expect(buildCatalogSearchText(items[5])).toBe('ghost ghost ungrouped materia agent custom user');
  });
});

// Catalog rows carry the provider/model label projected by
// buildMateriaSelectorItems (raw value for eligible agents, omitted for
// deterministic and model-less materia). These items mirror that projection so
// model-aware catalog search can be exercised in isolation, matching the
// palette's model search coverage.
describe('buildCatalogSearchText and filterMateriaCatalog model labels', () => {
  const modelItems: MateriaSelectorItem[] = [
    item({ id: 'Build', label: 'Build', group: 'Core', type: 'agent', description: 'Builds the work', modelLabel: 'zai/glm-4.6' }),
    item({ id: 'Audit', label: 'Audit', group: 'Core', type: 'agent', description: 'Audits the work', modelLabel: '  anthropic/claude-opus-4  ' }),
    item({ id: 'NoModel', label: 'No Model', group: 'Core', type: 'agent', description: 'No model here' }),
    item({ id: 'detectVcs', label: 'Detect VCS', group: 'Utility', type: 'utility', description: 'Detects the vcs provider' }),
  ];

  it('indexes the trimmed provider/model label for eligible agent materia (case-insensitive)', () => {
    expect(buildCatalogSearchText(modelItems[0])).toBe('build build core builds the work zai/glm-4.6 agent custom unsaved');
    // Surrounding whitespace is trimmed before the raw value is indexed.
    expect(buildCatalogSearchText(modelItems[1])).toBe('audit audit core audits the work anthropic/claude-opus-4 agent custom unsaved');
  });

  it('omits a model token when no agent model is projected', () => {
    expect(buildCatalogSearchText(modelItems[2])).toBe('nomodel no model core no model here agent custom unsaved');
  });

  it('omits the model token for deterministic utility materia', () => {
    expect(buildCatalogSearchText(modelItems[3])).toBe('detectvcs detect vcs utility detects the vcs provider utility custom unsaved');
  });

  it('matches provider fragments, model-name fragments, and the full provider/model value', () => {
    expect(ids(filterMateriaCatalog(modelItems, 'zai'))).toEqual(['Build']);
    expect(ids(filterMateriaCatalog(modelItems, 'glm'))).toEqual(['Build']);
    expect(ids(filterMateriaCatalog(modelItems, 'claude'))).toEqual(['Audit']);
    expect(ids(filterMateriaCatalog(modelItems, 'opus'))).toEqual(['Audit']);
    expect(ids(filterMateriaCatalog(modelItems, 'anthropic'))).toEqual(['Audit']);
    expect(ids(filterMateriaCatalog(modelItems, 'zai/glm-4.6'))).toEqual(['Build']);
  });

  it('combines a model fragment with another token via AND semantics', () => {
    expect(ids(filterMateriaCatalog(modelItems, 'zai build'))).toEqual(['Build']);
    expect(ids(filterMateriaCatalog(modelItems, 'anthropic audit'))).toEqual(['Audit']);
    // No entry combines the Audit provider with the Build id, so AND excludes all.
    expect(ids(filterMateriaCatalog(modelItems, 'anthropic build'))).toEqual([]);
  });

  it('never matches model-less or deterministic materia when searching by a model fragment', () => {
    expect(ids(filterMateriaCatalog(modelItems, 'glm'))).toEqual(['Build']);
    expect(ids(filterMateriaCatalog(modelItems, 'glm'))).not.toContain('NoModel');
    expect(ids(filterMateriaCatalog(modelItems, 'glm'))).not.toContain('detectVcs');
  });

  it('returns an empty list when no projected model matches', () => {
    expect(filterMateriaCatalog(modelItems, 'gpt')).toEqual([]);
  });

  it('restores every row when the query is cleared', () => {
    expect(filterMateriaCatalog(modelItems, '   ')).toHaveLength(modelItems.length);
    expect(filterMateriaCatalog(modelItems, '')).toHaveLength(modelItems.length);
  });
});

describe('selectMateriaCatalogRows', () => {
  it('combines filtering and sorting with name/asc defaults', () => {
    // Reverse the input so the default sort is proven to reorder by name, not by input.
    const reversed = [...items].reverse();
    const result = selectMateriaCatalogRows(reversed);
    expect(ids(result)).toEqual(['AutoEval', 'Build', 'detectVcs', 'ensureIgnored', 'ghost', 'zetaAgent']);
  });

  it('applies the requested sort mode and direction after filtering', () => {
    const result = selectMateriaCatalogRows(items, { query: 'utility', sortMode: 'name', direction: 'desc' });
    expect(ids(result)).toEqual(['ensureIgnored', 'detectVcs']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(selectMateriaCatalogRows(items, { query: 'nomatch' })).toEqual([]);
  });

  it('returns an empty list for an empty catalog', () => {
    expect(selectMateriaCatalogRows([], { query: 'anything' })).toEqual([]);
    expect(selectMateriaCatalogRows([])).toEqual([]);
  });

  it('does not mutate the source array', () => {
    const sourceOrder = ids(items);
    selectMateriaCatalogRows(items, { query: '', sortMode: 'type', direction: 'desc' });
    expect(ids(items)).toEqual(sourceOrder);
  });
});
