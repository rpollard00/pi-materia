import { ArrowDownUp, Check } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
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
 * palette toolbar. A single sort icon opens an accessible (role="menu") popover
 * listing the available sort fields; the active field is marked both visually
 * (check mark) and for assistive tech (menuitemradio + aria-checked). Behavior
 * mirrors the existing LoadoutActionsMenu: outside pointer-down and Escape
 * close the menu, and Escape returns focus to the trigger.
 */
export function PaletteSortMenu({ sortMode, onSortModeChange, testIdPrefix }: PaletteSortMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const activeLabel = paletteSortModes.find((mode) => mode.value === sortMode)?.label ?? sortMode;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function selectMode(mode: PaletteSortMode) {
    setOpen(false);
    onSortModeChange(mode);
  }

  return (
    <div className="palette-sort-menu" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="palette-sort-trigger"
        aria-label={`Sort materia by field. Current sort: ${activeLabel}.`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`Sort field: ${activeLabel}`}
        onClick={() => setOpen((current) => !current)}
        data-testid={`${testIdPrefix}-sort-trigger`}
      >
        <ArrowDownUp className="palette-controls-icon" aria-hidden="true" focusable="false" />
      </button>
      {open && (
        <div
          id={menuId}
          className="palette-sort-popover"
          role="menu"
          aria-label={`Sort materia by field. Current sort: ${activeLabel}.`}
          data-testid={`${testIdPrefix}-sort-menu`}
        >
          {paletteSortModes.map((mode) => {
            const isActive = mode.value === sortMode;
            return (
              <button
                key={mode.value}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={`palette-sort-option ${isActive ? 'palette-sort-option-active' : ''}`}
                title={`Sort by ${mode.label}`}
                onClick={() => selectMode(mode.value)}
                data-testid={`${testIdPrefix}-sort-option-${mode.value}`}
              >
                <span className="palette-sort-option-label">{mode.label}</span>
                <Check
                  className={`palette-sort-option-check ${isActive ? 'palette-sort-option-check-visible' : ''}`}
                  aria-hidden="true"
                  focusable="false"
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
