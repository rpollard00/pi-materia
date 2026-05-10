import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMateriaWebUiRequest } from './routes.js';
import type { MateriaSetActiveLoadoutCallback } from './activeLoadout.js';
import type { MateriaConfigPatch, MateriaSaveTarget } from './config.js';
import type { MateriaModelCatalogSource } from './modelCatalog.js';
import type { MateriaRolePromptGenerationRequest, MateriaRolePromptGenerationResult } from './roleGeneration.js';
import type { MateriaWebUiSessionSnapshot } from './session.js';

// Compatibility facade: consumers and tests import public WebUI server helpers
// from this entry point while route/service implementations live in focused
// backend modules next to it.
export { buildMateriaModelCatalog } from './modelCatalog.js';
export type { MateriaConfigPatch, MateriaSaveTarget } from './config.js';
export type { MateriaModelCatalogModel, MateriaModelCatalogResponse, MateriaModelCatalogSource } from './modelCatalog.js';
export type { MateriaGeneratorConfig, MateriaRolePromptGenerationRequest, MateriaRolePromptGenerationResult } from './roleGeneration.js';
export type { MateriaSetActiveLoadoutCallback, MateriaSetActiveLoadoutFailureCode, MateriaSetActiveLoadoutResult } from './activeLoadout.js';
export type { MateriaMonitorArtifactEntry, MateriaMonitorEventEntry, MateriaWebUiSessionSnapshot } from './session.js';

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
    await handleMateriaWebUiRequest(req, res, { staticDir, session: options.session });
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
