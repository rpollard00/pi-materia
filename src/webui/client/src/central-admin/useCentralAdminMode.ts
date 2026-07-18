import { useCallback, useEffect, useState } from 'react';
import { CentralAdminRequestError, getCentralAdminBackendMode } from './api.js';
import type { CentralAdminBackendMode } from './types.js';

export type CentralAdminModeState =
  | { status: 'loading'; mode?: undefined; message?: undefined; retry: () => void }
  | { status: 'ready'; mode: CentralAdminBackendMode; message?: undefined; retry: () => void }
  | { status: 'unreachable' | 'incompatible'; mode?: undefined; message: string; retry: () => void };

function isStandaloneCentralMode(mode: CentralAdminBackendMode): boolean {
  return mode.ok === true
    && mode.mode === 'central-admin'
    && mode.hasCentral === true
    && mode.hasLocalSession === false
    && mode.endpoints?.local?.available !== true;
}

/** Resolve topology before any authenticated admin surface is mounted. */
export function useCentralAdminMode(): CentralAdminModeState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<CentralAdminModeState, 'retry'>>({ status: 'loading' });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    getCentralAdminBackendMode(controller.signal)
      .then((mode) => {
        if (controller.signal.aborted) return;
        if (!isStandaloneCentralMode(mode)) {
          setState({
            status: 'incompatible',
            message: 'This browser entry point requires a standalone central-admin server with no local session attached.',
          });
          return;
        }
        setState({ status: 'ready', mode });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof CentralAdminRequestError
          ? error.message
          : 'Unable to discover the central server mode.';
        setState({ status: 'unreachable', message });
      });
    return () => controller.abort();
  }, [attempt]);

  return { ...state, retry } as CentralAdminModeState;
}
