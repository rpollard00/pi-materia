import { useMemo, useState, type FormEvent } from 'react';
import type { CentralAdminRequester, CentralAdminRequestFailure } from './api.js';
import type {
  CentralCatalogFilters,
  CentralCatalogItem,
  CentralCatalogItemKind,
  CentralCatalogItemSummary,
  CentralCatalogKindFilter,
  CentralCatalogProvenance,
} from './catalogTypes.js';
import {
  centralCatalogItemKey,
  useCentralCatalogCollection,
  useCentralCatalogItem,
  type CentralCatalogLoadStatus,
} from './useCentralCatalogBrowser.js';

const refreshButtonClass = 'rounded-full border border-cyan-200/30 bg-cyan-950/50 px-4 py-2 text-xs font-black text-cyan-50 transition hover:border-cyan-100/70 hover:bg-cyan-900/60 disabled:cursor-wait disabled:opacity-50';
const fieldClass = 'rounded-xl border border-white/15 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-200/70';

function kindLabel(kind: CentralCatalogItemKind): string {
  return kind === 'loadout' ? 'Loadout' : 'Materia';
}

function kindDescription(kind: CentralCatalogItemKind): string {
  return kind === 'loadout' ? 'Pipeline definition' : 'Agent-role definition';
}

function KindBadge({ kind }: { kind: CentralCatalogItemKind }) {
  const palette = kind === 'loadout'
    ? 'border-violet-300/30 bg-violet-950/55 text-violet-100'
    : 'border-cyan-300/30 bg-cyan-950/55 text-cyan-100';
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[0.65rem] font-black uppercase tracking-[0.18em] ${palette}`}>
      {kindLabel(kind)}
    </span>
  );
}

function CatalogFilters({
  filters,
  onChange,
}: {
  filters: CentralCatalogFilters;
  onChange: (filters: CentralCatalogFilters) => void;
}) {
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onChange({ ...filters, search: searchDraft });
  };
  const clear = () => {
    setSearchDraft('');
    onChange({ ...filters, search: '' });
  };

  return (
    <form className="mt-6 grid gap-3 rounded-2xl border border-white/10 bg-slate-950/55 p-4 md:grid-cols-[minmax(10rem,0.35fr)_minmax(16rem,1fr)_auto] md:items-end" onSubmit={submit} role="search">
      <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
        Kind
        <select
          aria-label="Catalog kind"
          className={fieldClass}
          value={filters.kind}
          onChange={(event) => onChange({ ...filters, kind: event.target.value as CentralCatalogKindFilter })}
        >
          <option value="all">All definitions</option>
          <option value="loadout">Loadouts</option>
          <option value="materia">Materia</option>
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
        Search name or id
        <input
          type="search"
          className={fieldClass}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder="Search the central catalog"
        />
      </label>
      <div className="flex gap-2">
        <button type="submit" className={refreshButtonClass}>Search</button>
        {filters.search ? <button type="button" className={refreshButtonClass} onClick={clear}>Clear</button> : null}
      </div>
    </form>
  );
}

function failureTitle(kind: CentralAdminRequestFailure | undefined): string {
  if (kind === 'forbidden') return 'Catalog permission required';
  if (kind === 'unauthorized') return 'Catalog credential rejected';
  return 'Central catalog unavailable';
}

function failureDescription(kind: CentralAdminRequestFailure | undefined, error: string | undefined): string {
  if (kind === 'forbidden') return 'This credential can open the admin shell but does not have catalog.read permission.';
  if (kind === 'unauthorized') return 'The central server no longer accepts this bearer credential. Sign out and connect with a reader or administrator credential.';
  return error ?? 'The central server did not return the catalog.';
}

function CatalogFailure({
  kind,
  error,
  onRetry,
}: {
  kind?: CentralAdminRequestFailure;
  error?: string;
  onRetry: () => void;
}) {
  const isPermissionError = kind === 'forbidden' || kind === 'unauthorized';
  return (
    <div
      className={`rounded-2xl border p-6 ${isPermissionError ? 'border-amber-300/30 bg-amber-950/20' : 'border-rose-300/25 bg-rose-950/20'}`}
      role="alert"
      data-testid={isPermissionError ? 'central-catalog-permission-error' : 'central-catalog-error'}
    >
      <h3 className="font-black text-white">{failureTitle(kind)}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-300">{failureDescription(kind, error)}</p>
      <button type="button" className={`${refreshButtonClass} mt-4`} onClick={onRetry}>Retry catalog</button>
    </div>
  );
}

function StaleNotice({ kind, error, noun = 'catalog snapshot' }: { kind?: CentralAdminRequestFailure; error?: string; noun?: string }) {
  return (
    <div className="rounded-xl border border-amber-300/30 bg-amber-950/25 px-4 py-3 text-sm text-amber-100" role="status" data-testid={`central-catalog-stale-${noun === 'definition' ? 'definition' : 'list'}`}>
      <strong>Stale {noun}.</strong>{' '}
      {kind === 'forbidden'
        ? 'The latest refresh was denied because this credential lacks catalog.read permission.'
        : kind === 'unauthorized'
          ? 'The credential was rejected during the latest refresh.'
          : error ?? 'The latest refresh did not complete.'}
      {' '}Showing the last successfully loaded central data.
    </div>
  );
}

function CatalogList({
  items,
  selectedKey,
  onSelect,
}: {
  items: readonly CentralCatalogItemSummary[];
  selectedKey: string | undefined;
  onSelect: (key: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Central catalog items">
      {items.map((item) => {
        const key = centralCatalogItemKey(item);
        const selected = key === selectedKey;
        return (
          <li key={key}>
            <button
              type="button"
              className={`w-full rounded-2xl border p-4 text-left transition ${selected ? 'border-cyan-200/60 bg-cyan-950/35 shadow-[0_0_20px_rgba(34,211,238,0.12)]' : 'border-white/10 bg-slate-950/55 hover:border-white/25 hover:bg-slate-900/70'}`}
              aria-pressed={selected}
              onClick={() => onSelect(key)}
              data-testid={`central-catalog-item-${item.kind}-${item.id}`}
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <KindBadge kind={item.kind} />
                <span className="text-xs font-bold text-slate-500">v{item.version}</span>
              </span>
              <span className="mt-3 block truncate font-black text-white">{item.name || item.id}</span>
              {item.name ? <code className="mt-1 block truncate text-xs text-cyan-200/80">{item.id}</code> : null}
              <span className="mt-2 block text-xs text-slate-500">{kindDescription(item.kind)}</span>
              {item.description ? <span className="mt-2 line-clamp-2 block text-sm leading-5 text-slate-400">{item.description}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

function ProvenanceView({ provenance }: { provenance: CentralCatalogProvenance | undefined }) {
  const entries = provenance ? Object.entries(provenance) : [];
  if (entries.length === 0) return <span className="text-slate-500">Not reported</span>;
  return (
    <dl className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="central-catalog-provenance">
      {entries.map(([key, value]) => (
        <div key={key} className="min-w-0 rounded-lg border border-white/8 bg-black/20 px-3 py-2">
          <dt className="text-[0.65rem] font-bold uppercase tracking-[0.15em] text-slate-500">{key}</dt>
          <dd className="mt-1 break-words text-xs text-cyan-50">{valueText(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function MetadataValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-slate-950/45 p-3">
      <dt className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-500">{label}</dt>
      <dd className="mt-1.5 break-words text-sm text-slate-200">{children}</dd>
    </div>
  );
}

function CatalogDefinition({ item }: { item: CentralCatalogItem }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <KindBadge kind={item.kind} />
          <h3 className="mt-3 break-words text-2xl font-black text-white">{item.name || item.id}</h3>
          <p className="mt-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">{kindDescription(item.kind)}</p>
          {item.description ? <p className="mt-3 text-sm leading-6 text-slate-300">{item.description}</p> : null}
        </div>
        <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-xs font-black text-slate-300">Version {item.version}</span>
      </div>

      <dl className="mt-6 grid gap-3 sm:grid-cols-2">
        <MetadataValue label="Central id"><code>{item.id}</code></MetadataValue>
        <MetadataValue label="Kind">{kindLabel(item.kind)}</MetadataValue>
        <MetadataValue label="Updated"><time dateTime={item.updatedAt}>{item.updatedAt}</time></MetadataValue>
        <MetadataValue label="Version">{item.version}</MetadataValue>
        <div className="sm:col-span-2"><MetadataValue label="Content hash"><code className="break-all text-xs text-cyan-100" data-testid="central-catalog-content-hash">{item.contentHash}</code></MetadataValue></div>
        <div className="sm:col-span-2">
          <MetadataValue label="Provenance"><ProvenanceView provenance={item.provenance} /></MetadataValue>
        </div>
      </dl>

      <div className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.25em] text-cyan-200">Definition inspection</p>
            <h4 className="mt-1 text-lg font-black text-white">Definition JSON</h4>
          </div>
          <span className="text-xs text-slate-500">Read-only</span>
        </div>
        <pre className="mt-3 max-h-[32rem] overflow-auto rounded-2xl border border-white/10 bg-black/45 p-4 text-xs leading-6 text-cyan-50" aria-label={`${kindLabel(item.kind)} definition JSON`} data-testid="central-catalog-definition">{JSON.stringify(item.content.definition, null, 2)}</pre>
      </div>
    </>
  );
}

function DetailFailure({ status, error, onRetry }: { status: CentralCatalogLoadStatus; error?: string; onRetry: () => void }) {
  const kind = status === 'forbidden' || status === 'unauthorized' ? status : undefined;
  return <CatalogFailure kind={kind} error={error} onRetry={onRetry} />;
}

/** Read-only central catalog list and definition inspector. */
export function CentralCatalogBrowser({ request }: { request: CentralAdminRequester }) {
  const [filters, setFilters] = useState<CentralCatalogFilters>({ kind: 'all', search: '' });
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const collection = useCentralCatalogCollection(request, filters);
  const selected = useMemo(() => (
    collection.items.find((item) => centralCatalogItemKey(item) === selectedKey) ?? collection.items[0]
  ), [collection.items, selectedKey]);
  const effectiveSelectedKey = selected ? centralCatalogItemKey(selected) : undefined;
  const detail = useCentralCatalogItem(request, selected);
  const detailIsCurrent = detail.itemKey === effectiveSelectedKey;
  const item = detailIsCurrent ? detail.item : undefined;
  const detailStatus = detailIsCurrent ? detail.status : 'loading';
  const loading = collection.status === 'loading';
  const refreshing = collection.status === 'refreshing';
  const hasCollectionFailure = ['unauthorized', 'forbidden', 'unreachable'].includes(collection.status);
  const filtered = filters.kind !== 'all' || filters.search.trim().length > 0;
  const loadoutCount = collection.items.filter((entry) => entry.kind === 'loadout').length;
  const materiaCount = collection.items.length - loadoutCount;

  const refreshAll = () => {
    collection.refresh();
    if (selected) detail.refresh();
  };

  return (
    <section className="fantasy-panel p-5 md:p-7" data-testid="central-admin-catalog" aria-busy={loading || refreshing}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.35em] text-cyan-200">Central catalog</p>
          <h2 className="mt-3 text-3xl font-black text-white">Catalog</h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">Browse centrally managed loadout and materia definitions. This surface is read-only and never writes local configuration.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-emerald-300/20 bg-emerald-950/35 px-3 py-1.5 text-xs font-bold text-emerald-100" data-testid="central-catalog-read-only">Read-only browsing</span>
          <button type="button" className={refreshButtonClass} onClick={refreshAll} disabled={loading || refreshing}>{loading || refreshing ? 'Refreshing…' : 'Refresh catalog'}</button>
        </div>
      </div>

      <CatalogFilters filters={filters} onChange={setFilters} />

      {collection.status === 'stale' ? <div className="mt-4"><StaleNotice kind={collection.errorKind} error={collection.error} /></div> : null}
      {loading ? (
        <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/45 p-8 text-center text-sm text-slate-300" role="status" data-testid="central-catalog-loading">Loading central catalog…</div>
      ) : null}
      {hasCollectionFailure ? (
        <div className="mt-6"><CatalogFailure kind={collection.errorKind} error={collection.error} onRetry={collection.refresh} /></div>
      ) : null}

      {!loading && !hasCollectionFailure && collection.items.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-white/15 bg-slate-950/35 p-8 text-center" data-testid="central-catalog-empty">
          <h3 className="font-black text-white">{filtered ? 'No matching definitions' : 'The central catalog is empty'}</h3>
          <p className="mt-2 text-sm text-slate-400">{filtered ? 'Try a different kind or search term.' : 'Published loadouts and materia will appear here.'}</p>
        </div>
      ) : null}

      {!loading && !hasCollectionFailure && collection.items.length > 0 ? (
        <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,0.38fr)_minmax(0,1fr)]">
          <aside className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/35 p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-black text-white">Definitions <span className="text-slate-500">({collection.items.length})</span></h3>
              <span className="text-xs text-slate-500">{loadoutCount} loadout · {materiaCount} materia</span>
            </div>
            <CatalogList items={collection.items} selectedKey={effectiveSelectedKey} onSelect={setSelectedKey} />
          </aside>

          <article className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/35 p-4 md:p-6" aria-busy={detailStatus === 'loading' || detailStatus === 'refreshing'}>
            <div className="mb-4 flex justify-end">
              <button type="button" className={refreshButtonClass} onClick={detail.refresh} disabled={detailStatus === 'loading' || detailStatus === 'refreshing'}>{detailStatus === 'loading' || detailStatus === 'refreshing' ? 'Loading definition…' : 'Refresh definition'}</button>
            </div>
            {detailStatus === 'stale' ? <div className="mb-4"><StaleNotice noun="definition" kind={detail.errorKind} error={detail.error} /></div> : null}
            {detailStatus === 'loading' && !item ? <p className="py-12 text-center text-sm text-slate-300" role="status" data-testid="central-catalog-detail-loading">Loading definition…</p> : null}
            {(detailStatus === 'unauthorized' || detailStatus === 'forbidden' || detailStatus === 'unreachable') && !item
              ? <DetailFailure status={detailStatus} error={detail.error} onRetry={detail.refresh} />
              : null}
            {item ? <CatalogDefinition item={item} /> : null}
          </article>
        </div>
      ) : null}
    </section>
  );
}
