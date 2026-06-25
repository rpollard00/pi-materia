import { useCallback, useEffect, useRef, useState } from 'react';
import { getCentralModelCatalog, getCentralModelPolicy } from '../api/index.js';
import type {
  CentralModelCatalog,
  CentralModelPolicyDocument,
  CentralModelPolicyLoadState,
} from '../types.js';
import {
  normalizeCentralModelCatalogResponse,
  normalizeCentralModelPolicyResponse,
} from '../utils/centralModelPolicy.js';
import { centralAuthorizationHeader, readCentralDevToken, writeCentralDevToken } from '../utils/centralDevToken.js';

/**
 * Frontend hook for central model-policy/catalog reads
 * (docs/enterprise-control-plane.md §11).
 *
 * Reads central policy state **independently** from local Pi model
 * availability: the panel below the local model selector reflects what the
 * central control plane declares, not what the local runtime currently offers.
 * The hook only fetches when backend mode discovery reports a central control
 * plane with the `modelPolicy` capability and an absolute central base URL.
 *
 * Auth is the documented **development-only** bearer-token adapter today; the
 * token is resolved from browser storage and presented as `Authorization:
 * Bearer <token>`. OAuth/OIDC is a future adapter boundary and does not change
 * this hook's contract.
 *
 * The central read surface is informational at this stage: it surfaces central
 * policy/catalog state for display. Local model selection enforcement is a
 * separate concern (§16.14).
 */

export interface UseCentralModelPolicyParams {
  /** True when discovery reports a central control plane with modelPolicy capability. */
  enabled: boolean;
  /** Absolute central API base URL to read from. */
  baseUrl: string | undefined;
}

export interface CentralModelPolicyState {
  loadState: CentralModelPolicyLoadState;
  /** Id of the active central policy, when one is configured. */
  activePolicyId: string | undefined;
  /** Active central policy document, when one is configured. */
  policy: CentralModelPolicyDocument | undefined;
  /** Optional central model-catalog metadata, when configured. */
  catalog: CentralModelCatalog | undefined;
  /** Read error message, when the last fetch failed. */
  error: string | undefined;
  /** Current dev-stage central token (echoed back for the UI). */
  token: string;
  /** Persist a new dev-stage central token and refetch. Empty clears it. */
  setToken: (token: string) => void;
  /** Re-run the central reads. */
  reload: () => void;
}

const IDLE_STATE = {
  loadState: 'idle' as const,
  activePolicyId: undefined,
  policy: undefined,
  catalog: undefined,
  error: undefined,
};

export function useCentralModelPolicy({ enabled, baseUrl }: UseCentralModelPolicyParams): CentralModelPolicyState {
  const [token, setTokenState] = useState<string>(() => readCentralDevToken() ?? '');
  const [loadState, setLoadState] = useState<CentralModelPolicyLoadState>('idle');
  const [activePolicyId, setActivePolicyId] = useState<string | undefined>(undefined);
  const [policy, setPolicy] = useState<CentralModelPolicyDocument | undefined>(undefined);
  const [catalog, setCatalog] = useState<CentralModelCatalog | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // Bump to force a refetch (reload button).
  const [reloadTick, setReloadTick] = useState(0);
  // Track the in-flight request so a late resolution from a superseded fetch
  // (e.g. token changed mid-flight) does not overwrite newer state.
  const requestIdRef = useRef(0);

  const setToken = useCallback((next: string) => {
    writeCentralDevToken(next);
    setTokenState(next.trim());
  }, []);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  useEffect(() => {
    if (!enabled || !baseUrl) {
      setLoadState('idle');
      setActivePolicyId(undefined);
      setPolicy(undefined);
      setCatalog(undefined);
      setError(undefined);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoadState('loading');
    setError(undefined);

    const authorization = centralAuthorizationHeader(token) ?? undefined;
    const options = { baseUrl, ...(authorization ? { authorization } : {}) };

    Promise.all([getCentralModelPolicy(options), getCentralModelCatalog(options)])
      .then(([policyResponse, catalogResponse]) => {
        if (requestIdRef.current !== requestId) return;
        const normalizedPolicy = normalizeCentralModelPolicyResponse(policyResponse);
        const normalizedCatalog = normalizeCentralModelCatalogResponse(catalogResponse);
        setActivePolicyId(normalizedPolicy.activePolicyId);
        setPolicy(normalizedPolicy.policy);
        setCatalog(normalizedCatalog);
        setLoadState('ready');
        setError(undefined);
      })
      .catch((fetchError) => {
        if (requestIdRef.current !== requestId) return;
        setActivePolicyId(undefined);
        setPolicy(undefined);
        setCatalog(undefined);
        setLoadState('error');
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      });
  }, [enabled, baseUrl, token, reloadTick]);

  return {
    loadState,
    activePolicyId,
    policy,
    catalog,
    error,
    token,
    setToken,
    reload,
  };
}
