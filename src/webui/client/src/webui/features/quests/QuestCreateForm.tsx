import { useMemo, useState, type FormEvent } from 'react';
import type { PipelineConfig } from '../../../loadoutModel.js';
import type { AddQuestRequest, AddQuestResponse } from '../../types.js';
import { toast } from '../../../toast/index.js';

interface QuestCreateFormProps {
  persistedLoadouts: Record<string, PipelineConfig>;
  onAddQuest: (payload: AddQuestRequest) => Promise<AddQuestResponse | undefined>;
  submitting: boolean;
}

function questCreatedLabel(response: AddQuestResponse): string {
  const quest = response.quest;
  return quest?.title || quest?.id || 'new quest';
}

export function QuestCreateForm({ persistedLoadouts, onAddQuest, submitting }: QuestCreateFormProps) {
  const [loadoutOverride, setLoadoutOverride] = useState('');
  const [prompt, setPrompt] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const loadoutOptions = useMemo(() => Object.entries(persistedLoadouts)
    .sort(([left], [right]) => left.localeCompare(right)), [persistedLoadouts]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setStatusMessage('');
      setErrorMessage('Enter a quest prompt before adding it to the log.');
      return;
    }

    setStatusMessage('');
    setErrorMessage('');
    const payload: AddQuestRequest = loadoutOverride
      ? { prompt: trimmedPrompt, loadoutOverride }
      : { prompt: trimmedPrompt };
    const response = await onAddQuest(payload);
    if (!response?.ok) {
      setErrorMessage('Quest could not be added. Check the quest board status and try again.');
      return;
    }

    const createdLabel = questCreatedLabel(response);
    const message = `Added quest: ${createdLabel}`;
    setPrompt('');
    setStatusMessage(message);
    toast({
      id: `quest-add-success:${response.quest?.id ?? createdLabel}`,
      title: 'Quest added',
      description: createdLabel,
      variant: 'success',
    });
  };

  return (
    <form className="quest-create-form fantasy-panel" aria-labelledby="quest-create-title" onSubmit={handleSubmit}>
      <div className="quest-create-heading">
        <div>
          <p className="quest-kicker">New Quest</p>
          <h3 id="quest-create-title">Add to the quest log</h3>
          <p>Append a pending quest for the runner to pick up. This does not change your active or default loadout.</p>
        </div>
        <button className="quest-submit-button" type="submit" disabled={submitting}>
          {submitting ? 'Adding…' : 'Add quest'}
        </button>
      </div>

      <div className="quest-create-fields">
        <label className="quest-form-field" htmlFor="quest-loadout-override">
          <span>Loadout override</span>
          <select
            id="quest-loadout-override"
            value={loadoutOverride}
            onChange={(event) => setLoadoutOverride(event.target.value)}
            disabled={submitting}
          >
            <option value="">No override / default runner loadout</option>
            {loadoutOptions.map(([name, loadout]) => (
              <option key={name} value={name}>{loadout.id && loadout.id !== name ? `${name} (${loadout.id})` : name}</option>
            ))}
          </select>
        </label>

        <label className="quest-form-field quest-prompt-field" htmlFor="quest-prompt">
          <span>Prompt</span>
          <textarea
            id="quest-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={submitting}
            rows={4}
            placeholder="Describe the quest objective…"
          />
        </label>
      </div>

      {statusMessage ? <p className="quest-create-status" role="status" aria-live="polite">{statusMessage}</p> : null}
      {errorMessage ? <p className="quest-create-error" role="alert">{errorMessage}</p> : null}
    </form>
  );
}
