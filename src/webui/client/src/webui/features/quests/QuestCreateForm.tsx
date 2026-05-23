import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { PipelineConfig } from '../../../loadoutModel.js';
import type { AddQuestRequest, AddQuestResponse, UpdateQuestRequest, UpdateQuestResponse } from '../../types.js';
import { toast } from '../../../toast/index.js';
import { QuestDefaultLoadoutSelector } from './QuestDefaultLoadoutSelector.js';

export interface QuestDefaultLoadoutProps {
  questDefaultLoadoutId: string | null;
  questDefaultLoadoutWarning?: string;
  setQuestDefaultLoadout: (loadoutId: string | null) => Promise<string | null>;
}

export interface QuestFormValues {
  prompt: string;
  loadoutOverride: string;
}

type QuestFormMode = 'create' | 'edit';

interface QuestFormProps {
  mode: QuestFormMode;
  persistedLoadouts: Record<string, PipelineConfig>;
  initialValues: QuestFormValues;
  submitLabel: string;
  submittingLabel: string;
  headingKicker: string;
  headingTitle: string;
  headingDescription: string;
  disabled?: boolean;
  submitting?: boolean;
  statusMessage?: string;
  errorMessage?: string;
  onCancel?: () => void;
  onSubmit: (values: QuestFormValues) => Promise<void> | void;
  questDefaultLoadoutProps?: QuestDefaultLoadoutProps;
}

interface QuestCreateFormProps extends QuestDefaultLoadoutProps {
  persistedLoadouts: Record<string, PipelineConfig>;
  onAddQuest: (payload: AddQuestRequest) => Promise<AddQuestResponse | undefined>;
  submitting: boolean;
}

interface QuestEditFormProps {
  persistedLoadouts: Record<string, PipelineConfig>;
  initialValues: QuestFormValues;
  onUpdateQuest: (payload: UpdateQuestRequest) => Promise<UpdateQuestResponse | undefined>;
  onCancel: () => void;
  submitting: boolean;
  questTitle?: string;
}

function questCreatedLabel(response: AddQuestResponse): string {
  const quest = response.quest;
  return quest?.title || quest?.id || 'new quest';
}

function questUpdatedLabel(response: UpdateQuestResponse, fallback?: string): string {
  const quest = response.quest;
  return quest?.title || quest?.id || fallback || 'quest';
}

export function QuestForm({ mode, persistedLoadouts, initialValues, submitLabel, submittingLabel, headingKicker, headingTitle, headingDescription, disabled = false, submitting = false, statusMessage, errorMessage, onCancel, onSubmit, questDefaultLoadoutProps }: QuestFormProps) {
  const [loadoutOverride, setLoadoutOverride] = useState(initialValues.loadoutOverride);
  const [prompt, setPrompt] = useState(initialValues.prompt);
  const formDisabled = disabled || submitting;
  const titleId = mode === 'edit' ? 'quest-edit-title' : 'quest-create-title';
  const loadoutId = mode === 'edit' ? 'quest-edit-loadout-override' : 'quest-loadout-override';
  const promptId = mode === 'edit' ? 'quest-edit-prompt' : 'quest-prompt';

  useEffect(() => {
    setLoadoutOverride(initialValues.loadoutOverride);
    setPrompt(initialValues.prompt);
  }, [initialValues.loadoutOverride, initialValues.prompt]);

  const loadoutOptions = useMemo(() => Object.entries(persistedLoadouts)
    .sort(([left], [right]) => left.localeCompare(right)), [persistedLoadouts]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (formDisabled) return;
    await onSubmit({ prompt, loadoutOverride });
  };

  return (
    <form className="quest-create-form fantasy-panel" aria-labelledby={titleId} onSubmit={handleSubmit}>
      <div className="quest-create-heading">
        <div>
          <p className="quest-kicker">{headingKicker}</p>
          <h3 id={titleId}>{headingTitle}</h3>
          <p>{headingDescription}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {onCancel ? (
            <button className="quest-refresh-button" type="button" disabled={formDisabled} onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button className="quest-submit-button" type="submit" disabled={formDisabled}>
            {submitting ? submittingLabel : submitLabel}
          </button>
        </div>
      </div>

      <div className="quest-create-fields">
        <div className="quest-create-controls">
          {questDefaultLoadoutProps ? (
            <QuestDefaultLoadoutSelector
              persistedLoadouts={persistedLoadouts}
              questDefaultLoadoutId={questDefaultLoadoutProps.questDefaultLoadoutId}
              questDefaultLoadoutWarning={questDefaultLoadoutProps.questDefaultLoadoutWarning}
              setQuestDefaultLoadout={questDefaultLoadoutProps.setQuestDefaultLoadout}
            />
          ) : null}

          <label className="quest-form-field" htmlFor={loadoutId}>
            <span>Loadout override</span>
            <select
              id={loadoutId}
              value={loadoutOverride}
              onChange={(event) => setLoadoutOverride(event.target.value)}
              disabled={formDisabled}
            >
              <option value="">No override — use quest default, then active fallback</option>
              {loadoutOptions.map(([name, loadout]) => (
                <option key={name} value={name}>{loadout.id && loadout.id !== name ? `${name} (${loadout.id})` : name}</option>
              ))}
            </select>
            <span className="mt-1 block text-[0.68rem] normal-case tracking-normal text-slate-400">
              Leave blank to use the quest default runner loadout. If the quest default is cleared or unavailable, the runner falls back to the active loadout.
            </span>
          </label>
        </div>

        <label className="quest-form-field quest-prompt-field" htmlFor={promptId}>
          <span>Prompt</span>
          <textarea
            id={promptId}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={formDisabled}
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

export function QuestCreateForm({ persistedLoadouts, questDefaultLoadoutId, questDefaultLoadoutWarning, setQuestDefaultLoadout, onAddQuest, submitting }: QuestCreateFormProps) {
  const [formKey, setFormKey] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async ({ prompt, loadoutOverride }: QuestFormValues) => {
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
    setFormKey((value) => value + 1);
    setStatusMessage(message);
    toast({
      id: `quest-add-success:${response.quest?.id ?? createdLabel}`,
      title: 'Quest added',
      description: createdLabel,
      variant: 'success',
    });
  };

  return (
    <QuestForm
      key={formKey}
      mode="create"
      persistedLoadouts={persistedLoadouts}
      initialValues={{ prompt: '', loadoutOverride: '' }}
      submitLabel="Add quest"
      submittingLabel="Adding…"
      headingKicker="New Quest"
      headingTitle="Add to the quest log"
      headingDescription="Append a pending quest for the runner to pick up. This does not change your active, regular default, or quest default loadout."
      submitting={submitting}
      statusMessage={statusMessage}
      errorMessage={errorMessage}
      onSubmit={handleSubmit}
      questDefaultLoadoutProps={{ questDefaultLoadoutId, questDefaultLoadoutWarning, setQuestDefaultLoadout }}
    />
  );
}

export function QuestEditForm({ persistedLoadouts, initialValues, onUpdateQuest, onCancel, submitting, questTitle }: QuestEditFormProps) {
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    setStatusMessage('');
    setErrorMessage('');
  }, [initialValues.prompt, initialValues.loadoutOverride]);

  const handleSubmit = async ({ prompt, loadoutOverride }: QuestFormValues) => {
    if (submitting) return;

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setStatusMessage('');
      setErrorMessage('Enter a quest prompt before saving changes.');
      return;
    }

    setStatusMessage('');
    setErrorMessage('');
    const response = await onUpdateQuest(loadoutOverride
      ? { prompt: trimmedPrompt, loadoutOverride }
      : { prompt: trimmedPrompt });
    if (!response?.ok) {
      setErrorMessage('Quest could not be updated. Check the quest board status and try again.');
      return;
    }

    const updatedLabel = questUpdatedLabel(response, questTitle);
    setStatusMessage(`Updated quest: ${updatedLabel}`);
    toast({
      id: `quest-update-success:${response.quest?.id ?? updatedLabel}`,
      title: 'Quest updated',
      description: updatedLabel,
      variant: 'success',
    });
    onCancel();
  };

  return (
    <QuestForm
      mode="edit"
      persistedLoadouts={persistedLoadouts}
      initialValues={initialValues}
      submitLabel="Save quest"
      submittingLabel="Saving…"
      headingKicker="Edit Quest"
      headingTitle={questTitle ? `Edit ${questTitle}` : 'Edit pending quest'}
      headingDescription="Update the prompt or loadout override before the runner starts this pending quest."
      submitting={submitting}
      statusMessage={statusMessage}
      errorMessage={errorMessage}
      onCancel={onCancel}
      onSubmit={handleSubmit}
    />
  );
}
