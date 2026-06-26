import type {
  CentralModelCatalog,
  CentralModelPolicyDocument,
  CentralModelPolicyModelRef,
  CentralModelPolicyThinkingConstraint,
} from '../../types.js';
import { thinkingLevelLabels } from '../../constants.js';
import type { CentralModelPolicyState } from '../../hooks/useCentralModelPolicy.js';

/**
 * Read-only display of central model-policy and model-catalog state
 * (docs/enterprise-control-plane.md §11).
 *
 * Renders what the central control plane declares, **independently** from local
 * Pi model availability: it reads `/api/model-policy` and `/api/model-catalog`
 * directly and never consults the local `/api/models` catalog. This surface is
 * informational display only; local selection enforcement is a separate concern
 * (§16.14). The panel is hidden by the caller unless backend mode discovery
 * reports a central control plane with the `modelPolicy` capability.
 *
 * Auth is the documented development-only bearer-token adapter today: the token
 * field presents a dev token to the central reads. OAuth/OIDC is a future
 * adapter boundary and does not change this display surface.
 */

export interface CentralModelPolicyPanelProps {
  state: CentralModelPolicyState;
  /** Absolute central API base URL being read. */
  centralApiBaseUrl: string | undefined;
  /** Whether the central endpoint is same-origin as the UI. */
  centralSameOrigin: boolean;
}

function thinkingLabel(level: string): string {
  return thinkingLevelLabels[level] ?? level;
}

function refLabel(ref: CentralModelPolicyModelRef): string {
  return ref.label ?? ref.value;
}

function joinRefs(refs: readonly CentralModelPolicyModelRef[] | undefined): string {
  if (!refs || refs.length === 0) return '—';
  return refs.map(refLabel).join(', ');
}

function describeThinkingConstraint(constraint: CentralModelPolicyThinkingConstraint | undefined): string {
  if (!constraint) return '—';
  const parts: string[] = [];
  if (constraint.allow && constraint.allow.length > 0) {
    parts.push(`allow: ${constraint.allow.map(thinkingLabel).join(', ')}`);
  }
  if (constraint.max) {
    parts.push(`max: ${thinkingLabel(constraint.max)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function PolicyDocumentView({ policy, activePolicyId }: { policy: CentralModelPolicyDocument; activePolicyId: string | undefined }) {
  const isActive = activePolicyId !== undefined && activePolicyId === policy.id;
  return (
    <dl className="central-model-policy-grid" data-testid="central-model-policy-document">
      <div><dt>Policy</dt><dd>{policy.name ?? policy.id}{isActive ? <span className="central-model-policy-active-badge">active</span> : null}</dd></div>
      {policy.description ? <div><dt>Description</dt><dd>{policy.description}</dd></div> : null}
      <div><dt>Severity</dt><dd>{policy.severity ?? 'enforced'}</dd></div>
      {policy.version ? <div><dt>Version</dt><dd>{policy.version}</dd></div> : null}
      {policy.updatedAt ? <div><dt>Updated</dt><dd>{policy.updatedAt}</dd></div> : null}
      <div><dt>Allow</dt><dd>{joinRefs(policy.allow)}</dd></div>
      <div><dt>Deny</dt><dd>{joinRefs(policy.deny)}</dd></div>
      <div><dt>Prefer</dt><dd>{joinRefs(policy.prefer)}</dd></div>
      <div><dt>Thinking</dt><dd>{describeThinkingConstraint(policy.thinking)}</dd></div>
    </dl>
  );
}

function CatalogView({ catalog }: { catalog: CentralModelCatalog }) {
  return (
    <div className="mt-4" data-testid="central-model-catalog">
      <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">central model catalog</p>
      {catalog.updatedAt ? <p className="mt-1 text-xs text-slate-500">Updated {catalog.updatedAt}</p> : null}
      <ul className="mt-2 flex flex-col gap-1 text-sm text-slate-300">
        {catalog.entries.map((entry) => (
          <li key={entry.value} className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-100">{entry.label ?? entry.value}</span>
            <code className="text-xs text-cyan-200">{entry.value}</code>
            {entry.vendor ? <span className="text-xs text-slate-500">· {entry.vendor}</span> : null}
            {entry.deprecated ? <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase text-amber-200">deprecated</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CentralModelPolicyPanel({ state, centralApiBaseUrl, centralSameOrigin }: CentralModelPolicyPanelProps) {
  const { loadState, activePolicyId, policy, catalog, error, token, setToken, reload } = state;
  const loading = loadState === 'loading';

  return (
    <section className="fantasy-panel p-6" aria-label="Central model policy" data-testid="central-model-policy-panel">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">central control plane</p>
          <h2 className="mt-2 text-2xl font-black text-white">Central model policy</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Model-policy and catalog metadata declared by the central control plane, read independently from local Pi model availability. Display only.
          </p>
          {centralApiBaseUrl ? (
            <p className="mt-1 text-xs text-slate-500">
              <code>{centralApiBaseUrl}</code> ·{' '}
              <span data-testid="central-model-policy-origin">{centralSameOrigin ? 'same-origin' : 'cross-origin'}</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            <span>Development central token (model-policy.read)</span>
            <input
              type="password"
              className="rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-slate-100"
              placeholder="dev-token-reader"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              data-testid="central-model-policy-token"
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className="rounded border border-cyan-200/30 bg-cyan-200/10 px-3 py-1 text-xs text-cyan-100 hover:bg-cyan-200/20 disabled:opacity-50"
            onClick={reload}
            disabled={loading}
            data-testid="central-model-policy-reload"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {loadState === 'error' ? (
        <p className="text-sm text-amber-200" data-testid="central-model-policy-error" role="alert">
          Could not read central model policy: {error ?? 'unknown error'}
        </p>
      ) : null}

      {loadState !== 'error' && loadState !== 'loading' && !policy ? (
        <p className="text-sm text-slate-400" data-testid="central-model-policy-empty">
          No active central model policy is configured.
        </p>
      ) : null}

      {policy ? <PolicyDocumentView policy={policy} activePolicyId={activePolicyId} /> : null}

      {catalog ? <CatalogView catalog={catalog} /> : null}
    </section>
  );
}
