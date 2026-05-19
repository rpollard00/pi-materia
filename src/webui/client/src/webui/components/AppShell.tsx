import type { ReactNode } from 'react';
import type { MateriaTabId } from '../types.js';
import { Toaster } from '../../toast/index.js';
import { AppHeader, TabNav } from './AppChrome.js';

export interface AppShellProps {
  source: string;
  isDirty: boolean;
  status: string;
  selectedTab: MateriaTabId;
  onSelectTab: (tab: MateriaTabId) => void;
  loadoutWorkspace: ReactNode;
  materiaEditorWorkspace: ReactNode;
  questWorkspace: ReactNode;
  monitorWorkspace: ReactNode;
}

export function AppShell({
  source,
  isDirty,
  status,
  selectedTab,
  onSelectTab,
  loadoutWorkspace,
  materiaEditorWorkspace,
  questWorkspace,
  monitorWorkspace,
}: AppShellProps) {
  return (
    <>
      <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top,#14304a,#020617_58%)] text-slate-100">
        <section className="mx-auto flex min-h-screen w-full max-w-screen-2xl flex-col gap-6 px-6 py-8">
          <AppHeader source={source} isDirty={isDirty} status={status} />

          <TabNav selectedTab={selectedTab} onSelectTab={onSelectTab} />

          {selectedTab === 'loadout' && loadoutWorkspace}

          {selectedTab === 'materia-editor' && materiaEditorWorkspace}

          {selectedTab === 'quests' && questWorkspace}

          {selectedTab === 'monitor' && monitorWorkspace}
        </section>
      </main>
      <Toaster />
    </>
  );
}
