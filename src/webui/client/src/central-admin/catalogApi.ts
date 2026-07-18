import { CentralAdminRequestError, type CentralAdminRequester } from './api.js';
import {
  CENTRAL_CATALOG_ITEM_KINDS,
  type CentralCatalogFilters,
  type CentralCatalogItem,
  type CentralCatalogItemKind,
  type CentralCatalogItemSummary,
  type CentralCatalogProvenance,
} from './catalogTypes.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCatalogKind(value: unknown): value is CentralCatalogItemKind {
  return typeof value === 'string' && (CENTRAL_CATALOG_ITEM_KINDS as readonly string[]).includes(value);
}

function invalidResponse(message: string): never {
  throw new CentralAdminRequestError('unreachable', `The central server returned an invalid catalog response: ${message}`);
}

function readSummary(value: unknown, path: string): CentralCatalogItemSummary {
  if (!isRecord(value)) invalidResponse(`${path} must be an object.`);
  if (!isNonEmptyString(value.id)) invalidResponse(`${path}.id must be a non-empty string.`);
  if (!isCatalogKind(value.kind)) invalidResponse(`${path}.kind must be loadout or materia.`);
  if (value.name !== undefined && typeof value.name !== 'string') invalidResponse(`${path}.name must be a string.`);
  if (value.description !== undefined && typeof value.description !== 'string') invalidResponse(`${path}.description must be a string.`);
  if (!isNonEmptyString(value.version)) invalidResponse(`${path}.version must be a non-empty string.`);
  if (!isNonEmptyString(value.updatedAt)) invalidResponse(`${path}.updatedAt must be a non-empty string.`);
  if (!isNonEmptyString(value.contentHash)) invalidResponse(`${path}.contentHash must be a non-empty string.`);
  if (value.provenance !== undefined && !isRecord(value.provenance)) invalidResponse(`${path}.provenance must be an object.`);

  return {
    id: value.id,
    kind: value.kind,
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.description !== undefined ? { description: value.description } : {}),
    version: value.version,
    updatedAt: value.updatedAt,
    contentHash: value.contentHash,
    ...(value.provenance !== undefined ? { provenance: value.provenance as CentralCatalogProvenance } : {}),
  };
}

/** Fetch and validate the catalog summary collection used by the browser. */
export async function getCentralCatalogItems(
  request: CentralAdminRequester,
  filters: CentralCatalogFilters,
  signal?: AbortSignal,
): Promise<CentralCatalogItemSummary[]> {
  const params = new URLSearchParams();
  if (filters.kind !== 'all') params.set('kind', filters.kind);
  const search = filters.search.trim();
  if (search) params.set('search', search);
  const query = params.toString();
  const path = query ? `/api/catalog?${query}` as const : '/api/catalog';
  const body = await request<unknown>(path, signal === undefined ? undefined : { signal });
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.items)) {
    invalidResponse('the list envelope must contain ok: true and an items array.');
  }
  return body.items.map((item, index) => readSummary(item, `items[${index}]`));
}

/** Fetch and validate one full central catalog definition. */
export async function getCentralCatalogItem(
  request: CentralAdminRequester,
  kind: CentralCatalogItemKind,
  id: string,
  signal?: AbortSignal,
): Promise<CentralCatalogItem> {
  const path = `/api/catalog/${kind}/${encodeURIComponent(id)}` as const;
  const body = await request<unknown>(path, signal === undefined ? undefined : { signal });
  if (!isRecord(body) || body.ok !== true || !isRecord(body.item)) {
    invalidResponse('the item envelope must contain ok: true and an item object.');
  }
  const summary = readSummary(body.item, 'item');
  if (!isRecord(body.item.content) || !isRecord(body.item.content.definition)) {
    invalidResponse('item.content.definition must be an object.');
  }
  return {
    ...summary,
    content: { definition: body.item.content.definition },
  };
}
