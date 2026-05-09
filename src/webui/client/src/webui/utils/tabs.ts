import { materiaTabs } from '../constants.js';
import type { MateriaTabId } from '../types.js';

export function parseTabId(value: string | null): MateriaTabId {
  return materiaTabs.some((tab) => tab.id === value) ? value as MateriaTabId : 'loadout';
}

export function tabFromLocation(): MateriaTabId {
  if (typeof window === 'undefined') return 'loadout';
  return parseTabId(new URLSearchParams(window.location.search).get('tab'));
}
