import { toast, type ToastVariant } from '../../toast/index.js';

export type LoadoutStatusToastIntent = ToastVariant | 'none';

export interface LoadoutStatusOptions {
  toast?: LoadoutStatusToastIntent;
  title?: string;
  id?: string;
}

export type SetLoadoutStatus = (message: string, options?: LoadoutStatusOptions | LoadoutStatusToastIntent) => void;

export function normalizeLoadoutStatusOptions(options?: LoadoutStatusOptions | LoadoutStatusToastIntent): LoadoutStatusOptions {
  if (!options) return { toast: 'none' };
  if (typeof options === 'string') return { toast: options };
  return { toast: options.toast ?? 'none', ...options };
}

export function defaultLoadoutStatusToastTitle(variant: ToastVariant): string {
  return variant === 'validation' ? 'Cannot stage loadout change' : 'Loadout update';
}

export function emitLoadoutStatusToast(message: string, options?: LoadoutStatusOptions | LoadoutStatusToastIntent): ToastVariant | undefined {
  const normalized = normalizeLoadoutStatusOptions(options);
  if (!normalized.toast || normalized.toast === 'none') return undefined;
  const variant = normalized.toast;
  toast({
    id: normalized.id ?? `loadout-status:${variant}:${message}`,
    title: normalized.title ?? defaultLoadoutStatusToastTitle(variant),
    description: message,
    variant,
  });
  return variant;
}
