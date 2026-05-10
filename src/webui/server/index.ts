import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleActiveLoadoutRoute } from './activeLoadout.js';
import { isPlainObject, readJsonBody, sendJson } from './http.js';
import { buildMateriaModelCatalog } from './modelCatalog.js';
import { handleRoleGenerationRoute } from './roleGeneration.js';
import { serveStatic } from './static.js';
import type { MateriaSetActiveLoadoutCallback } from './activeLoadout.js';
import type { MateriaModelCatalogSource } from './modelCatalog.js';
import type { MateriaRolePromptGenerationRequest, MateriaRolePromptGenerationResult } from './roleGeneration.js';

export { buildMateriaModelCatalog } from './modelCatalog.js';
export type { MateriaModelCatalogModel, MateriaModelCatalogResponse, MateriaModelCatalogSource } from './modelCatalog.js';
export type { MateriaGeneratorConfig, MateriaRolePromptGenerationRequest, MateriaRolePromptGenerationResult } from './roleGeneration.js';
export type { MateriaSetActiveLoadoutCallback, MateriaSetActiveLoadoutFailureCode, MateriaSetActiveLoadoutResult } from './activeLoadout.js';

type MateriaSaveTarget = 'user' | 'project' | 'explicit';
type MateriaConfigPatch = Record<string, unknown>;

export interface MateriaMonitorArtifactEntry {
  node?: string;
  materia?: string;
  phase?: string;
  kind?: string;
  artifact?: string;
  timestamp?: number;
  content?: string;
}

export interface MateriaMonitorEventEntry {
  ts?: number;
  type?: string;
  data?: unknown;
}

export interface MateriaWebUiSessionSnapshot {
  ok: true;
  scope: 'session';
  service: 'pi-materia-webui';
  sessionKey: string;
  cwd: string;
  sessionFile: string;
  sessionId: string;
  uiStartedAt: number;
  now: number;
  emittedOutputs?: Array<{ id: string; type: string; text: string; timestamp?: number; node?: string }>;
  artifactSummary?: {
    runDir?: string;
    request?: string;
    events: MateriaMonitorEventEntry[];
    outputs: MateriaMonitorArtifactEntry[];
    summary: string;
  };
  activeCast?: {
    castId: string;
    active: boolean;
    phase: string;
    currentNode?: string;
    currentMateria?: string;
    nodeState?: string;
    awaitingResponse: boolean;
    runDir: string;
    artifactRoot: string;
    startedAt: number;
    updatedAt: number;
  };
}

export interface MateriaWebUiServerOptions {
  host?: string;
  port?: number;
  staticDir?: string;
  session?: {
    key: string;
    cwd: string;
    sessionFile: string;
    sessionId: string;
    startedAt: number;
    getSnapshot: () => MateriaWebUiSessionSnapshot | Promise<MateriaWebUiSessionSnapshot>;
    getConfig?: () => Promise<unknown>;
    saveConfig?: (patch: MateriaConfigPatch, target: MateriaSaveTarget) => Promise<string>;
    /** Authoritative backend/session callback for active-loadout changes from the WebUI. */
    setActiveLoadout?: MateriaSetActiveLoadoutCallback;
    generateMateriaRole?: (request: MateriaRolePromptGenerationRequest) => Promise<MateriaRolePromptGenerationResult>;
    modelCatalog?: MateriaModelCatalogSource;
  };
}

const defaultStaticDir = resolve(fileURLToPath(new URL('../../../dist/webui/client', import.meta.url)));

export function createMateriaWebUiServer(options: MateriaWebUiServerOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const staticDir = resolve(options.staticDir ?? defaultStaticDir);

  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/health')) {
      sendJson(res, 200, { ok: true, scope: 'session', service: 'pi-materia-webui', sessionKey: options.session?.key });
      return;
    }

    if (req.url?.startsWith('/api/models')) {
      if (req.method && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Use GET to read available models.' });
        return;
      }
      sendJson(res, 200, await buildMateriaModelCatalog(options.session?.modelCatalog));
      return;
    }

    if (req.url?.startsWith('/api/monitor/events')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const writeSnapshot = async () => {
        const snapshot = options.session?.getSnapshot ? await options.session.getSnapshot() : { ok: true, scope: 'session', service: 'pi-materia-webui' };
        res.write(`event: monitor\ndata: ${JSON.stringify(snapshot)}\n\n`);
      };
      await writeSnapshot();
      const interval = setInterval(() => { void writeSnapshot().catch(() => undefined); }, 1500);
      req.on('close', () => clearInterval(interval));
      return;
    }

    if (req.url?.startsWith('/api/session') || req.url?.startsWith('/api/monitor')) {
      const snapshot = options.session?.getSnapshot ? await options.session.getSnapshot() : { ok: true, scope: 'session', service: 'pi-materia-webui' };
      sendJson(res, 200, snapshot);
      return;
    }

    if (req.url?.startsWith('/api/config') && req.method === 'GET') {
      if (!options.session?.getConfig) {
        sendJson(res, 503, { ok: false, error: 'Config API is unavailable for this server.' });
        return;
      }
      try {
        const loaded = await options.session.getConfig();
        sendJson(res, 200, isPlainObject(loaded) ? { ok: true, ...loaded } : { ok: true, config: loaded });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.url?.startsWith('/api/config') && req.method === 'POST') {
      if (!options.session?.saveConfig) {
        sendJson(res, 503, { ok: false, error: 'Config save API is unavailable for this server.' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body) || !isPlainObject(body.config)) throw new Error('Expected JSON body with object field "config".');
        const target = typeof body.target === 'string' ? body.target : 'user';
        if (!['user', 'project', 'explicit'].includes(target)) throw new Error('Invalid save target. Expected user, project, or explicit.');
        const written = await options.session.saveConfig(body.config, target as MateriaSaveTarget);
        sendJson(res, 200, { ok: true, target, written });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.url?.startsWith('/api/loadout/active')) {
      await handleActiveLoadoutRoute(req, res, { setActiveLoadout: options.session?.setActiveLoadout });
      return;
    }

    if (req.url?.startsWith('/api/generate/materia-role')) {
      await handleRoleGenerationRoute(req, res, { generateMateriaRole: options.session?.generateMateriaRole });
      return;
    }

    serveStatic(req, res, staticDir);
  });

  return { server, host, port, staticDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.MATERIA_WEBUI_PORT ?? '0', 10);
  const { server, host, staticDir } = createMateriaWebUiServer({ port: Number.isFinite(port) ? port : 0 });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Materia WebUI listening at http://${host}:${actualPort} (static: ${staticDir})`);
  });
}
