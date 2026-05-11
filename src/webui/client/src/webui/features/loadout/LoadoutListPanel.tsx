import { useState } from 'react';
import type { PipelineConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope } from '../../types.js';

export interface LoadoutListPanelProps {
  loadouts: Record<string, PipelineConfig>;
  activeLoadoutName: string | undefined;
  persistedActiveLoadoutName: string | undefined;
  persistedLoadouts: Record<string, PipelineConfig>;
  loadoutSources: Record<string, LoadoutSourceScope>;
  canDeleteLoadout: (name: string) => boolean;
  onCreateLoadout: () => void;
  onSwitchLoadout: (name: string) => void;
  onDeleteLoadout: (name: string) => void;
  onSetActiveLoadout: (name: string) => Promise<string>;
}

export function LoadoutListPanel({ loadouts, activeLoadoutName, persistedActiveLoadoutName, persistedLoadouts, loadoutSources, canDeleteLoadout, onCreateLoadout, onSwitchLoadout, onDeleteLoadout, onSetActiveLoadout }: LoadoutListPanelProps) {
  const [activeChangePending, setActiveChangePending] = useState(false);
  const [activeChangeMessage, setActiveChangeMessage] = useState('');
  const persistedNames = Object.keys(persistedLoadouts);

  async function changePersistedActiveLoadout(name: string) {
    if (!name || name === persistedActiveLoadoutName || activeChangePending) return;
    setActiveChangePending(true);
    setActiveChangeMessage(`Changing active loadout to ${name}…`);
    try {
      const activeName = await onSetActiveLoadout(name);
      setActiveChangeMessage(`Active loadout is now ${activeName}.`);
    } catch (error) {
      setActiveChangeMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActiveChangePending(false);
    }
  }

  return (
    <aside className="fantasy-panel loadout-side-panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">Loadouts</h2>
        <button className="materia-button" onClick={onCreateLoadout}>New</button>
      </div>
      <label className="mb-3 block text-xs uppercase tracking-[0.18em] text-cyan-200">
        Active loadout
        <select
          className="mt-1 w-full rounded-xl border border-cyan-200/20 bg-slate-950/80 px-3 py-2 text-sm normal-case tracking-normal text-cyan-100 disabled:opacity-60"
          value={persistedActiveLoadoutName ?? ''}
          disabled={activeChangePending || persistedNames.length === 0}
          onChange={(event) => void changePersistedActiveLoadout(event.target.value)}
          aria-label="Active loadout"
        >
          {persistedNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      {activeChangeMessage && <p className="mb-3 text-xs text-slate-300" role="status">{activeChangeMessage}</p>}
      <div className="space-y-2" role="list" aria-label="Available loadouts">
        {Object.keys(loadouts).map((name) => {
          const sourceScope = loadoutSources[name] ?? 'user';
          const defaultLoadout = sourceScope === 'default';
          const deleteDisabled = !canDeleteLoadout(name);
          return (
            <div key={name} className={`loadout-card ${name === activeLoadoutName ? 'loadout-card-active' : ''}`}>
              <button type="button" onClick={() => onSwitchLoadout(name)} className="loadout-card-select">
                <span>{name}</span>
                <small>{Object.keys(loadouts[name].sockets ?? {}).length} sockets · {defaultLoadout ? 'shipped default' : `${sourceScope} loadout`}</small>
              </button>
              <button
                type="button"
                className="loadout-delete-button"
                disabled={deleteDisabled}
                onClick={() => onDeleteLoadout(name)}
                title={defaultLoadout ? 'Shipped default loadouts cannot be deleted.' : deleteDisabled ? 'Create or keep another loadout before deleting this one.' : `Delete ${name}`}
                aria-label={defaultLoadout ? 'Protected default loadout' : 'Delete loadout'}
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
