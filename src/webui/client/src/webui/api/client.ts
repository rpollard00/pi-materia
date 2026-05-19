import type { MateriaConfig, PipelineConfig } from '../../loadoutModel.js';
import type {
  ActiveLoadoutResponse,
  ConfigResponse,
  DefaultLoadoutResponse,
  GeneratedListOutputConfig,
  ModelCatalogResponse,
  MonitorSnapshot,
  RoleGenerationResponse,
  SaveTarget,
} from '../types.js';
import { normalizeModelCatalog } from '../utils/modelCatalog.js';

export interface ApiResponse<TBody> {
  response: Response;
  body: TBody;
}

export type SaveConfigPayload = Omit<MateriaConfig, 'loadouts' | 'materia'> & {
  loadouts?: Record<string, PipelineConfig | null>;
  materia?: Record<string, NonNullable<MateriaConfig['materia']>[string] | Partial<NonNullable<MateriaConfig['materia']>[string]> | null>;
};

async function fetchJson<TBody>(input: RequestInfo | URL, init?: RequestInit): Promise<ApiResponse<TBody>> {
  const response = init === undefined ? await fetch(input) : await fetch(input, init);
  const body = await response.json() as TBody;
  return { response, body };
}

export async function getConfig(): Promise<ConfigResponse> {
  return (await fetchJson<ConfigResponse>('/api/config')).body;
}

export async function saveConfig(target: SaveTarget, config: SaveConfigPayload): Promise<ApiResponse<{ ok?: boolean; error?: string; target?: SaveTarget }>> {
  return fetchJson<{ ok?: boolean; error?: string; target?: SaveTarget }>('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, config }),
  });
}

export async function setActiveLoadout(name: string): Promise<ApiResponse<ActiveLoadoutResponse>> {
  return fetchJson<ActiveLoadoutResponse>('/api/loadout/active', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function setDefaultLoadout(name: string | null): Promise<ApiResponse<DefaultLoadoutResponse>> {
  return fetchJson<DefaultLoadoutResponse>('/api/loadout/default', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function getModels(): Promise<ModelCatalogResponse> {
  const response = await fetch('/api/models');
  if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}`);
  return normalizeModelCatalog(await response.json());
}

export async function getMonitorSnapshot(): Promise<MonitorSnapshot> {
  return (await fetchJson<MonitorSnapshot>('/api/monitor')).body;
}

export async function generateMateriaRole(brief: string, generates: GeneratedListOutputConfig | null): Promise<ApiResponse<RoleGenerationResponse>> {
  return fetchJson<RoleGenerationResponse>('/api/generate/materia-role', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief, generates }),
  });
}
