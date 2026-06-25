import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CentralModelPolicyPanel } from './CentralModelPolicyPanel.js';
import type { CentralModelPolicyState } from '../../hooks/useCentralModelPolicy.js';

function makeState(overrides: Partial<CentralModelPolicyState> = {}): CentralModelPolicyState {
  return {
    loadState: 'idle',
    activePolicyId: undefined,
    policy: undefined,
    catalog: undefined,
    error: undefined,
    token: '',
    setToken: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  };
}

function renderPanel(overrides: Partial<ComponentProps<typeof CentralModelPolicyPanel>> = {}) {
  const props: ComponentProps<typeof CentralModelPolicyPanel> = {
    state: makeState(),
    centralApiBaseUrl: 'https://central.example.com',
    centralSameOrigin: false,
    ...overrides,
  };
  render(<CentralModelPolicyPanel {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe('CentralModelPolicyPanel', () => {
  it('renders the panel header and central endpoint metadata', () => {
    renderPanel();
    const section = screen.getByTestId('central-model-policy-panel');
    expect(within(section).getByRole('heading', { name: 'Central model policy' })).toBeTruthy();
    expect(within(section).getByText('https://central.example.com')).toBeTruthy();
    expect(within(section).getByTestId('central-model-policy-origin').textContent).toBe('cross-origin');
  });

  it('shows the empty state when no active policy is configured', () => {
    renderPanel({ state: makeState({ loadState: 'ready' }) });
    expect(screen.getByTestId('central-model-policy-empty')).toBeTruthy();
    expect(screen.queryByTestId('central-model-policy-document')).toBeNull();
  });

  it('renders an active policy document with allow/deny/prefer/thinking fields', () => {
    renderPanel({
      state: makeState({
        loadState: 'ready',
        activePolicyId: 'buildga-policy',
        policy: {
          id: 'buildga-policy',
          name: 'Buildga policy',
          description: 'Constrain Buildga model selection.',
          allow: [{ value: 'zai/glm-4.6' }],
          deny: [{ value: 'forbidden/model' }],
          prefer: [{ value: 'anthropic/claude', label: 'Claude' }],
          thinking: { allow: ['medium', 'high'], max: 'high' },
          severity: 'advisory',
          version: '2',
          updatedAt: '2026-06-24T00:00:00.000Z',
        },
      }),
    });
    const doc = screen.getByTestId('central-model-policy-document');
    expect(within(doc).getByText('Buildga policy')).toBeTruthy();
    expect(within(doc).getByText('active')).toBeTruthy();
    expect(within(doc).getByText('zai/glm-4.6')).toBeTruthy();
    expect(within(doc).getByText('forbidden/model')).toBeTruthy();
    expect(within(doc).getByText('Claude')).toBeTruthy();
    expect(within(doc).getByText(/allow: Medium, High/)).toBeTruthy();
    expect(within(doc).getByText(/max: High/)).toBeTruthy();
    expect(within(doc).getByText('advisory')).toBeTruthy();
    expect(within(doc).getByText('2')).toBeTruthy();
  });

  it('renders the optional central model catalog when configured', () => {
    renderPanel({
      state: makeState({
        loadState: 'ready',
        catalog: {
          entries: [
            { value: 'zai/glm-4.6', label: 'GLM 4.6', vendor: 'zai' },
            { value: 'legacy/model', deprecated: true },
          ],
          updatedAt: '2026-06-24T00:00:00.000Z',
        },
      }),
    });
    const catalogSection = screen.getByTestId('central-model-catalog');
    expect(within(catalogSection).getByText('GLM 4.6')).toBeTruthy();
    expect(within(catalogSection).getByText('zai/glm-4.6')).toBeTruthy();
    expect(within(catalogSection).getByText('deprecated')).toBeTruthy();
  });

  it('surfaces read errors via an alert', () => {
    renderPanel({ state: makeState({ loadState: 'error', error: 'HTTP 401' }) });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('HTTP 401');
    expect(screen.queryByTestId('central-model-policy-empty')).toBeNull();
  });

  it('forwards token changes and reload requests', () => {
    const setToken = vi.fn();
    const reload = vi.fn();
    renderPanel({ state: makeState({ loadState: 'ready', token: 'dev-token-reader', setToken, reload }) });

    const input = screen.getByTestId('central-model-policy-token') as HTMLInputElement;
    expect(input.value).toBe('dev-token-reader');
    fireEvent.change(input, { target: { value: 'dev-token-admin' } });
    expect(setToken).toHaveBeenCalledWith('dev-token-admin');

    fireEvent.click(screen.getByTestId('central-model-policy-reload'));
    expect(reload).toHaveBeenCalled();
  });

  it('disables the refresh button while loading', () => {
    renderPanel({ state: makeState({ loadState: 'loading' }) });
    expect((screen.getByTestId('central-model-policy-reload') as HTMLButtonElement).disabled).toBe(true);
  });
});
