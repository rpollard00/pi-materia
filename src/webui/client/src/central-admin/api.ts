import { centralAuthorizationHeader } from '../webui/utils/centralDevToken.js';
import type {
  CentralAdminBackendMode,
  CentralAdminMetadata,
  CentralAdminMetadataEnvelope,
} from './types.js';

export type CentralAdminRequestFailure = 'unauthorized' | 'forbidden' | 'unreachable';

/** Protected route families exposed by the standalone central server. */
export type CentralAdminApiPath =
  | '/api/admin'
  | `/api/admin/${string}`
  | '/api/catalog'
  | `/api/catalog?${string}`
  | `/api/catalog/${string}`
  | '/api/model-policy'
  | `/api/model-policy/${string}`
  | '/api/model-catalog'
  | `/api/model-catalog/${string}`
  | '/api/telemetry'
  | `/api/telemetry/${string}`
  | '/api/status';

/** Authenticated request function shared with isolated central-admin features. */
export type CentralAdminRequester = <T>(path: CentralAdminApiPath, init?: RequestInit) => Promise<T>;

/** A presentation-safe central API failure shared by every admin surface. */
export class CentralAdminRequestError extends Error {
  readonly kind: CentralAdminRequestFailure;
  readonly status?: number;
  readonly responseBody?: unknown;

  constructor(kind: CentralAdminRequestFailure, message: string, status?: number, responseBody?: unknown) {
    super(message);
    this.name = 'CentralAdminRequestError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (responseBody !== undefined) this.responseBody = responseBody;
  }
}

function messageForStatus(status: number): string {
  if (status === 401) return 'The bearer credential was not accepted.';
  if (status === 403) return 'The bearer credential does not permit this central operation.';
  return `The central server returned HTTP ${status}.`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CentralAdminRequestError('unreachable', 'The central server returned an invalid response.', response.status);
  }
}

async function readOptionalErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Same-origin central request primitive. This module deliberately knows no
 * local-session routes; future catalog/policy/telemetry views share it and the
 * same bearer credential/error classification.
 */
export async function requestCentralAdminJson<T>(
  path: CentralAdminApiPath,
  credential: string,
  init: RequestInit = {},
): Promise<T> {
  const authorization = centralAuthorizationHeader(credential);
  const headers = new Headers(init.headers);
  if (authorization) headers.set('authorization', authorization);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new CentralAdminRequestError(
      'unreachable',
      error instanceof Error && error.message ? `Unable to reach the central server: ${error.message}` : 'Unable to reach the central server.',
    );
  }

  if (!response.ok) {
    const kind: CentralAdminRequestFailure = response.status === 401
      ? 'unauthorized'
      : response.status === 403
        ? 'forbidden'
        : 'unreachable';
    const responseBody = await readOptionalErrorBody(response);
    throw new CentralAdminRequestError(kind, messageForStatus(response.status), response.status, responseBody);
  }
  return (await readJson(response)) as T;
}

/** Public, credential-free topology discovery for the standalone entry point. */
export async function getCentralAdminBackendMode(signal?: AbortSignal): Promise<CentralAdminBackendMode> {
  let response: Response;
  try {
    response = await fetch('/api/backend-mode', signal === undefined ? undefined : { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new CentralAdminRequestError(
      'unreachable',
      error instanceof Error && error.message ? `Unable to reach the central server: ${error.message}` : 'Unable to reach the central server.',
    );
  }
  if (!response.ok) throw new CentralAdminRequestError('unreachable', messageForStatus(response.status), response.status);
  return (await readJson(response)) as CentralAdminBackendMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCentralAdminMetadata(value: unknown): value is CentralAdminMetadata {
  if (!isRecord(value) || !isRecord(value.server) || !Array.isArray(value.roles)) return false;
  const server = value.server;
  if (
    typeof server.service !== 'string'
    || typeof server.mode !== 'string'
    || typeof server.buildVersion !== 'string'
    || typeof server.schemaVersion !== 'number'
    || !isStringArray(server.authMethods)
    || (server.label !== undefined && typeof server.label !== 'string')
  ) return false;
  if (!value.roles.every((role) => isRecord(role)
    && typeof role.roleId === 'string'
    && (role.name === undefined || typeof role.name === 'string')
    && isStringArray(role.permissions))) return false;
  if (value.principals !== undefined && !Array.isArray(value.principals)) return false;
  if (value.access !== undefined && (!isRecord(value.access)
    || typeof value.access.principalId !== 'string'
    || !isStringArray(value.access.roleIds)
    || !isStringArray(value.access.permissions))) return false;
  return true;
}

/** Read and validate the metadata used to establish an admin session. */
export async function getCentralAdminMetadata(credential: string, signal?: AbortSignal): Promise<CentralAdminMetadata> {
  const body = await requestCentralAdminJson<CentralAdminMetadataEnvelope>(
    '/api/admin',
    credential,
    signal === undefined ? {} : { signal },
  );
  if (!body.ok || !isCentralAdminMetadata(body.metadata)) {
    throw new CentralAdminRequestError('unreachable', 'The central server returned an invalid admin metadata response.');
  }
  return body.metadata;
}
