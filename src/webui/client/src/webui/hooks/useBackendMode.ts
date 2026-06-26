import { useCallback, useEffect, useState } from 'react';
import { getBackendMode } from '../api/index.js';
import type { BackendControlPlaneMode, BackendModeCapabilities, BackendModeEndpointDescriptor, BackendModeResponse } from '../types.js';

/**
 * Frontend hook for WebUI backend mode discovery
 * (docs/enterprise-control-plane.md §8).
 *
 * Fetches `GET /api/backend-mode` once on mount and exposes a normalized view
 * of the connection topology so the frontend can render central
 * catalog/model-policy/admin state separately from local runtime/session state.
 *
 * The backend cannot observe the browser origin, so {@link normalizeBackendModeResponse}
 * recomputes `centralSameOrigin` authoritatively from `window.location.origin`.
 * This hook exposes discovery only; guarding local-only controls in central
 * mode is a separate concern (docs/enterprise-control-plane.md §8, §9).
 */

export type BackendModeLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface NormalizedBackendModeCapabilities {
  catalog: boolean;
  modelPolicy: boolean;
  telemetry: boolean;
  admin: boolean;
}

export interface NormalizedBackendModeEndpoint {
  available: boolean;
  sameOrigin: boolean;
  baseUrl: string;
}

/** Normalized connection topology/capability data, independent of load state. */
export interface BackendModeData {
  mode: BackendControlPlaneMode;
  hasLocalSession: boolean;
  hasCentral: boolean;
  centralApiBaseUrl: string | undefined;
  /** Same-origin status of the central endpoint, computed from the browser origin. */
  centralSameOrigin: boolean;
  capabilities: NormalizedBackendModeCapabilities;
  local: NormalizedBackendModeEndpoint;
  central: NormalizedBackendModeEndpoint;
  label: string | undefined;
}

export interface BackendModeState extends BackendModeData {
  loadState: BackendModeLoadState;
  error: string | undefined;
  reload: () => void;
}

const LOCAL_ONLY_CAPABILITIES: NormalizedBackendModeCapabilities = { catalog: false, modelPolicy: false, telemetry: false, admin: false };

const DEFAULT_DATA: BackendModeData = {
  mode: 'local-only',
  hasLocalSession: true,
  hasCentral: false,
  centralApiBaseUrl: undefined,
  centralSameOrigin: false,
  capabilities: LOCAL_ONLY_CAPABILITIES,
  local: { available: true, sameOrigin: true, baseUrl: '' },
  central: { available: false, sameOrigin: false, baseUrl: '' },
  label: undefined,
};

function isBackendMode(value: string | undefined): value is BackendControlPlaneMode {
  return value === 'local-only' || value === 'central-connected' || value === 'central-admin';
}

function normalizeCapabilities(raw: BackendModeCapabilities | undefined): NormalizedBackendModeCapabilities {
  if (!raw) return { ...LOCAL_ONLY_CAPABILITIES };
  return {
    catalog: raw.catalog === true,
    modelPolicy: raw.modelPolicy === true,
    telemetry: raw.telemetry === true,
    admin: raw.admin === true,
  };
}

function normalizeEndpoint(raw: BackendModeEndpointDescriptor | undefined, fallback: NormalizedBackendModeEndpoint): NormalizedBackendModeEndpoint {
  if (!raw) return { ...fallback };
  return {
    available: raw.available === true,
    sameOrigin: raw.sameOrigin === true,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : fallback.baseUrl,
  };
}

/**
 * Resolve the browser origin for same-origin comparison. Centralized so tests
 * can stub `window.location` and the helper degrades safely when `window` or
 * `location` is unavailable (e.g. non-DOM test environments).
 */
function readBrowserOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const origin = (window.location as { origin?: string } | undefined)?.origin;
  return typeof origin === 'string' && origin.length > 0 ? origin : undefined;
}

/**
 * True when a central base URL shares an origin with the given local origin.
 * Pure and side-effect free so it is unit-testable without a DOM.
 */
export function isCentralSameOriginFromBrowser(centralApiBaseUrl: string | undefined, localOrigin: string | undefined): boolean {
  if (!centralApiBaseUrl || !localOrigin) return false;
  let centralOrigin: string;
  try {
    centralOrigin = new URL(centralApiBaseUrl).origin;
  } catch {
    return false;
  }
  try {
    return new URL(localOrigin).origin === centralOrigin;
  } catch {
    return false;
  }
}

/**
 * Normalize a raw backend mode response into the stable frontend view. Pure and
 * side-effect free; `localOrigin` defaults to the browser origin so callers can
 * inject a known origin in tests.
 */
export function normalizeBackendModeResponse(raw: BackendModeResponse | undefined, localOrigin: string | undefined = readBrowserOrigin()): BackendModeData {
  const mode: BackendControlPlaneMode = raw && isBackendMode(raw.mode) ? raw.mode : 'local-only';
  const hasLocalSession = raw?.hasLocalSession === true || raw?.hasLocalSession === undefined;
  const centralApiBaseUrl = typeof raw?.centralApiBaseUrl === 'string' && raw.centralApiBaseUrl.trim() ? raw.centralApiBaseUrl.trim() : undefined;
  const hasCentral = raw?.hasCentral === true || centralApiBaseUrl !== undefined;
  const centralSameOrigin = isCentralSameOriginFromBrowser(centralApiBaseUrl, localOrigin);
  const centralBaseDefault = centralApiBaseUrl ?? '';
  return {
    mode,
    hasLocalSession,
    hasCentral,
    centralApiBaseUrl,
    centralSameOrigin,
    capabilities: normalizeCapabilities(raw?.capabilities),
    local: normalizeEndpoint(raw?.endpoints?.local, { available: hasLocalSession, sameOrigin: true, baseUrl: '' }),
    central: normalizeEndpoint(raw?.endpoints?.central, { available: hasCentral, sameOrigin: centralSameOrigin, baseUrl: centralBaseDefault }),
    label: typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined,
  };
}

/**
 * Fetch and expose backend mode discovery. Discovery is read once on mount and
 * re-fetched on {@link BackendModeState.reload}; central reachability is not
 * polled here (later work items own live central state).
 */
export function useBackendMode(): BackendModeState {
  const [data, setData] = useState<BackendModeData>(DEFAULT_DATA);
  const [loadState, setLoadState] = useState<BackendModeLoadState>('idle');
  const [error, setError] = useState<string | undefined>(undefined);

  const run = useCallback(() => {
    setLoadState('loading');
    setError(undefined);
    getBackendMode()
      .then((body) => {
        setData(normalizeBackendModeResponse(body));
        setLoadState('ready');
        setError(undefined);
      })
      .catch((fetchError) => {
        // Discovery failure must never block the local-only workflow; fall back
        // to local-only defaults so the UI keeps working.
        setData(DEFAULT_DATA);
        setLoadState('error');
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      });
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  const reload = useCallback(() => {
    run();
  }, [run]);

  return { ...data, loadState, error, reload };
}
