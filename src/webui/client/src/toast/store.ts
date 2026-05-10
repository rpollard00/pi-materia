import { useSyncExternalStore } from 'react';
import { materiaToastEventName, toastVariants, type MateriaToast, type MateriaToastInput, type ToastVariant } from './types.js';

const DEFAULT_DURATION_MS = 5000;
const MAX_TOASTS = 5;

let nextToastId = 1;
let toasts: MateriaToast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, number>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return toasts;
}

function getServerSnapshot() {
  return [];
}

function isToastVariant(value: unknown): value is ToastVariant {
  return typeof value === 'string' && (toastVariants as readonly string[]).includes(value);
}

function normalizeDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

export function defaultToast(input: MateriaToastInput): MateriaToast {
  const variant = isToastVariant(input.variant) ? input.variant : 'info';
  const explicitDurationMs = normalizeDurationMs(input.durationMs);
  const persistent = input.persistent ?? (explicitDurationMs === undefined && (variant === 'error' || variant === 'validation'));
  const durationMs = persistent ? undefined : explicitDurationMs ?? DEFAULT_DURATION_MS;

  return {
    id: input.id?.trim() || `toast:${nextToastId++}`,
    title: input.title,
    description: input.description,
    variant,
    persistent,
    durationMs,
    createdAt: Date.now(),
  };
}

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
}

function scheduleToast(toastValue: MateriaToast) {
  clearTimer(toastValue.id);
  if (toastValue.durationMs === undefined) return;

  const remainingDurationMs = toastValue.durationMs - (Date.now() - toastValue.createdAt);
  if (remainingDurationMs <= 0) {
    dismissToast(toastValue.id);
    return;
  }

  timers.set(
    toastValue.id,
    window.setTimeout(() => dismissToast(toastValue.id), remainingDurationMs),
  );
}

function trimToLimit(items: MateriaToast[]) {
  if (items.length <= MAX_TOASTS) return items;
  const removed = items.slice(0, items.length - MAX_TOASTS);
  removed.forEach((item) => clearTimer(item.id));
  return items.slice(-MAX_TOASTS);
}

export function toast(input: MateriaToastInput) {
  const toastValue = defaultToast(input);
  const index = toasts.findIndex((item) => item.id === toastValue.id);
  if (index >= 0) {
    const next = [...toasts];
    next[index] = toastValue;
    toasts = next;
  } else {
    toasts = trimToLimit([...toasts, toastValue]);
  }
  scheduleToast(toastValue);
  emitChange();
  return toastValue.id;
}

export function dismissToast(id: string) {
  if (!toasts.some((item) => item.id === id)) return;
  clearTimer(id);
  toasts = toasts.filter((item) => item.id !== id);
  emitChange();
}

export function clearToastTimers() {
  timers.forEach((timer) => window.clearTimeout(timer));
  timers.clear();
}

export function startToastTimers() {
  toasts.forEach((toastValue) => scheduleToast(toastValue));
}

export function clearToasts() {
  clearToastTimers();
  if (toasts.length === 0) return;
  toasts = [];
  emitChange();
}

/**
 * Dispatch a WebUI toast from anywhere that can access the browser window.
 *
 * materia:toast detail contract:
 * - fields: { id?, title, description?, variant?, durationMs?, persistent? }
 * - variants: info, success, warning, error, validation
 * - default lifecycle: info/success/warning auto-dismiss; error/validation persist unless durationMs is supplied
 * - id behavior: reusing an id replaces the existing toast instead of appending a duplicate
 *
 * Example: window.dispatchEvent(new CustomEvent('materia:toast', { detail: { id: 'save', title: 'Saved', variant: 'success' } })).
 */
export function dispatchMateriaToast(input: MateriaToastInput) {
  window.dispatchEvent(new CustomEvent<MateriaToastInput>(materiaToastEventName, { detail: input }));
}

export function useToasts() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function resetToastStoreForTests() {
  clearToasts();
  nextToastId = 1;
}
