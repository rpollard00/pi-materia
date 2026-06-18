import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompactOptionMenu } from './CompactOptionMenu.js';

type Mode = 'alpha' | 'beta' | 'gamma';

const OPTIONS: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma' },
];

function renderMenu({
  value = 'alpha',
  onChange = vi.fn(),
  testIdPrefix = 'demo',
  classPrefix,
  triggerIcon = <span aria-hidden="true">icon</span>,
}: {
  value?: Mode;
  onChange?: (value: Mode) => void;
  testIdPrefix?: string;
  classPrefix?: string;
  triggerIcon?: ReactNode;
} = {}) {
  render(
    <CompactOptionMenu<Mode>
      value={value}
      options={OPTIONS}
      onChange={onChange}
      testIdPrefix={testIdPrefix}
      classPrefix={classPrefix}
      triggerIcon={triggerIcon}
      triggerAriaLabel={(activeLabel) => `Choose a mode. Current: ${activeLabel}.`}
      triggerTitle={(activeLabel) => `Mode: ${activeLabel}`}
      optionTitle={(label) => `Select ${label}`}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('CompactOptionMenu trigger', () => {
  it('renders the trigger with the icon and menu semantics, closed by default', () => {
    renderMenu();
    const trigger = screen.getByTestId('demo-trigger');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBeNull();
    expect(screen.queryByTestId('demo-menu')).toBeNull();
    expect(trigger.querySelector('span[aria-hidden="true"]')?.textContent).toBe('icon');
  });

  it('derives the trigger aria-label and title from the active option label', () => {
    renderMenu({ value: 'beta' });
    const trigger = screen.getByTestId('demo-trigger');
    expect(trigger.getAttribute('aria-label')).toBe('Choose a mode. Current: Beta.');
    expect(trigger.getAttribute('title')).toBe('Mode: Beta');
  });
});

describe('CompactOptionMenu open behavior', () => {
  it('opens a role=menu popover with every option as a menuitemradio in order', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('demo-trigger'));

    const menu = screen.getByTestId('demo-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(screen.getByTestId('demo-trigger').getAttribute('aria-expanded')).toBe('true');
    // aria-controls points at the open popover id.
    expect(screen.getByTestId('demo-trigger').getAttribute('aria-controls')).toBe(menu.id);

    const options = Array.from(menu.querySelectorAll('[role="menuitemradio"]'));
    expect(options.map((option) => option.getAttribute('data-testid'))).toEqual([
      'demo-option-alpha',
      'demo-option-beta',
      'demo-option-gamma',
    ]);
    expect(options.map((option) => option.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('marks exactly the active option as checked and applies the active class', () => {
    renderMenu({ value: 'gamma' });
    fireEvent.click(screen.getByTestId('demo-trigger'));

    const menu = screen.getByTestId('demo-menu');
    const checked = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(
      (option) => option.getAttribute('aria-checked') === 'true',
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.getAttribute('data-testid')).toBe('demo-option-gamma');
    expect(screen.getByTestId('demo-option-gamma').className).toContain('demo-option-active');
    expect(screen.getByTestId('demo-option-alpha').className).not.toContain('demo-option-active');
  });

  it('recomputes the active indicator when the value changes between opens', () => {
    const { rerender } = render(
      <CompactOptionMenu<Mode>
        value="alpha"
        options={OPTIONS}
        onChange={() => undefined}
        testIdPrefix="demo"
        triggerIcon={<span />}
        triggerAriaLabel={(label) => label}
      />,
    );
    fireEvent.click(screen.getByTestId('demo-trigger'));
    expect(screen.getByTestId('demo-option-alpha').getAttribute('aria-checked')).toBe('true');

    rerender(
      <CompactOptionMenu<Mode>
        value="beta"
        options={OPTIONS}
        onChange={() => undefined}
        testIdPrefix="demo"
        triggerIcon={<span />}
        triggerAriaLabel={(label) => label}
      />,
    );
    expect(screen.getByTestId('demo-option-beta').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('demo-option-alpha').getAttribute('aria-checked')).toBe('false');
  });

  it('calls onChange with the selected value and closes the menu', () => {
    const onChange = vi.fn();
    renderMenu({ onChange });
    fireEvent.click(screen.getByTestId('demo-trigger'));
    fireEvent.click(screen.getByTestId('demo-option-beta'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('beta');
    expect(screen.queryByTestId('demo-menu')).toBeNull();
  });

  it('applies a per-option title when optionTitle is provided', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('demo-trigger'));
    expect(screen.getByTestId('demo-option-beta').getAttribute('title')).toBe('Select Beta');
  });
});

describe('CompactOptionMenu close interactions', () => {
  it('closes on an outside pointer down', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('demo-trigger'));
    expect(screen.getByTestId('demo-menu')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('demo-menu')).toBeNull();
  });

  it('does not close when a pointer down lands inside the menu', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('demo-trigger'));
    fireEvent.pointerDown(screen.getByTestId('demo-option-beta'));
    expect(screen.getByTestId('demo-menu')).toBeTruthy();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderMenu();
    const trigger = screen.getByTestId('demo-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('demo-menu')).toBeTruthy();

    // Move focus into the menu to prove Escape restores it to the trigger.
    screen.getByTestId('demo-option-beta').focus();
    expect(document.activeElement).toBe(screen.getByTestId('demo-option-beta'));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('demo-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('ignores Escape while the menu is closed', () => {
    renderMenu();
    // Menu is closed; Escape must not throw or change focus.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('demo-menu')).toBeNull();
  });
});

describe('CompactOptionMenu theming hooks', () => {
  it('uses testIdPrefix for data-testid and classPrefix for class names independently', () => {
    renderMenu({ testIdPrefix: 'demo', classPrefix: 'themed' });
    // Wrapper carries the themed class prefix...
    const wrapper = screen.getByTestId('demo-trigger').parentElement;
    expect(wrapper?.className).toContain('themed-menu');
    // ...while the trigger keeps the demo test id with the themed class.
    const trigger = screen.getByTestId('demo-trigger');
    expect(trigger.className).toContain('themed-trigger');

    fireEvent.click(trigger);
    const menu = screen.getByTestId('demo-menu');
    expect(menu.className).toContain('themed-popover');
    expect(screen.getByTestId('demo-option-alpha').className).toContain('themed-option');
  });

  it('defaults the class prefix to the test id prefix when omitted', () => {
    renderMenu({ testIdPrefix: 'demo' });
    const trigger = screen.getByTestId('demo-trigger');
    expect(trigger.className).toContain('demo-trigger');
  });
});
