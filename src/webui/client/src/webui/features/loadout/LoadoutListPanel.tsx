import type { PipelineConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope } from '../../types.js';

export interface LoadoutListPanelProps {
  loadouts: Record<string, PipelineConfig>;
  activeLoadoutName: string | undefined;
  loadoutSources: Record<string, LoadoutSourceScope>;
  canDeleteLoadout: (name: string) => boolean;
  onCreateLoadout: () => void;
  onSwitchLoadout: (name: string) => void;
  onDeleteLoadout: (name: string) => void;
}

export function LoadoutListPanel({ loadouts, activeLoadoutName, loadoutSources, canDeleteLoadout, onCreateLoadout, onSwitchLoadout, onDeleteLoadout }: LoadoutListPanelProps) {
  return (
    <aside className="fantasy-panel loadout-side-panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">Loadouts</h2>
        <button className="materia-button" onClick={onCreateLoadout}>New</button>
      </div>
      <div className="space-y-2" role="list" aria-label="Available loadouts">
        {Object.keys(loadouts).map((name) => {
          const sourceScope = loadoutSources[name] ?? 'user';
          const defaultLoadout = sourceScope === 'default';
          const deleteDisabled = !canDeleteLoadout(name);
          return (
            <div key={name} className={`loadout-card ${name === activeLoadoutName ? 'loadout-card-active' : ''}`}>
              <button type="button" onClick={() => onSwitchLoadout(name)} className="loadout-card-select">
                <span>{name}</span>
                <small>{Object.keys(loadouts[name].nodes ?? {}).length} sockets · {defaultLoadout ? 'shipped default' : `${sourceScope} loadout`}</small>
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
