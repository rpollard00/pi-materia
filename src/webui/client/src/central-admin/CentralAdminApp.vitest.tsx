import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeCentralDevToken } from '../webui/utils/centralDevToken.js';
import { CentralAdminApp } from './CentralAdminApp.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function modeEnvelope() {
  return {
    ok: true,
    service: 'pi-materia-central',
    mode: 'central-admin',
    hasLocalSession: false,
    hasCentral: true,
    capabilities: { catalog: true, modelPolicy: true, telemetry: true, admin: true },
    endpoints: {
      local: { available: false, sameOrigin: false },
      central: { available: true, sameOrigin: true, baseUrl: '' },
    },
  };
}

function metadataEnvelope() {
  return {
    ok: true,
    metadata: {
      server: {
        service: 'pi-materia-central',
        mode: 'central-admin',
        buildVersion: '0.1.10',
        schemaVersion: 1,
        authMethods: ['static-bearer'],
        label: 'test-central',
      },
      roles: [{ roleId: 'central-reader', name: 'Central Reader', permissions: ['catalog.read', 'model-policy.read', 'telemetry.read', 'admin.read'] }],
      principals: [{ principalId: 'reader', tenantId: 'default', roleIds: ['central-reader'] }],
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/central-admin.html');
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CentralAdminApp', () => {
  it('discovers central mode and waits for a credential without calling local APIs', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/backend-mode') return jsonResponse(modeEnvelope());
      throw new Error(`unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CentralAdminApp />);

    expect(await screen.findByTestId('central-admin-signed-out')).toBeTruthy();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(['/api/backend-mode']);
  });

  it('shares an authenticated session across all four navigation surfaces', async () => {
    writeCentralDevToken('reader-secret');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/backend-mode') return jsonResponse(modeEnvelope());
      if (path === '/api/admin') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer reader-secret');
        return jsonResponse(metadataEnvelope());
      }
      if (path === '/api/catalog') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer reader-secret');
        return jsonResponse({ ok: true, items: [] });
      }
      throw new Error(`local-session endpoint must not be called: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CentralAdminApp />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Central Admin' })).toBeTruthy();
    expect(screen.getByTestId('central-admin-catalog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Policy' }));
    expect(screen.getByTestId('central-admin-policy')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Telemetry' }));
    expect(screen.getByTestId('central-admin-telemetry')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Server information' }));
    expect(screen.getByTestId('central-admin-server')).toBeTruthy();

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(['/api/backend-mode', '/api/admin', '/api/catalog']);
  });

  it.each([
    [401, 'central-admin-unauthorized'],
    [403, 'central-admin-forbidden'],
  ])('renders the protected-route HTTP %i state consistently', async (status, testId) => {
    writeCentralDevToken('rejected-secret');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/backend-mode') return jsonResponse(modeEnvelope());
      return jsonResponse({ ok: false }, status);
    }));

    render(<CentralAdminApp />);

    expect(await screen.findByTestId(testId)).toBeTruthy();
  });

  it('renders an unreachable state and retries only central APIs', async () => {
    writeCentralDevToken('reader-secret');
    let adminAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/backend-mode') return jsonResponse(modeEnvelope());
      adminAttempts += 1;
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CentralAdminApp />);

    expect(await screen.findByTestId('central-admin-unreachable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(adminAttempts).toBe(2));
    expect(fetchMock.mock.calls.every((call) => ['/api/backend-mode', '/api/admin'].includes(String(call[0])))).toBe(true);
  });
});
