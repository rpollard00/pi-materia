import { useEffect, useState } from 'react';
import { useCentralAdminAuth } from './CentralAdminAuth.js';
import { CentralCatalogBrowser } from './CentralCatalogBrowser.js';
import { centralAdminSecondaryButtonClass } from './CentralAdminStatePanel.js';
import { CENTRAL_ADMIN_SECTIONS, type CentralAdminMetadata, type CentralAdminSection } from './types.js';

type FeatureLandingSection = Exclude<CentralAdminSection, 'catalog' | 'server'>;

const SECTION_CONTENT: Record<FeatureLandingSection, { eyebrow: string; title: string; description: string }> = {
  policy: {
    eyebrow: 'Model governance',
    title: 'Model policy',
    description: 'Review and administer centrally published model-selection policy.',
  },
  telemetry: {
    eyebrow: 'Aggregate monitoring',
    title: 'Telemetry',
    description: 'Inspect retention-bounded events and status aggregated across connected runtimes.',
  },
};

const SECTION_LABELS: Record<CentralAdminSection, string> = {
  catalog: 'Catalog',
  policy: 'Policy',
  telemetry: 'Telemetry',
  server: 'Server information',
};

function sectionFromLocation(): CentralAdminSection {
  if (typeof window === 'undefined') return 'catalog';
  const section = new URL(window.location.href).searchParams.get('section');
  return CENTRAL_ADMIN_SECTIONS.includes(section as CentralAdminSection) ? section as CentralAdminSection : 'catalog';
}

function useCentralAdminNavigation() {
  const [section, setSection] = useState<CentralAdminSection>(() => sectionFromLocation());
  useEffect(() => {
    const onPopState = () => setSection(sectionFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const select = (next: CentralAdminSection) => {
    setSection(next);
    const url = new URL(window.location.href);
    url.searchParams.set('section', next);
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  };
  return { section, select };
}

function FeatureLanding({ section }: { section: FeatureLandingSection }) {
  const content = SECTION_CONTENT[section];
  return (
    <section className="fantasy-panel p-7" data-testid={`central-admin-${section}`}>
      <p className="text-xs font-black uppercase tracking-[0.35em] text-cyan-200">{content.eyebrow}</p>
      <h2 className="mt-3 text-3xl font-black text-white">{content.title}</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">{content.description}</p>
      <div className="mt-7 rounded-2xl border border-white/10 bg-slate-950/55 p-5 text-sm text-slate-400">
        This dedicated central surface is separate from local loadout editing, quests, active casts, and artifact monitoring.
      </div>
    </section>
  );
}

function MetadataValue({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/55 p-4">
      <dt className="text-xs font-bold uppercase tracking-[0.22em] text-slate-500">{label}</dt>
      <dd className="mt-2 break-words text-sm font-bold text-cyan-50">{value}</dd>
    </div>
  );
}

function ServerInformation({ metadata }: { metadata: CentralAdminMetadata }) {
  const { server } = metadata;
  return (
    <section className="fantasy-panel p-7" data-testid="central-admin-server">
      <p className="text-xs font-black uppercase tracking-[0.35em] text-cyan-200">Control plane</p>
      <h2 className="mt-3 text-3xl font-black text-white">Server information</h2>
      <dl className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetadataValue label="Service" value={server.service} />
        <MetadataValue label="Mode" value={server.mode} />
        <MetadataValue label="Build" value={server.buildVersion} />
        <MetadataValue label="Schema" value={server.schemaVersion} />
        <MetadataValue label="Authentication" value={server.authMethods.join(', ') || 'not reported'} />
        <MetadataValue label="Configured principals" value={metadata.principals?.length ?? 0} />
      </dl>
      <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/55 p-5">
        <h3 className="font-black text-white">Roles</h3>
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Configured central roles">
          {metadata.roles.map((role) => (
            <li key={role.roleId} className="rounded-full border border-violet-300/20 bg-violet-950/40 px-3 py-1.5 text-xs font-bold text-violet-100">
              {role.name ?? role.roleId}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Authenticated, standalone navigation shell. It imports no local WebUI hooks. */
export function CentralAdminShell() {
  const auth = useCentralAdminAuth();
  const { section, select } = useCentralAdminNavigation();
  if (!auth.metadata) return null;

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top,#14304a,#020617_58%)] text-slate-100">
      <section className="mx-auto flex min-h-screen w-full max-w-screen-2xl flex-col gap-6 px-6 py-8">
        <header className="rounded-3xl border border-cyan-200/30 bg-slate-950/75 p-7 shadow-[0_0_55px_rgba(34,211,238,0.16)] backdrop-blur">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.4em] text-cyan-200">pi-materia control plane</p>
              <h1 className="mt-3 text-4xl font-black tracking-tight text-white md:text-6xl">Central Admin</h1>
              <p className="mt-3 text-sm text-slate-400">Standalone administration · no local session</p>
            </div>
            <div className="flex flex-col items-start gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300 lg:items-end">
              <span>Server: <strong className="text-cyan-100">{auth.metadata.server.label ?? auth.metadata.server.service}</strong></span>
              <span className="text-emerald-200">Authenticated central access</span>
              <button type="button" className={centralAdminSecondaryButtonClass} onClick={auth.signOut}>Sign out</button>
            </div>
          </div>
        </header>

        <nav className="materia-tab-bar" aria-label="Central administration sections">
          {CENTRAL_ADMIN_SECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              className={`materia-tab ${section === item ? 'materia-tab-active' : ''}`}
              aria-current={section === item ? 'page' : undefined}
              onClick={() => select(item)}
            >
              {SECTION_LABELS[item]}
            </button>
          ))}
        </nav>

        {section === 'catalog'
          ? <CentralCatalogBrowser request={auth.request} />
          : section === 'server'
            ? <ServerInformation metadata={auth.metadata} />
            : <FeatureLanding section={section} />}
      </section>
    </main>
  );
}
