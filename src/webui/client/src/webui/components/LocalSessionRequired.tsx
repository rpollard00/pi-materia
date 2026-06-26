import type { ReactNode } from 'react';

export interface LocalSessionRequiredProps {
  /** Short headline for the unavailable surface (e.g. "Quests"). */
  title: string;
  /** Explanation shown beneath the headline. */
  description: ReactNode;
  /** Optional test id for assertions. */
  testId?: string;
}

/**
 * Notice rendered in place of local-session-only WebUI surfaces when backend
 * mode discovery reports no local session (`central-admin`). This is
 * presentation/guarding only — it does not modify the underlying
 * local-session/quest-board behavior
 * (docs/enterprise-control-plane.md §8, §9).
 *
 * The local UI and the purely local workflow remain first-class: this surface
 * only appears when discovery has authoritatively resolved a central-admin
 * topology (no attached local repository session).
 */
export function LocalSessionRequired({ title, description, testId }: LocalSessionRequiredProps) {
  return (
    <section
      className="fantasy-panel p-6"
      aria-label={`${title} unavailable without a local session`}
      data-testid={testId}
    >
      <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">local session required</p>
      <h2 className="mt-2 text-3xl font-black text-white">{title}</h2>
      <div className="mt-2 max-w-4xl text-sm text-slate-400">{description}</div>
    </section>
  );
}
