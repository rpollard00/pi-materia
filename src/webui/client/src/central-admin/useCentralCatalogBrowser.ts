import { useCallback, useEffect, useState } from 'react';
import { getCentralCatalogItem, getCentralCatalogItems } from './catalogApi.js';
import {
  CentralAdminRequestError,
  type CentralAdminRequester,
  type CentralAdminRequestFailure,
} from './api.js';
import type {
  CentralCatalogFilters,
  CentralCatalogItem,
  CentralCatalogItemSummary,
} from './catalogTypes.js';

export type CentralCatalogLoadStatus =
  | 'idle'
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'stale'
  | 'unauthorized'
  | 'forbidden'
  | 'unreachable';

export interface CentralCatalogCollectionState {
  readonly status: CentralCatalogLoadStatus;
  readonly items: readonly CentralCatalogItemSummary[];
  readonly error?: string;
  readonly errorKind?: CentralAdminRequestFailure;
  readonly lastLoadedAt?: number;
  readonly refresh: () => void;
}

export interface CentralCatalogItemState {
  readonly status: CentralCatalogLoadStatus;
  readonly item?: CentralCatalogItem;
  readonly itemKey?: string;
  readonly error?: string;
  readonly errorKind?: CentralAdminRequestFailure;
  readonly lastLoadedAt?: number;
  readonly refresh: () => void;
}

interface CollectionSnapshot extends Omit<CentralCatalogCollectionState, 'refresh'> {}
interface ItemSnapshot extends Omit<CentralCatalogItemState, 'refresh'> {}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function failure(error: unknown): { kind: CentralAdminRequestFailure; message: string } {
  if (error instanceof CentralAdminRequestError) return { kind: error.kind, message: error.message };
  return {
    kind: 'unreachable',
    message: error instanceof Error && error.message ? error.message : 'Unable to read the central catalog.',
  };
}

function failedStatus(kind: CentralAdminRequestFailure): CentralCatalogLoadStatus {
  return kind;
}

export function centralCatalogItemKey(item: Pick<CentralCatalogItemSummary, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

/**
 * Loads filtered catalog summaries while retaining the last successful
 * snapshot when a refresh fails. A retained snapshot is always marked stale.
 */
export function useCentralCatalogCollection(
  request: CentralAdminRequester,
  filters: CentralCatalogFilters,
): CentralCatalogCollectionState {
  const [refreshTick, setRefreshTick] = useState(0);
  const [state, setState] = useState<CollectionSnapshot>({ status: 'loading', items: [] });
  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({
      ...current,
      status: current.lastLoadedAt === undefined ? 'loading' : 'refreshing',
      error: undefined,
      errorKind: undefined,
    }));

    getCentralCatalogItems(request, filters, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setState({ status: 'ready', items, lastLoadedAt: Date.now() });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        const result = failure(error);
        setState((current) => current.lastLoadedAt === undefined
          ? { status: failedStatus(result.kind), items: [], error: result.message, errorKind: result.kind }
          : { ...current, status: 'stale', error: result.message, errorKind: result.kind });
      });

    return () => controller.abort();
  }, [filters.kind, filters.search, refreshTick, request]);

  return { ...state, refresh };
}

/**
 * Loads one complete definition. Changing selection never displays the prior
 * item's definition, while same-item refresh failures retain a marked snapshot.
 */
export function useCentralCatalogItem(
  request: CentralAdminRequester,
  summary: CentralCatalogItemSummary | undefined,
): CentralCatalogItemState {
  const [refreshTick, setRefreshTick] = useState(0);
  const [state, setState] = useState<ItemSnapshot>({ status: 'idle' });
  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);
  const id = summary?.id;
  const kind = summary?.kind;
  const version = summary?.version;

  useEffect(() => {
    if (id === undefined || kind === undefined) {
      setState({ status: 'idle' });
      return;
    }

    const key = centralCatalogItemKey({ id, kind });
    const controller = new AbortController();
    setState((current) => {
      const hasCurrentSnapshot = current.itemKey === key && current.item !== undefined;
      return {
        status: hasCurrentSnapshot ? 'refreshing' : 'loading',
        itemKey: key,
        ...(hasCurrentSnapshot ? { item: current.item, lastLoadedAt: current.lastLoadedAt } : {}),
      };
    });

    getCentralCatalogItem(request, kind, id, controller.signal)
      .then((item) => {
        if (controller.signal.aborted) return;
        setState({ status: 'ready', item, itemKey: key, lastLoadedAt: Date.now() });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        const result = failure(error);
        setState((current) => current.itemKey === key && current.item !== undefined
          ? { ...current, status: 'stale', error: result.message, errorKind: result.kind }
          : { status: failedStatus(result.kind), itemKey: key, error: result.message, errorKind: result.kind });
      });

    return () => controller.abort();
  }, [id, kind, refreshTick, request, version]);

  return { ...state, refresh };
}
