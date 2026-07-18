import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { CatalogLocalActionResult } from '../src/application/catalogActions.js';
import type { CatalogLocalActionRequest, CatalogOriginProvenance } from '../src/domain/catalogActions.js';
import {
  createMateriaWebUiServer,
  type MateriaPromoteCatalogCallback,
} from '../src/webui/server/index.js';

const servers: Array<ReturnType<typeof createMateriaWebUiServer>['server']> = [];

const origin: CatalogOriginProvenance = {
  catalogItemId: 'team-build',
  catalogVersion: '3',
  catalogContentHash: 'sha256:central',
  source: 'project',
};

const applied: CatalogLocalActionResult = {
  status: 'applied',
  action: 'copy',
  kind: 'materia',
  localKey: 'Team-Build',
  target: 'project',
  path: '/repo/.pi/pi-materia.json',
  overwrite: false,
  contentChanged: false,
  origin,
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(options: {
  promoteCatalog?: MateriaPromoteCatalogCallback;
  getConfig?: () => Promise<unknown>;
} = {}): Promise<string> {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'pi-materia-webui-promotion-'));
  const created = createMateriaWebUiServer({
    staticDir,
    session: {
      key: 'promotion-session',
      cwd: staticDir,
      sessionFile: `${staticDir}/session.jsonl`,
      sessionId: 'promotion-session-id',
      startedAt: Date.now(),
      getSnapshot: async () => ({
        ok: true,
        scope: 'session',
        service: 'pi-materia-webui',
        sessionKey: 'promotion-session',
        cwd: staticDir,
        sessionFile: `${staticDir}/session.jsonl`,
        sessionId: 'promotion-session-id',
        uiStartedAt: Date.now(),
        now: Date.now(),
      }),
      ...(options.promoteCatalog !== undefined ? { promoteCatalog: options.promoteCatalog } : {}),
      ...(options.getConfig !== undefined ? { getConfig: options.getConfig } : {}),
    },
  });
  await new Promise<void>((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== 'object') throw new Error('promotion test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function promotionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'materia',
    catalogItemId: 'team-build',
    localKey: 'Team-Build',
    target: 'project',
    ...overrides,
  };
}

async function postPromotion(baseUrl: string, action: string, body: unknown, method = 'POST'): Promise<Response> {
  return fetch(`${baseUrl}/api/catalog/promotions/${action}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

describe('local WebUI catalog promotion routes', () => {
  test('uses the route action, requires an explicit target, and rejects ambiguous actions', async () => {
    const calls: CatalogLocalActionRequest[] = [];
    const baseUrl = await startTestServer({
      promoteCatalog: async (request) => {
        calls.push(request);
        return { ...applied, action: request.action };
      },
      getConfig: async () => ({ config: {} }),
    });

    for (const action of ['copy', 'update', 'replace'] as const) {
      const response = await postPromotion(baseUrl, action, promotionBody({
        ...(action === 'copy' ? {} : { confirmOverwrite: true }),
      }));
      expect(response.status).toBe(200);
    }
    expect(calls.map((call) => call.action)).toEqual(['copy', 'update', 'replace']);
    expect(calls.every((call) => call.target === 'project')).toBe(true);

    const missingTarget = await postPromotion(baseUrl, 'copy', promotionBody({ target: undefined }));
    expect(missingTarget.status).toBe(400);
    const missingBody = (await missingTarget.json()) as { error: { code: string; message: string } };
    expect(missingBody.error.code).toBe('invalid_request');
    expect(missingBody.error.message).toContain('target');

    const mismatch = await postPromotion(baseUrl, 'copy', promotionBody({ action: 'replace' }));
    expect(mismatch.status).toBe(400);
    expect(calls).toHaveLength(3);
  });

  test('returns freshly reloaded config, selected drift, and provenance after a write', async () => {
    let refreshes = 0;
    const config = {
      config: { materia: { 'Team-Build': { prompt: 'central', catalogOrigin: origin } } },
      materiaSources: { 'Team-Build': 'project' },
      catalogDrift: {
        materia: {
          'Team-Build': {
            status: 'current',
            centralVersion: '3',
            centralContentHash: 'sha256:central',
          },
        },
      },
    };
    const baseUrl = await startTestServer({
      promoteCatalog: async () => applied,
      getConfig: async () => {
        refreshes += 1;
        return config;
      },
    });

    const response = await postPromotion(baseUrl, 'copy', promotionBody());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.result).toEqual(applied);
    expect(body.provenance).toEqual({ origin });
    expect(body.config).toEqual(config);
    expect(body.drift).toEqual(config.catalogDrift.materia['Team-Build']);
    expect(body.configRefresh).toEqual({ ok: true });
    expect(refreshes).toBe(1);
  });

  test('returns overwrite and provenance conflict details without refreshing or writing again', async () => {
    const previousOrigin = { ...origin, catalogVersion: '2', catalogContentHash: 'sha256:old' };
    let refreshes = 0;
    const baseUrl = await startTestServer({
      promoteCatalog: async () => ({
        status: 'needs_confirmation',
        action: 'update',
        kind: 'materia',
        localKey: 'Team-Build',
        target: 'project',
        reason: 'Local content would change.',
        origin,
        previousOrigin,
      }),
      getConfig: async () => {
        refreshes += 1;
        return {};
      },
    });

    const response = await postPromotion(baseUrl, 'update', promotionBody());
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error).toEqual({ code: 'overwrite_confirmation_required', message: 'Local content would change.' });
    expect(body.conflict).toEqual({
      code: 'overwrite_confirmation_required',
      action: 'update',
      kind: 'materia',
      catalogItemId: 'team-build',
      localKey: 'Team-Build',
      target: 'project',
      confirmOverwriteRequired: true,
      currentOrigin: previousOrigin,
      proposedOrigin: origin,
    });
    expect(body.provenance).toEqual({ origin, previousOrigin });
    expect(refreshes).toBe(0);
  });

  test('maps semantic conflicts and missing central items to 409 and 404', async () => {
    let result: CatalogLocalActionResult = {
      status: 'rejected',
      action: 'copy',
      kind: 'materia',
      localKey: 'Team-Build',
      target: 'project',
      reason: 'Target exists.',
      code: 'target_exists',
      previousOrigin: origin,
    };
    const baseUrl = await startTestServer({
      promoteCatalog: async () => result,
      getConfig: async () => ({}),
    });

    const conflict = await postPromotion(baseUrl, 'copy', promotionBody());
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as Record<string, any>;
    expect(conflictBody.conflict).toMatchObject({ code: 'target_exists', currentOrigin: origin });

    result = {
      status: 'rejected',
      action: 'copy',
      kind: 'materia',
      localKey: 'Team-Build',
      target: 'project',
      reason: 'Central item not found.',
      code: 'not_found',
    };
    const missing = await postPromotion(baseUrl, 'copy', promotionBody());
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as Record<string, any>).error.code).toBe('not_found');
  });

  test('is POST-only, rejects unknown actions, and is unavailable without connected-session dependencies', async () => {
    const callback: MateriaPromoteCatalogCallback = async () => applied;
    const baseUrl = await startTestServer({ promoteCatalog: callback, getConfig: async () => ({}) });

    expect((await postPromotion(baseUrl, 'copy', promotionBody(), 'GET')).status).toBe(405);
    expect((await postPromotion(baseUrl, 'sync', promotionBody())).status).toBe(404);

    const unavailableUrl = await startTestServer();
    const unavailable = await postPromotion(unavailableUrl, 'copy', promotionBody());
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as Record<string, any>).error.code).toBe('unavailable');
  });
});
