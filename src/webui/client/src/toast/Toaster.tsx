import { useEffect } from 'react';
import { clearToastTimers, dismissToast, startToastTimers, toast, useToasts } from './store.js';
import { materiaToastEventName, type MateriaToastInput } from './types.js';

function isToastPayload(value: unknown): value is MateriaToastInput {
  return Boolean(
    value
      && typeof value === 'object'
      && 'title' in value
      && typeof (value as { title?: unknown }).title === 'string'
      && (value as { title: string }).title.trim().length > 0,
  );
}

export function Toaster() {
  const toasts = useToasts();

  useEffect(() => {
    startToastTimers();

    const handleToast = (event: WindowEventMap[typeof materiaToastEventName]) => {
      if (isToastPayload(event.detail)) toast(event.detail);
    };

    window.addEventListener(materiaToastEventName, handleToast);
    return () => {
      window.removeEventListener(materiaToastEventName, handleToast);
      clearToastTimers();
    };
  }, []);

  return (
    <section className="materia-toast-viewport" aria-live="polite" aria-label="Notifications">
      {toasts.map((item) => (
        <article
          key={item.id}
          className={`materia-toast materia-toast--${item.variant}`}
          data-toast-variant={item.variant}
          role={item.variant === 'error' || item.variant === 'validation' ? 'alert' : 'status'}
        >
          <div className="materia-toast__content">
            <h2 className="materia-toast__title">{item.title}</h2>
            {item.description && <p className="materia-toast__description">{item.description}</p>}
          </div>
          <button
            className="materia-toast__close"
            type="button"
            aria-label={`Dismiss notification: ${item.title}`}
            onClick={() => dismissToast(item.id)}
          >
            ×
          </button>
        </article>
      ))}
    </section>
  );
}
