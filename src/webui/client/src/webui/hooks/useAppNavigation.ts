import { useEffect, useState } from 'react';
import type { MateriaTabId } from '../types.js';
import { tabFromLocation } from '../utils/tabs.js';

export interface AppNavigationController {
  selectedTab: MateriaTabId;
  selectTab: (tabId: MateriaTabId) => void;
}

export function useAppNavigation(): AppNavigationController {
  const [selectedTab, setSelectedTab] = useState<MateriaTabId>(() => tabFromLocation());

  useEffect(() => {
    const handlePopState = () => setSelectedTab(tabFromLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function selectTab(tabId: MateriaTabId) {
    setSelectedTab(tabId);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tabId);
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  return { selectedTab, selectTab };
}
