import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBackendMode, normalizeBackendModeResponse, isCentralSameOriginFromBrowser } from './useBackendMode.js';
import type { BackendModeResponse } from '../types.js';

function jsonRes(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
}

function Harness({ onState }: { onState: (state: ReturnType<typeof useBackendMode>) => void }) {
  const state = useBackendMode();
  return (
    <div>
      <span data-testid="load-state">{state.loadState}</span>
      <span data-testid="mode">{state.mode}</span>
      <span data-testid="has-local">{String(state.hasLocalSession)}</span>
      <span data-testid="has-central">{String(state.hasCentral)}</span>
      <span data-testid="central-url">{state.centralApiBaseUrl ?? ''}</span>
      <span data-testid="central-same-origin">{String(state.centralSameOrigin)}</span>
      <span data-testid="capabilities">{[
        state.capabilities.catalog ? 'catalog' : '',
        state.capabilities.modelPolicy ? 'modelPolicy' : '',
        state.capabilities.telemetry ? 'telemetry' : '',
        state.capabilities.admin ? 'admin' : '',
      ].filter(Boolean).join(',')}</span>
      <span data-testid="error">{state.error ?? ''}</span>
      <button type="button" onClick={() => onState(state)}>capture</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isCentralSameOriginFromBrowser', () => {
  it('matches only when origins are equal', () => {
    expect(isCentralSameOriginFromBrowser(undefined, 'http://localhost:3000')).toBe(false);
    expect(isCentralSameOriginFromBrowser('https://central.example.com', undefined)).toBe(false);
    expect(isCentralSameOriginFromBrowser('https://central.example.com', 'http://localhost:3000')).toBe(false);
    expect(isCentralSameOriginFromBrowser('http://localhost:3000/central', 'http://localhost:3000')).toBe(true);
    expect(isCentralSameOriginFromBrowser('garbage', 'http://localhost:3000')).toBe(false);
  });
});

describe('normalizeBackendModeResponse', () => {
  it('defaults to local-only for missing/partial payloads', () => {
    const empty = normalizeBackendModeResponse(undefined, 'http://localhost:3000');
    expect(empty.mode).toBe('local-only');
    expect(empty.hasLocalSession).toBe(true);
    expect(empty.hasCentral).toBe(false);
    expect(empty.capabilities).toEqual({ catalog: false, modelPolicy: false, telemetry: false, admin: false });
    expect(empty.local).toEqual({ available: true, sameOrigin: true, baseUrl: '' });
    expect(empty.central).toEqual({ available: false, sameOrigin: false, baseUrl: '' });
  });

  it('normalizes central-connected topology and recomputes same-origin from the browser origin', () => {
    const crossOrigin = normalizeBackendModeResponse(
      { ok: true, mode: 'central-connected', hasLocalSession: true, hasCentral: true, centralApiBaseUrl: 'https://central.example.com', capabilities: { catalog: true } },
      'http://localhost:3000',
    );
    expect(crossOrigin.mode).toBe('central-connected');
    expect(crossOrigin.hasCentral).toBe(true);
    expect(crossOrigin.centralApiBaseUrl).toBe('https://central.example.com');
    expect(crossOrigin.centralSameOrigin).toBe(false);
    expect(crossOrigin.capabilities).toEqual({ catalog: true, modelPolicy: false, telemetry: false, admin: false });
    expect(crossOrigin.central.available).toBe(true);

    const sameOrigin = normalizeBackendModeResponse(
      { ok: true, mode: 'central-connected', hasCentral: true, centralApiBaseUrl: 'http://localhost:3000/central' },
      'http://localhost:3000',
    );
    expect(sameOrigin.centralSameOrigin).toBe(true);
    expect(sameOrigin.central.sameOrigin).toBe(true);
  });

  it('falls back to local-only when mode is unknown', () => {
    const raw = { ok: true, mode: 'bogus' } as unknown as BackendModeResponse;
    const normalized = normalizeBackendModeResponse(raw, 'http://localhost:3000');
    expect(normalized.mode).toBe('local-only');
  });
});

describe('useBackendMode', () => {
  it('loads ready state and central capabilities from the discovery endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonRes({
        ok: true,
        scope: 'session',
        service: 'pi-materia-webui',
        mode: 'central-connected',
        hasLocalSession: true,
        hasCentral: true,
        centralApiBaseUrl: 'https://central.example.com',
        capabilities: { catalog: true, modelPolicy: true, telemetry: true, admin: true },
        endpoints: {
          local: { available: true, sameOrigin: true, baseUrl: '' },
          central: { available: true, sameOrigin: false, baseUrl: 'https://central.example.com' },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness onState={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId('load-state').textContent).toBe('ready'));
    expect(screen.getByTestId('mode').textContent).toBe('central-connected');
    expect(screen.getByTestId('has-local').textContent).toBe('true');
    expect(screen.getByTestId('has-central').textContent).toBe('true');
    expect(screen.getByTestId('central-url').textContent).toBe('https://central.example.com');
    expect(screen.getByTestId('capabilities').textContent).toBe('catalog,modelPolicy,telemetry,admin');
    expect(fetchMock).toHaveBeenCalledWith('/api/backend-mode');
  });

  it('keeps local-only defaults and reports an error when discovery fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness onState={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId('load-state').textContent).toBe('error'));
    expect(screen.getByTestId('mode').textContent).toBe('local-only');
    expect(screen.getByTestId('has-central').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).not.toBe('');
  });
});
