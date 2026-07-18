import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { readCentralBearerToken, writeCentralBearerToken } from '../webui/utils/centralDevToken.js';
import {
  CentralAdminRequestError,
  getCentralAdminMetadata,
  requestCentralAdminJson,
  type CentralAdminApiPath,
  type CentralAdminRequestFailure,
  type CentralAdminRequester,
} from './api.js';
import type { CentralAdminMetadata } from './types.js';

export type CentralAdminAuthStatus =
  | 'signed-out'
  | 'checking'
  | 'authenticated'
  | CentralAdminRequestFailure;

export interface CentralAdminAuthState {
  status: CentralAdminAuthStatus;
  metadata?: CentralAdminMetadata;
  message?: string;
  authenticate: (credential: string) => void;
  retry: () => void;
  signOut: () => void;
  /** Shared authenticated transport for all central-admin feature surfaces. */
  request: CentralAdminRequester;
}

const CentralAdminAuthContext = createContext<CentralAdminAuthState | undefined>(undefined);

/**
 * Owns the bearer credential and authenticated metadata for the whole admin
 * application. Feature views consume this provider instead of maintaining
 * independent credentials or interpreting HTTP failures differently.
 */
export function CentralAdminAuthProvider({ children }: { children: ReactNode }) {
  const [credential, setCredential] = useState(() => readCentralBearerToken() ?? '');
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<CentralAdminAuthStatus>(() => credential ? 'checking' : 'signed-out');
  const [metadata, setMetadata] = useState<CentralAdminMetadata | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    if (!credential) {
      setStatus('signed-out');
      setMetadata(undefined);
      setMessage(undefined);
      return;
    }

    const controller = new AbortController();
    setStatus('checking');
    setMetadata(undefined);
    setMessage(undefined);
    getCentralAdminMetadata(credential, controller.signal)
      .then((nextMetadata) => {
        if (controller.signal.aborted) return;
        writeCentralBearerToken(credential);
        setMetadata(nextMetadata);
        setStatus('authenticated');
        setMessage(undefined);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = error instanceof CentralAdminRequestError ? error.kind : 'unreachable';
        // Do not repeatedly replay credentials the server has definitively
        // rejected. Keep unreachable credentials so a temporary outage can be
        // retried without asking the operator to re-enter them.
        if (failure === 'unauthorized' || failure === 'forbidden') writeCentralBearerToken('');
        setStatus(failure);
        setMetadata(undefined);
        setMessage(error instanceof Error ? error.message : 'Unable to establish the central admin session.');
      });
    return () => controller.abort();
  }, [credential, attempt]);

  const authenticate = useCallback((nextCredential: string) => {
    const normalized = nextCredential.trim();
    if (!normalized) {
      writeCentralBearerToken('');
      setCredential('');
      return;
    }
    setCredential(normalized);
    setAttempt((value) => value + 1);
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const signOut = useCallback(() => {
    writeCentralBearerToken('');
    setCredential('');
    setMetadata(undefined);
    setMessage(undefined);
    setStatus('signed-out');
  }, []);

  const request = useCallback(<T,>(path: CentralAdminApiPath, init?: RequestInit) => {
    if (!credential) {
      return Promise.reject(new CentralAdminRequestError('unauthorized', 'Enter a bearer credential to access the central server.'));
    }
    return requestCentralAdminJson<T>(path, credential, init);
  }, [credential]);

  const value = useMemo<CentralAdminAuthState>(() => ({
    status,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(message !== undefined ? { message } : {}),
    authenticate,
    retry,
    signOut,
    request,
  }), [authenticate, message, metadata, request, retry, signOut, status]);

  return <CentralAdminAuthContext.Provider value={value}>{children}</CentralAdminAuthContext.Provider>;
}

export function useCentralAdminAuth(): CentralAdminAuthState {
  const state = useContext(CentralAdminAuthContext);
  if (!state) throw new Error('useCentralAdminAuth must be used within CentralAdminAuthProvider');
  return state;
}
