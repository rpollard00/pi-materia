import type { ReactNode } from 'react';

export interface CentralAdminStatePanelProps {
  eyebrow: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  tone?: 'neutral' | 'warning' | 'danger';
  testId?: string;
}

/** Shared full-page state treatment for topology and authentication failures. */
export function CentralAdminStatePanel({
  eyebrow,
  title,
  description,
  actions,
  tone = 'neutral',
  testId,
}: CentralAdminStatePanelProps) {
  const accent = tone === 'danger'
    ? 'text-rose-200'
    : tone === 'warning'
      ? 'text-amber-200'
      : 'text-cyan-200';
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#14304a,#020617_58%)] px-6 py-12 text-slate-100">
      <section
        className="fantasy-panel mx-auto max-w-2xl p-8 md:p-10"
        aria-live="polite"
        data-testid={testId}
      >
        <p className={`text-xs font-black uppercase tracking-[0.38em] ${accent}`}>{eyebrow}</p>
        <h1 className="mt-3 text-3xl font-black text-white md:text-5xl">{title}</h1>
        <div className="mt-4 text-sm leading-6 text-slate-300">{description}</div>
        {actions ? <div className="mt-7 flex flex-wrap gap-3">{actions}</div> : null}
      </section>
    </main>
  );
}

export const centralAdminPrimaryButtonClass = 'rounded-full border border-cyan-200/50 bg-cyan-950/70 px-5 py-2.5 text-sm font-black text-cyan-50 transition hover:border-cyan-100 hover:bg-cyan-900/80';
export const centralAdminSecondaryButtonClass = 'rounded-full border border-white/15 bg-slate-900/70 px-5 py-2.5 text-sm font-bold text-slate-200 transition hover:border-white/30 hover:bg-slate-800';
