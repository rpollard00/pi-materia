import { useMemo, useState } from 'react';
import type { PipelineConfig } from '../../../loadoutModel.js';

const CLEAR_QUEST_DEFAULT_VALUE = '__quest-default-loadout-clear__';

export interface QuestDefaultLoadoutSelectorProps {
  persistedLoadouts: Record<string, PipelineConfig>;
  questDefaultLoadoutId: string | null;
  questDefaultLoadoutWarning?: string;
  setQuestDefaultLoadout: (loadoutId: string | null) => Promise<string | null>;
}

export function QuestDefaultLoadoutSelector({ persistedLoadouts, questDefaultLoadoutId, questDefaultLoadoutWarning, setQuestDefaultLoadout }: QuestDefaultLoadoutSelectorProps) {
  const [pending, setPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const loadoutOptions = useMemo(() => Object.entries(persistedLoadouts)
    .filter(([, loadout]) => Boolean(loadout.id))
    .sort(([left], [right]) => left.localeCompare(right)), [persistedLoadouts]);
  const hasPersistedLoadouts = loadoutOptions.length > 0;

  async function handleChange(selectedValue: string, selectedLabel?: string) {
    const nextLoadoutId = selectedValue === CLEAR_QUEST_DEFAULT_VALUE ? null : selectedValue;
    if (nextLoadoutId === questDefaultLoadoutId || pending) return;

    setPending(true);
    setErrorMessage('');
    setStatusMessage(nextLoadoutId ? `Setting quest default loadout to ${selectedLabel ?? nextLoadoutId}…` : 'Clearing quest default loadout; quests will fall back to the active loadout…');

    try {
      const savedDefault = await setQuestDefaultLoadout(nextLoadoutId);
      setStatusMessage(savedDefault
        ? `Quest default loadout set to ${selectedLabel ?? savedDefault}.`
        : 'Quest default loadout cleared. Quests will fall back to the active loadout unless they specify an override.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage('');
      setErrorMessage(`Quest default loadout could not be changed: ${message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <label className="quest-form-field" htmlFor="quest-default-loadout">
      <span>Quest default loadout</span>
      <select
        id="quest-default-loadout"
        value={questDefaultLoadoutId ?? CLEAR_QUEST_DEFAULT_VALUE}
        onChange={(event) => void handleChange(event.target.value, event.currentTarget.selectedOptions[0]?.textContent ?? undefined)}
        disabled={pending || !hasPersistedLoadouts}
        aria-label="Quest default loadout"
        title="Quest runner default. Per-quest overrides still take precedence; clearing falls back to the active loadout."
      >
        <option value={CLEAR_QUEST_DEFAULT_VALUE}>Cleared — use active loadout fallback</option>
        {loadoutOptions.map(([name, loadout]) => (
          <option key={loadout.id} value={loadout.id}>{name}</option>
        ))}
      </select>
      <span className="mt-1 block text-[0.68rem] normal-case tracking-normal text-slate-400">
        Choose the loadout quests use by default. Per-quest overrides below still take precedence.
      </span>
      {!hasPersistedLoadouts ? <span className="mt-1 block text-[0.68rem] normal-case tracking-normal text-slate-400">Save a loadout before choosing a quest default; quests currently fall back to the active loadout.</span> : null}
      {(statusMessage || questDefaultLoadoutWarning) ? <span className="mt-1 block text-xs normal-case tracking-normal text-slate-300" role="status" aria-live="polite">{statusMessage || questDefaultLoadoutWarning}</span> : null}
      {errorMessage ? <span className="mt-1 block text-xs normal-case tracking-normal text-rose-200" role="alert">{errorMessage}</span> : null}
    </label>
  );
}
