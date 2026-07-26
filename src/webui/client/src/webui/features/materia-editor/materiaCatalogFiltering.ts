import type { LoadoutSourceScope } from '../../types.js';
import type { PaletteSortDirection, PaletteSortMode } from '../../utils/materiaPaletteFiltering.js';
import type { MateriaSelectorItem } from './materiaEditPolicy.js';

export interface SelectMateriaCatalogRowsOptions {
  query?: string;
  sortMode?: PaletteSortMode;
  direction?: PaletteSortDirection;
}

/**
 * Mirrors the materia palette's agent/utility classification for catalog rows.
 * The palette derives this from the raw materia definition; the catalog selector
 * operates on already-built {@link MateriaSelectorItem} data, so the catalog's
 * `'unknown'` type bucket (materia without an explicit agent/utility type) maps
 * to agent, matching the palette's default-to-agent classification.
 */
export function resolveCatalogMateriaType(item: MateriaSelectorItem): 'agent' | 'utility' {
  return item.type === 'utility' ? 'utility' : 'agent';
}

function catalogTypeRank(item: MateriaSelectorItem): number {
  return resolveCatalogMateriaType(item) === 'agent' ? 0 : 1;
}

function readCatalogGroup(item: MateriaSelectorItem): string {
  return item.group.trim();
}

/**
 * Human-readable label for a materia's origin scope, mirroring the badge/title
 * text rendered by the materia selector sidebar so search hits match what users
 * see. Co-located with the catalog selector so origin metadata stays indexed
 * consistently; the sidebar can adopt this helper in a follow-up.
 */
export function catalogSourceLabel(source: LoadoutSourceScope | undefined): string {
  switch (source) {
    case 'default':
      return 'Built-in';
    case 'central':
      return 'Central';
    case 'user':
      return 'User';
    case 'project':
      return 'Project';
    case 'explicit':
      return 'Explicit';
    default:
      return 'Unsaved';
  }
}

/**
 * Origin status badge label (Customized / Built-in / Custom), mirroring the
 * materia selector sidebar so search covers the visible origin metadata.
 */
export function catalogOriginStatusLabel(item: MateriaSelectorItem): string {
  if (item.isOverriddenBuiltIn) return 'Customized';
  if (item.isBuiltIn) return 'Built-in';
  return 'Custom';
}

/**
 * Assembles the lowercase searchable text for a catalog row. Covers id, the
 * displayed label, group, description, the projected provider/model label, the
 * agent/utility type, and the visible origin/lock metadata (origin status
 * badge, source scope label, and locked state). The model label is normalized
 * (trimmed and lower-cased) from the value projected by
 * {@link resolveMateriaModelLabel} so catalog search stays in lockstep with the
 * visible model chrome; deterministic utility materia and model-less agents
 * project no label and therefore contribute no token. Unlocked rows add no
 * lock token since the sidebar only badges locks.
 */
export function buildCatalogSearchText(item: MateriaSelectorItem): string {
  const parts: string[] = [item.id.toLowerCase(), item.label.toLowerCase()];
  const group = readCatalogGroup(item);
  if (group) parts.push(group.toLowerCase());
  if (item.description) parts.push(item.description.toLowerCase());
  const modelLabel = item.modelLabel?.trim();
  if (modelLabel) parts.push(modelLabel.toLowerCase());
  parts.push(resolveCatalogMateriaType(item));
  parts.push(catalogOriginStatusLabel(item).toLowerCase());
  parts.push(catalogSourceLabel(item.source).toLowerCase());
  if (item.lockState === 'locked') parts.push('locked');
  return parts.join(' ');
}

/**
 * Filters catalog rows by a trimmed, case-insensitive query with AND semantics:
 * every whitespace-separated token must appear somewhere in the row's searchable
 * text. An empty query returns the source rows untouched.
 */
export function filterMateriaCatalog(items: MateriaSelectorItem[], query: string): MateriaSelectorItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  const tokens = normalized.split(/\s+/);
  return items.filter((item) => {
    const text = buildCatalogSearchText(item);
    return tokens.every((token) => text.includes(token));
  });
}

function compareName(a: MateriaSelectorItem, b: MateriaSelectorItem): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function compareType(a: MateriaSelectorItem, b: MateriaSelectorItem): number {
  const rankDiff = catalogTypeRank(a) - catalogTypeRank(b);
  return rankDiff !== 0 ? rankDiff : compareName(a, b);
}

function compareGroup(a: MateriaSelectorItem, b: MateriaSelectorItem): number {
  const aGroup = readCatalogGroup(a);
  const bGroup = readCatalogGroup(b);
  if (!aGroup && !bGroup) return compareName(a, b);
  // Ungrouped materia sorts after named groups in ascending order.
  if (!aGroup) return 1;
  if (!bGroup) return -1;
  const groupDiff = aGroup.localeCompare(bGroup);
  return groupDiff !== 0 ? groupDiff : compareName(a, b);
}

/**
 * Sorts a copy of the catalog rows. Name uses the displayed label with id as a
 * deterministic tiebreaker; type uses the palette's agent-before-utility
 * classification; group places ungrouped entries last when ascending. The source
 * array is never mutated.
 */
export function sortMateriaCatalog(
  items: MateriaSelectorItem[],
  sortMode: PaletteSortMode,
  direction: PaletteSortDirection,
): MateriaSelectorItem[] {
  const comparator = sortMode === 'type' ? compareType : sortMode === 'group' ? compareGroup : compareName;
  const sorted = [...items].sort((a, b) => comparator(a, b));
  return direction === 'asc' ? sorted : sorted.reverse();
}

/**
 * Single entry point for catalog filtering and sorting. Mirrors
 * {@link selectMateriaPaletteRows} so the materia catalog shares the palette's
 * Name/Type/Group sort modes and asc/desc direction semantics. Defaults to Name
 * ascending and never mutates the source array; returned rows are the same item
 * references, only filtered and reordered.
 */
export function selectMateriaCatalogRows(
  items: MateriaSelectorItem[],
  options: SelectMateriaCatalogRowsOptions = {},
): MateriaSelectorItem[] {
  const { query = '', sortMode = 'name', direction = 'asc' } = options;
  return sortMateriaCatalog(filterMateriaCatalog(items, query), sortMode, direction);
}
