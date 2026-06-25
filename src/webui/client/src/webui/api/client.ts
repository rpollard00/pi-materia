import type { MateriaConfig, PipelineConfig } from '../../loadoutModel.js';
import type {
  ActiveLoadoutResponse,
  AddQuestRequest,
  AddQuestResponse,
  BackendModeResponse,
  CentralModelCatalogResponse,
  CentralModelPolicyResponse,
  ConfigResponse,
  DefaultLoadoutResponse,
  DeleteQuestResponse,
  GeneratedListOutputConfig,
  ModelCatalogResponse,
  MonitorSnapshot,
  QuestBoardResponse,
  QuestControlRequest,
  QuestControlResponse,
  QuestDefaultLoadoutResponse,
  ReorderQuestRequest,
  RequeueQuestRequest,
  RoleGenerationPreferenceResponse,
  UpdateQuestRequest,
  UpdateQuestResponse,
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

/** Discover whether the UI is connected to local session APIs, a central control plane, or both. */
export async function getBackendMode(): Promise<BackendModeResponse> {
  return (await fetchJson<BackendModeResponse>('/api/backend-mode')).body;
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

/** Options for reading a central control-plane API surface. */
export interface CentralReadOptions {
  /** Absolute central API base URL (from backend mode discovery). */
  baseUrl: string;
  /** Optional `Authorization` header value (e.g. a dev-stage bearer token). */
  authorization?: string;
}

function centralUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}${path}`;
}

function centralHeaders(options: CentralReadOptions): Record<string, string> | undefined {
  return options.authorization ? { authorization: options.authorization } : undefined;
}

/**
 * Read the active central model-policy document. Served by the central control
 * plane independently from local Pi model availability
 * (docs/enterprise-control-plane.md §11). Requires `model-policy.read`.
 */
export async function getCentralModelPolicy(options: CentralReadOptions): Promise<CentralModelPolicyResponse> {
  const response = await fetch(centralUrl(options.baseUrl, '/api/model-policy'), {
    ...(centralHeaders(options) ? { headers: centralHeaders(options) } : {}),
  });
  if (!response.ok) throw new Error(`Central model-policy request failed with HTTP ${response.status}`);
  return (await response.json()) as CentralModelPolicyResponse;
}

/**
 * Read optional central model-catalog metadata. Presentation metadata only;
 * never constrains selection on its own (§11). Requires `model-policy.read`.
 */
export async function getCentralModelCatalog(options: CentralReadOptions): Promise<CentralModelCatalogResponse> {
  const response = await fetch(centralUrl(options.baseUrl, '/api/model-catalog'), {
    ...(centralHeaders(options) ? { headers: centralHeaders(options) } : {}),
  });
  if (!response.ok) throw new Error(`Central model-catalog request failed with HTTP ${response.status}`);
  return (await response.json()) as CentralModelCatalogResponse;
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

export async function updateQuest(questId: string, payload: UpdateQuestRequest): Promise<ApiResponse<UpdateQuestResponse>> {
  return fetchJson<UpdateQuestResponse>(`/api/quests/${encodeURIComponent(questId)}`, {
    method: 'PATCH',
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

export async function deleteQuest(questId: string): Promise<ApiResponse<DeleteQuestResponse>> {
  return fetchJson<DeleteQuestResponse>(`/api/quests/${encodeURIComponent(questId)}`, {
    method: 'DELETE',
  });
}

export async function runQuest(payload: QuestControlRequest = {}): Promise<ApiResponse<QuestControlResponse>> {
  return fetchJson<QuestControlResponse>('/api/quests/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function runQuestOnce(payload: QuestControlRequest = {}): Promise<ApiResponse<QuestControlResponse>> {
  return fetchJson<QuestControlResponse>('/api/quests/runonce', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function stopQuestRunner(): Promise<ApiResponse<QuestControlResponse>> {
  return fetchJson<QuestControlResponse>('/api/quests/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
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
