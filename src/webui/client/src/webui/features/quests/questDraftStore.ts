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
 * Context scoping: the draft is bound to the active quest board context
 * (`boardPath`). Tab navigation keeps the same context, so the draft survives.
 * When the active board context changes to a different, known board the stored
 * draft is treated as stale and the form rehydrates empty so text from the
 * previous context never leaks. A board path that resolves from "unknown"
 * (still loading) to a concrete value adopts the in-progress draft instead of
 * discarding it, so the first board load never wipes text being typed.
 *
 * Reset policy: the draft is cleared only by an explicit reset — successful
 * submission (`clearQuestDraft`), the user emptying the input, or the active
 * board context changing. Tab unmount/remount never clears it.
 */

export interface QuestDraftValues {
  prompt: string;
  loadoutOverride: string;
}

export const emptyQuestDraft: QuestDraftValues = { prompt: '', loadoutOverride: '' };

interface QuestDraftRecord {
  contextKey: string;
  values: QuestDraftValues;
}

/** Empty/whitespace/undefined context keys collapse to "" (treated as unknown). */
function normalizeContextKey(contextKey: string | undefined): string {
  return typeof contextKey === 'string' ? contextKey.trim() : '';
}

function isUnknownContext(contextKey: string): boolean {
  return contextKey === '';
}

function sameDraftValues(left: QuestDraftValues, right: QuestDraftValues) {
  return left.prompt === right.prompt && left.loadoutOverride === right.loadoutOverride;
}

function copyValues(values: QuestDraftValues): QuestDraftValues {
  return { prompt: values.prompt, loadoutOverride: values.loadoutOverride };
}

let record: QuestDraftRecord = { contextKey: '', values: { ...emptyQuestDraft } };
const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Snapshot for a given context key.
 *
 * - Matching context: the stored draft.
 * - Unknown on either side (board path still loading, or unstated): adopt the
 *   stored draft so resolving the board path after mount never discards text
 *   the user is typing.
 * - Two different concrete contexts: the stored draft belongs to a different
 *   quest board, so return empty rather than leaking stale text.
 */
function snapshotForContext(contextKey: string): QuestDraftValues {
  if (record.contextKey === contextKey) return record.values;
  if (isUnknownContext(contextKey) || isUnknownContext(record.contextKey)) return record.values;
  return emptyQuestDraft;
}

function getServerSnapshot() {
  return emptyQuestDraft;
}

/**
 * Replace the draft for the active context. The incoming context becomes the
 * stored context. When the context genuinely changed between two known boards,
 * `snapshotForContext` already returned empty for the new context, so this
 * overwrite discards the previous board's draft rather than carrying it over.
 */
export function setQuestDraft(contextKey: string | undefined, values: QuestDraftValues) {
  const key = normalizeContextKey(contextKey);
  if (record.contextKey === key) {
    if (sameDraftValues(record.values, values)) return;
    record = { contextKey: key, values: copyValues(values) };
    emitChange();
    return;
  }
  record = { contextKey: key, values: copyValues(values) };
  emitChange();
}

/** Clear the draft for the active context (used on successful submit or explicit clear). */
export function clearQuestDraft() {
  if (sameDraftValues(record.values, emptyQuestDraft)) return;
  record = { ...record, values: { ...emptyQuestDraft } };
  emitChange();
}

/** Subscribe a component to the draft for the given context. Re-renders on change. */
export function useQuestDraft(contextKey?: string) {
  const key = normalizeContextKey(contextKey);
  return useSyncExternalStore(subscribe, () => snapshotForContext(key), getServerSnapshot);
}

/** Reset the module-level store between tests. */
export function resetQuestDraftStoreForTests() {
  record = { contextKey: '', values: { ...emptyQuestDraft } };
  emitChange();
}
