import { getSocketLabel, type MateriaBehaviorConfig, type MateriaConfig, type PipelineSocket } from '../../loadoutModel.js';
import { hasIteratorBehavior, isGeneratorSocket } from './graphLayout.js';

export type PaletteSortMode = 'name' | 'type' | 'group';
export type PaletteSortDirection = 'asc' | 'desc';

export interface MateriaPaletteEntry {
  id: string;
  socket: PipelineSocket;
  /**
   * Original palette index. Preserved across filtering/sorting so materia fallback
   * colors (which derive from index) stay stable regardless of row order.
   */
  index: number;
}

export interface SelectMateriaPaletteRowsOptions {
  materia: NonNullable<MateriaConfig['materia']>;
  query?: string;
  sortMode?: PaletteSortMode;
  direction?: PaletteSortDirection;
}

/**
 * Classifies a materia definition as agent or utility, mirroring the rule used by
 * `materiaPaletteSocket` when building palette sockets. Kept here so palette
 * filtering/sorting stays aligned with how sockets are constructed.
 */
export function resolvePaletteMateriaType(definition?: MateriaBehaviorConfig): 'agent' | 'utility' {
  if (!definition) return 'agent';
  if (definition.type === 'utility') return 'utility';
  if (definition.utility !== undefined || definition.command !== undefined || definition.script !== undefined) return 'utility';
  return 'agent';
}

function materiaTypeRank(definition?: MateriaBehaviorConfig): number {
  return resolvePaletteMateriaType(definition) === 'agent' ? 0 : 1;
}

function readGroup(definition?: MateriaBehaviorConfig): string {
  return typeof definition?.group === 'string' ? definition.group.trim() : '';
}

export function buildPaletteSearchText(id: string, socket: PipelineSocket, materia: NonNullable<MateriaConfig['materia']>): string {
  const definition = materia[id];
  const parts: string[] = [id.toLowerCase(), getSocketLabel(id, socket, materia).toLowerCase()];
  const group = readGroup(definition);
  if (group) parts.push(group.toLowerCase());
  if (typeof definition?.description === 'string' && definition.description) parts.push(definition.description.toLowerCase());
  parts.push(resolvePaletteMateriaType(definition));
  if (isGeneratorSocket(socket, materia)) parts.push('generator');
  if (hasIteratorBehavior(socket, materia)) parts.push('iterator');
  return parts.join(' ');
}

export function filterMateriaPalette(
  entries: MateriaPaletteEntry[],
  materia: NonNullable<MateriaConfig['materia']>,
  query: string,
): MateriaPaletteEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  const tokens = normalized.split(/\s+/);
  return entries.filter((entry) => {
    const text = buildPaletteSearchText(entry.id, entry.socket, materia);
    return tokens.every((token) => text.includes(token));
  });
}

function compareName(a: MateriaPaletteEntry, b: MateriaPaletteEntry, materia: NonNullable<MateriaConfig['materia']>): number {
  return (
    getSocketLabel(a.id, a.socket, materia).localeCompare(getSocketLabel(b.id, b.socket, materia))
    || a.id.localeCompare(b.id)
  );
}

function compareType(a: MateriaPaletteEntry, b: MateriaPaletteEntry, materia: NonNullable<MateriaConfig['materia']>): number {
  const rankDiff = materiaTypeRank(materia[a.id]) - materiaTypeRank(materia[b.id]);
  return rankDiff !== 0 ? rankDiff : compareName(a, b, materia);
}

function compareGroup(a: MateriaPaletteEntry, b: MateriaPaletteEntry, materia: NonNullable<MateriaConfig['materia']>): number {
  const aGroup = readGroup(materia[a.id]);
  const bGroup = readGroup(materia[b.id]);
  if (!aGroup && !bGroup) return compareName(a, b, materia);
  // Ungrouped materia sorts after named groups in ascending order.
  if (!aGroup) return 1;
  if (!bGroup) return -1;
  const groupDiff = aGroup.localeCompare(bGroup);
  return groupDiff !== 0 ? groupDiff : compareName(a, b, materia);
}

export function sortMateriaPalette(
  entries: MateriaPaletteEntry[],
  materia: NonNullable<MateriaConfig['materia']>,
  sortMode: PaletteSortMode,
  direction: PaletteSortDirection,
): MateriaPaletteEntry[] {
  const comparator = sortMode === 'type' ? compareType : sortMode === 'group' ? compareGroup : compareName;
  const sorted = [...entries].sort((a, b) => comparator(a, b, materia));
  return direction === 'asc' ? sorted : sorted.reverse();
}

/**
 * Single entry point used by both the loadout page palette and the socket
 * replacement modal so filtering/sorting stays consistent across surfaces.
 * Returns entries with their original palette index preserved.
 */
export function selectMateriaPaletteRows(
  palette: Array<[string, PipelineSocket]>,
  options: SelectMateriaPaletteRowsOptions,
): MateriaPaletteEntry[] {
  const { materia, query = '', sortMode = 'name', direction = 'asc' } = options;
  const entries: MateriaPaletteEntry[] = palette.map(([id, socket], index) => ({ id, socket, index }));
  return sortMateriaPalette(filterMateriaPalette(entries, materia, query), materia, sortMode, direction);
}
