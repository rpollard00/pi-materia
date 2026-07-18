import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { webUiLauncherTestInternals } from '../src/webui/launcher.js';

const servers: Server[] = [];
const originalProfileDir = process.env.PI_MATERIA_PROFILE_DIR;

afterEach(async () => {
  if (originalProfileDir === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
  else process.env.PI_MATERIA_PROFILE_DIR = originalProfileDir;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startCatalogFixture(): Promise<{ apiUrl: string; requests: Array<{ url: string; authorization?: string }> }> {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const server = createServer((req, res) => {
    requests.push({
      url: req.url ?? '',
      ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      item: {
        id: 'team-build',
        kind: 'materia',
        version: '7',
        updatedAt: '2026-07-18T00:00:00.000Z',
        contentHash: 'sha256:central-v7',
        content: {
          definition: {
            type: 'agent',
            tools: 'coding',
            prompt: 'Build from the central catalog.',
          },
        },
      },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('catalog fixture did not bind');
  return { apiUrl: `http://127.0.0.1:${address.port}`, requests };
}

describe('WebUI catalog promotion launcher composition', () => {
  test('reads through the central HTTP client and writes through the local config store', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'pi-materia-promotion-launcher-'));
    process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), 'pi-materia-promotion-profile-'));
    const fixture = await startCatalogFixture();
    const promoteCatalog = webUiLauncherTestInternals.createCatalogPromotionCallback({
      apiUrl: fixture.apiUrl,
      requestTimeoutMs: 1_000,
      credentials: { readToken: 'reader-secret' },
    }, cwd);

    const result = await promoteCatalog({
      action: 'copy',
      kind: 'materia',
      catalogItemId: 'team-build',
      localKey: 'Team-Build',
      target: 'project',
    });

    expect(result).toMatchObject({
      status: 'applied',
      action: 'copy',
      kind: 'materia',
      localKey: 'Team-Build',
      target: 'project',
      overwrite: false,
      origin: {
        catalogItemId: 'team-build',
        catalogVersion: '7',
        catalogContentHash: 'sha256:central-v7',
        source: 'project',
      },
    });
    expect(fixture.requests).toEqual([{
      url: '/api/catalog/materia/team-build',
      authorization: 'Bearer reader-secret',
    }]);

    const saved = JSON.parse(await readFile(path.join(cwd, '.pi', 'pi-materia.json'), 'utf8')) as Record<string, any>;
    expect(saved.materia['Team-Build']).toMatchObject({
      type: 'agent',
      tools: 'coding',
      prompt: 'Build from the central catalog.',
      catalogOrigin: {
        catalogItemId: 'team-build',
        catalogVersion: '7',
        catalogContentHash: 'sha256:central-v7',
        source: 'project',
      },
    });
  });
});
