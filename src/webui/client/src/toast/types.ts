export const materiaToastEventName = 'materia:toast' as const;

export const toastVariants = ['info', 'success', 'warning', 'error', 'validation'] as const;

export type ToastVariant = (typeof toastVariants)[number];

export interface MateriaToastInput {
  id?: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
  persistent?: boolean;
}

export interface MateriaToast extends Required<Pick<MateriaToastInput, 'id' | 'title' | 'variant' | 'persistent'>> {
  description?: string;
  durationMs?: number;
  createdAt: number;
}

declare global {
  interface WindowEventMap {
    [materiaToastEventName]: CustomEvent<MateriaToastInput>;
  }
}
