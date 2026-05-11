import { materiaTabs } from '../constants.js';
import type { MateriaTabId } from '../types.js';

export interface AppHeaderProps {
  source: string;
  isDirty: boolean;
}

export function AppHeader({ source, isDirty }: AppHeaderProps) {
  return (
    <header className="rounded-3xl border border-cyan-200/30 bg-slate-950/75 p-7 shadow-[0_0_55px_rgba(34,211,238,0.16)] backdrop-blur">
      <p className="text-sm uppercase tracking-[0.45em] text-cyan-200">pi-materia loadout editor</p>
      <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black tracking-tight text-white md:text-6xl">Materia WebUI</h1>
          <p className="mt-3 max-w-3xl text-slate-300">Stage loadout changes visually. Sockets and graph socket ids are preserved so inserted materia, layout, and socket-shift semantics stay intact until an explicit save.</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
          <div>Source: <span className="text-cyan-100">{source}</span></div>
          <div>Status: <span className={isDirty ? 'text-amber-200' : 'text-emerald-200'}>{isDirty ? 'staged edits' : 'clean'}</span></div>
        </div>
      </div>
    </header>
  );
}

export interface TabNavProps {
  selectedTab: MateriaTabId;
  onSelectTab: (tab: MateriaTabId) => void;
}

export function TabNav({ selectedTab, onSelectTab }: TabNavProps) {
  return (
    <nav className="materia-tab-bar" aria-label="Materia WebUI sections">
      {materiaTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`materia-tab ${selectedTab === tab.id ? 'materia-tab-active' : ''}`}
          aria-current={selectedTab === tab.id ? 'page' : undefined}
          aria-selected={selectedTab === tab.id}
          title={tab.description}
          onClick={() => onSelectTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
