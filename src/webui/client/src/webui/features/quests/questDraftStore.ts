import { useSyncExternalStore } from 'react';

/**
 * Stable, page-level owner for the "new quest" create-form draft.
 *
 * The quest workspace panel unmounts when the user switches Materia tabs (see
 * AppShell), which discards any component-local textarea state. Keeping the
 * draft in a module-level store lets the create form rehydrate the exact
 * prompt/override the user was typing after navigating away and back without a
 * browser refresh.
 *
 * Scope: the draft lives for the active browser session (page load) and is
 * scoped to the create form. Edit-form state stays component-local so drafts
 * never leak between unrelated quest contexts.
 */

export interface QuestDraftValues {
  prompt: string;
  loadoutOverride: string;
}

export const emptyQuestDraft: QuestDraftValues = { prompt: '', loadoutOverride: '' };

let draft: QuestDraftValues = emptyQuestDraft;
const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return draft;
}

function getServerSnapshot() {
  return emptyQuestDraft;
}

function sameDraftValues(left: QuestDraftValues, right: QuestDraftValues) {
  return left.prompt === right.prompt && left.loadoutOverride === right.loadoutOverride;
}

/** Replace the entire draft. No-op (no listener churn) when values are unchanged. */
export function setQuestDraft(values: QuestDraftValues) {
  if (sameDraftValues(draft, values)) return;
  draft = { prompt: values.prompt, loadoutOverride: values.loadoutOverride };
  emitChange();
}

/** Clear the draft, used on successful submit, explicit clear, or context change. */
export function clearQuestDraft() {
  if (sameDraftValues(draft, emptyQuestDraft)) return;
  draft = { ...emptyQuestDraft };
  emitChange();
}

/** Subscribe a component to the current draft. Re-renders on every change. */
export function useQuestDraft() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Reset the module-level store between tests. */
export function resetQuestDraftStoreForTests() {
  draft = { ...emptyQuestDraft };
  emitChange();
}
