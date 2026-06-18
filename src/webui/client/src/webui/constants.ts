import type { MateriaEdgeCondition } from '../../../../types.js';
import type { MateriaTabId } from './types.js';

export const materiaSavedEventName = 'materia:saved';
export const activeModelOptionLabel = 'Active Pi Model';
export const activeThinkingOptionLabel = 'Active Pi Thinking';

export const thinkingLevelLabels: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
};

export const socketLayoutOffsetX = 32;
export const socketLayoutOffsetY = 28;
export const socketCardWidth = 132;
export const socketStageSize = 92;
export const socketStageHeight = socketStageSize;
export const socketStageOffsetX = (socketCardWidth - socketStageSize) / 2;
export const socketLayoutUnitX = 208;
export const socketLayoutUnitY = 168;
export const socketLayoutRowGap = 240;
export const socketGraphExtent = 190;
export const loopCanvasPadding = 28;
export const loopCyclePadding = 24;
export const loopHeaderOffset = 112;
export const loopHeaderHeight = 92;
export const loopHeaderMinWidth = 360;
export const loopHeaderMaxWidth = 780;

export const loopAccentPalette = [
  { accent: 'rgb(165 180 252)', accentSoft: 'rgb(165 180 252 / 0.22)' },
  { accent: 'rgb(103 232 249)', accentSoft: 'rgb(103 232 249 / 0.22)' },
  { accent: 'rgb(52 211 153)', accentSoft: 'rgb(52 211 153 / 0.22)' },
  { accent: 'rgb(251 191 36)', accentSoft: 'rgb(251 191 36 / 0.22)' },
  { accent: 'rgb(244 114 182)', accentSoft: 'rgb(244 114 182 / 0.22)' },
];

export const materiaTabs: Array<{ id: MateriaTabId; label: string; description: string }> = [
  { id: 'loadout', label: 'Loadout', description: 'Loadout selector, visual grid, palette, and apply controls' },
  { id: 'materia-editor', label: 'Materia Editor', description: 'Create and edit materia definitions' },
  { id: 'quests', label: 'Quests', description: 'Quest log, active work, and pending quest creation' },
  { id: 'monitor', label: 'Monitoring', description: 'Live runtime event monitor for the active cast' },
];

export const edgeConditionLabels: Record<MateriaEdgeCondition, string> = {
  always: 'Always',
  satisfied: 'Satisfied',
  not_satisfied: 'Not Satisfied',
};
