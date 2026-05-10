import { useEffect, useRef, useState } from 'react';
import { getModels } from '../api/index.js';
import type { MateriaTabId, ModelCatalogLoadState, ModelCatalogResponse } from '../types.js';
import { emptyModelCatalog } from '../utils/modelCatalog.js';

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
    getModels().then((catalog) => {
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
