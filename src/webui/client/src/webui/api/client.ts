import type { MateriaConfig, PipelineConfig } from '../../loadoutModel.js';
import type {
  ActiveLoadoutResponse,
  AddQuestRequest,
  AddQuestResponse,
  ConfigResponse,
  DefaultLoadoutResponse,
  GeneratedListOutputConfig,
  ModelCatalogResponse,
  MonitorSnapshot,
  QuestBoardResponse,
  QuestDefaultLoadoutResponse,
  ReorderQuestRequest,
  RequeueQuestRequest,
  RoleGenerationPreferenceResponse,
  RoleGenerationPreferenceSavePayload,
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

export async function setQuestDefaultLoadout(name: string | null): Promise<ApiResponse<QuestDefaultLoadoutResponse>> {
  return fetchJson<QuestDefaultLoadoutResponse>('/api/loadout/quest-default-loadout', {
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

export async function getQuests(): Promise<QuestBoardResponse> {
  return (await fetchJson<QuestBoardResponse>('/api/quests')).body;
}

export async function addQuest(payload: AddQuestRequest): Promise<ApiResponse<AddQuestResponse>> {
  return fetchJson<AddQuestResponse>('/api/quests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function reorderQuest(payload: ReorderQuestRequest): Promise<ApiResponse<QuestBoardResponse>> {
  return fetchJson<QuestBoardResponse>('/api/quests/reorder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function requeueQuest(payload: RequeueQuestRequest): Promise<ApiResponse<QuestBoardResponse>> {
  return fetchJson<QuestBoardResponse>('/api/quests/requeue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function getRoleGenerationPreference(): Promise<ApiResponse<RoleGenerationPreferenceResponse>> {
  return fetchJson<RoleGenerationPreferenceResponse>('/api/profile/role-generation');
}

export async function saveRoleGenerationPreference(payload: RoleGenerationPreferenceSavePayload): Promise<ApiResponse<RoleGenerationPreferenceResponse>> {
  return fetchJson<RoleGenerationPreferenceResponse>('/api/profile/role-generation', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function generateMateriaRole(brief: string, generates: GeneratedListOutputConfig | null): Promise<ApiResponse<RoleGenerationResponse>> {
  return fetchJson<RoleGenerationResponse>('/api/generate/materia-role', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief, generates }),
  });
}
