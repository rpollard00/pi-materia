import { ArrowDownAZ, ArrowUpAZ, Search, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { PaletteSortMenu } from './PaletteSortMenu.js';
import {
  type PaletteSortDirection,
  type PaletteSortMode,
} from '../utils/materiaPaletteFiltering.js';

export interface MateriaPaletteControlsState {
  query: string;
  sortMode: PaletteSortMode;
  direction: PaletteSortDirection;
  setQuery: (value: string) => void;
  setSortMode: (mode: PaletteSortMode) => void;
  toggleDirection: () => void;
  reset: () => void;
}

/**
 * Local filter/sort/direction state shared by the side palette and the
 * replacement modal. Defaults to Name ascending and never persists outside
 * the owning component's lifetime.
 */
export function useMateriaPaletteControls(): MateriaPaletteControlsState {
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<PaletteSortMode>('name');
  const [direction, setDirection] = useState<PaletteSortDirection>('asc');
  const toggleDirection = useCallback(() => setDirection((current) => (current === 'asc' ? 'desc' : 'asc')), []);
  const reset = useCallback(() => {
    setQuery('');
    setSortMode('name');
    setDirection('asc');
  }, []);
  return { query, sortMode, direction, setQuery, setSortMode, toggleDirection, reset };
}

export interface MateriaPaletteControlsProps {
  state: MateriaPaletteControlsState;
  /** Prefixes test ids so the side palette and modal controls can be targeted independently. */
  testIdPrefix: string;
}

export function MateriaPaletteControls({ state, testIdPrefix }: MateriaPaletteControlsProps) {
  const { query, sortMode, direction, setQuery, setSortMode, toggleDirection } = state;
  const nextDirectionLabel = direction === 'asc' ? 'Sort descending' : 'Sort ascending';

  return (
    <div className="palette-controls">
      <div className="palette-controls-search">
        <Search className="palette-controls-icon palette-controls-icon-leading" aria-hidden="true" focusable="false" />
        <input
          type="search"
          className="palette-filter-input"
          aria-label="Filter materia"
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          data-testid={`${testIdPrefix}-filter-input`}
        />
        {query && (
          <button
            type="button"
            className="palette-controls-clear"
            aria-label="Clear materia filter"
            onClick={() => setQuery('')}
            data-testid={`${testIdPrefix}-filter-clear`}
          >
            <X className="palette-controls-icon" aria-hidden="true" focusable="false" />
          </button>
        )}
      </div>
      <PaletteSortMenu
        sortMode={sortMode}
        onSortModeChange={setSortMode}
        testIdPrefix={testIdPrefix}
      />
      <button
        type="button"
        className="palette-direction-toggle"
        aria-label={nextDirectionLabel}
        aria-pressed={direction === 'desc'}
        title={nextDirectionLabel}
        onClick={toggleDirection}
        data-testid={`${testIdPrefix}-sort-direction`}
      >
        {direction === 'asc'
          ? <ArrowUpAZ className="palette-controls-icon" aria-hidden="true" focusable="false" />
          : <ArrowDownAZ className="palette-controls-icon" aria-hidden="true" focusable="false" />}
      </button>
    </div>
  );
}
