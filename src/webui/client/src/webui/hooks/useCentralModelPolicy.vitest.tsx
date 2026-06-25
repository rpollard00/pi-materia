import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCentralModelPolicy } from './useCentralModelPolicy.js';
import { writeCentralDevToken } from '../utils/centralDevToken.js';

function jsonRes(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
}

function activePolicyEnvelope() {
  return {
    ok: true,
    scope: 'control-plane',
    service: 'pi-materia-central',
    activePolicyId: 'buildga-policy',
    policy: {
      id: 'buildga-policy',
      name: 'Buildga policy',
      allow: [{ value: 'zai/glm-4.6' }],
      deny: [{ value: 'forbidden/model' }],
      severity: 'enforced',
      version: '2',
    },
  };
}

function catalogEnvelope() {
  return {
    ok: true,
    scope: 'control-plane',
    service: 'pi-materia-central',
    catalog: {
      entries: [{ value: 'zai/glm-4.6', label: 'GLM 4.6', vendor: 'zai' }],
      updatedAt: '2026-06-24T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useCentralModelPolicy', () => {
  it('stays idle when disabled or missing a base URL', () => {
    const { result } = renderHook(() => useCentralModelPolicy({ enabled: false, baseUrl: 'https://central.example.com' }));
    expect(result.current.loadState).toBe('idle');
    expect(result.current.policy).toBeUndefined();

    const { result: noUrl } = renderHook(() => useCentralModelPolicy({ enabled: true, baseUrl: undefined }));
    expect(noUrl.current.loadState).toBe('idle');
  });

  it('loads central policy and catalog state when enabled', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/model-policy')) return jsonRes(activePolicyEnvelope());
      if (url.endsWith('/api/model-catalog')) return jsonRes(catalogEnvelope());
      return jsonRes({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCentralModelPolicy({ enabled: true, baseUrl: 'https://central.example.com' }));

    await waitFor(() => expect(result.current.loadState).toBe('ready'));
    expect(result.current.activePolicyId).toBe('buildga-policy');
    expect(result.current.policy?.id).toBe('buildga-policy');
    expect(result.current.policy?.deny).toEqual([{ value: 'forbidden/model' }]);
    expect(result.current.catalog?.entries.map((entry) => entry.value)).toEqual(['zai/glm-4.6']);

    // Reads target the absolute central base URL.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('https://central.example.com/api/model-policy');
    expect(urls).toContain('https://central.example.com/api/model-catalog');
  });

  it('presents the dev token as a bearer authorization header', async () => {
    writeCentralDevToken('dev-token-reader');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/model-policy')) return jsonRes(activePolicyEnvelope());
      if (url.endsWith('/api/model-catalog')) return jsonRes({ ok: true });
      return jsonRes({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCentralModelPolicy({ enabled: true, baseUrl: 'https://central.example.com' }));

    await waitFor(() => expect(result.current.loadState).toBe('ready'));
    expect(result.current.token).toBe('dev-token-reader');
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer dev-token-reader');
    }

    // Clearing the token strips the header and persists the change.
    act(() => result.current.setToken(''));
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      const init = lastCall[1] as RequestInit | undefined;
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
    });
    expect(result.current.token).toBe('');
  });

  it('reports an error state when the central read fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCentralModelPolicy({ enabled: true, baseUrl: 'https://central.example.com' }));

    await waitFor(() => expect(result.current.loadState).toBe('error'));
    expect(result.current.error).toBe('network down');
    expect(result.current.policy).toBeUndefined();
  });

  it('reload re-fetches central state', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (url.endsWith('/api/model-policy')) return jsonRes(activePolicyEnvelope());
      if (url.endsWith('/api/model-catalog')) return jsonRes({ ok: true });
      return jsonRes({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCentralModelPolicy({ enabled: true, baseUrl: 'https://central.example.com' }));
    await waitFor(() => expect(result.current.loadState).toBe('ready'));
    const callsAfterFirst = calls;

    act(() => result.current.reload());
    await waitFor(() => expect(calls).toBeGreaterThan(callsAfterFirst));
  });

  it('returns an empty (not error) state when no active policy is configured', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/model-policy')) return jsonRes({ ok: true });
      if (url.endsWith('/api/model-catalog')) return jsonRes({ ok: true });
      return jsonRes({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCentralModelPolicy({ enabled: true, baseUrl: 'https://central.example.com' }));

    await waitFor(() => expect(result.current.loadState).toBe('ready'));
    expect(result.current.policy).toBeUndefined();
    expect(result.current.activePolicyId).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });
});
