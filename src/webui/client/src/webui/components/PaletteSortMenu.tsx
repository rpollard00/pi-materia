import { ArrowDownUp } from 'lucide-react';
import { CompactOptionMenu } from './CompactOptionMenu.js';
import {
  type PaletteSortMode,
  paletteSortModes,
} from '../utils/materiaPaletteFiltering.js';

export interface PaletteSortMenuProps {
  /** Currently selected sort field. Drives the active item indicator. */
  sortMode: PaletteSortMode;
  onSortModeChange: (mode: PaletteSortMode) => void;
  /** Prefixes test ids so the side palette and modal menus can be targeted independently. */
  testIdPrefix: string;
}

/**
 * Compact icon menu that replaces the native sort <select> in the materia
 * palette toolbar. Delegates rendering to the shared {@link CompactOptionMenu}
 * so the sort field dropdown and future consumers (e.g. the runtime event
 * severity filter) share one accessible, palette-styled component. The
 * `palette-sort` class prefix keeps the existing styles and tests intact.
 */
export function PaletteSortMenu({ sortMode, onSortModeChange, testIdPrefix }: PaletteSortMenuProps) {
  return (
    <CompactOptionMenu<PaletteSortMode>
      value={sortMode}
      options={paletteSortModes}
      onChange={onSortModeChange}
      testIdPrefix={`${testIdPrefix}-sort`}
      classPrefix="palette-sort"
      triggerIcon={<ArrowDownUp className="palette-controls-icon" aria-hidden="true" focusable="false" />}
      triggerAriaLabel={(activeLabel) => `Sort materia by field. Current sort: ${activeLabel}.`}
      triggerTitle={(activeLabel) => `Sort field: ${activeLabel}`}
      optionTitle={(label) => `Sort by ${label}`}
    />
  );
}
