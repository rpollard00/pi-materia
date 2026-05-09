import { useEffect, useRef, useState } from 'react';
import type { MateriaTabId, ModelCatalogLoadState, ModelCatalogResponse } from '../types.js';
import { emptyModelCatalog, normalizeModelCatalog } from '../utils/modelCatalog.js';

async function fetchModelCatalog(): Promise<ModelCatalogResponse> {
  const response = await fetch('/api/models');
  if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}`);
  return normalizeModelCatalog(await response.json());
}

export function useModelCatalog(selectedTab: MateriaTabId) {
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResponse>(() => emptyModelCatalog());
  const [modelCatalogStatus, setModelCatalogStatus] = useState<ModelCatalogLoadState>('idle');
  const [modelCatalogError, setModelCatalogError] = useState('');
  const modelCatalogRequestedRef = useRef(false);

  useEffect(() => {
    if (selectedTab !== 'materia-editor' || modelCatalogRequestedRef.current) return;
    modelCatalogRequestedRef.current = true;
    setModelCatalogStatus('loading');
    setModelCatalogError('');
    fetchModelCatalog().then((catalog) => {
      setModelCatalog(catalog);
      setModelCatalogStatus('ready');
    }).catch((error) => {
      setModelCatalog(emptyModelCatalog());
      setModelCatalogStatus('error');
      setModelCatalogError(error instanceof Error ? error.message : String(error));
    });
  }, [selectedTab]);

  return { modelCatalog, modelCatalogStatus, modelCatalogError };
}
