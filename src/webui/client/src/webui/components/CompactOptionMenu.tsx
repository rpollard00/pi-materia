import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface CompactOptionMenuOption<T extends string> {
  value: T;
  label: string;
}

export interface CompactOptionMenuProps<T extends string> {
  /** Currently selected value. Drives the active item indicator and trigger label. */
  value: T;
  /** Selectable options, in display order. */
  options: ReadonlyArray<CompactOptionMenuOption<T>>;
  /** Called with the newly selected value when an option is clicked. */
  onChange: (value: T) => void;
  /** Prefix used to build data-testid attributes (e.g. `${testIdPrefix}-trigger`). */
  testIdPrefix: string;
  /**
   * Prefix used to build BEM-style class names (e.g. `${classPrefix}-popover`).
   * Defaults to testIdPrefix so each consumer can theme its menu independently
   * without giving up the shared structure.
   */
  classPrefix?: string;
  /** Icon rendered inside the compact trigger button. */
  triggerIcon: ReactNode;
  /** Builds the trigger + menu aria-label from the active option's label. */
  triggerAriaLabel: (activeLabel: string) => string;
  /** Builds the trigger title from the active option's label. Defaults to triggerAriaLabel. */
  triggerTitle?: (activeLabel: string) => string;
  /** Builds each option's title from its label. Omit to skip per-option titles. */
  optionTitle?: (label: string) => string;
}

/**
 * Reusable compact icon-triggered dropdown for single-select option lists.
 * Renders an accessible (role="menu" / role="menuitemradio") popover with a
 * check indicator on the active value, matching the Materia Palette sort
 * dropdown's structure and behavior: outside pointer-down and Escape close the
 * menu, and Escape returns focus to the trigger. The classPrefix/testIdPrefix
 * props let each consumer theme and target the menu independently while sharing
 * one accessible implementation.
 */
export function CompactOptionMenu<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix,
  classPrefix = testIdPrefix,
  triggerIcon,
  triggerAriaLabel,
  triggerTitle = triggerAriaLabel,
  optionTitle,
}: CompactOptionMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const activeLabel = options.find((option) => option.value === value)?.label ?? value;

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

  function selectOption(nextValue: T) {
    setOpen(false);
    onChange(nextValue);
  }

  return (
    <div className={`${classPrefix}-menu`} ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${classPrefix}-trigger`}
        aria-label={triggerAriaLabel(activeLabel)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={triggerTitle(activeLabel)}
        onClick={() => setOpen((current) => !current)}
        data-testid={`${testIdPrefix}-trigger`}
      >
        {triggerIcon}
      </button>
      {open && (
        <div
          id={menuId}
          className={`${classPrefix}-popover`}
          role="menu"
          aria-label={triggerAriaLabel(activeLabel)}
          data-testid={`${testIdPrefix}-menu`}
        >
          {options.map((option) => {
            const isActive = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={`${classPrefix}-option ${isActive ? `${classPrefix}-option-active` : ''}`}
                title={optionTitle ? optionTitle(option.label) : undefined}
                onClick={() => selectOption(option.value)}
                data-testid={`${testIdPrefix}-option-${option.value}`}
              >
                <span className={`${classPrefix}-option-label`}>{option.label}</span>
                <Check
                  className={`${classPrefix}-option-check ${isActive ? `${classPrefix}-option-check-visible` : ''}`}
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
