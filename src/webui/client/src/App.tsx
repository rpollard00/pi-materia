const sockets = [
  { id: 'plan', name: 'Plan', color: 'from-sky-300 to-blue-600' },
  { id: 'build', name: 'Build', color: 'from-emerald-300 to-green-700' },
  { id: 'check', name: 'Check', color: 'from-amber-200 to-orange-600' },
  { id: 'maintain', name: 'Maintain', color: 'from-fuchsia-300 to-purple-700' },
];

export function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-10">
        <header className="rounded-3xl border border-cyan-300/30 bg-slate-900/80 p-8 shadow-[0_0_40px_rgba(34,211,238,0.16)]">
          <p className="text-sm uppercase tracking-[0.45em] text-cyan-200">pi-materia</p>
          <h1 className="mt-3 text-4xl font-black tracking-tight text-white md:text-6xl">Materia WebUI</h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-300">
            Session-scoped loadout, graph, and monitoring workspace for the upcoming <code>/materia ui</code> command.
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-3xl border border-white/10 bg-slate-900/70 p-6">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-2xl font-bold">Loadout grid</h2>
              <span className="rounded-full border border-cyan-300/30 px-3 py-1 text-sm text-cyan-100">Draft scaffold</span>
            </div>
            <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
              {sockets.map((socket) => (
                <div key={socket.id} className="materia-socket">
                  <div className={`materia-orb bg-gradient-to-br ${socket.color}`} />
                  <span className="mt-4 text-sm font-semibold uppercase tracking-widest text-slate-200">{socket.name}</span>
                </div>
              ))}
            </div>
          </section>

          <aside className="rounded-3xl border border-white/10 bg-slate-900/70 p-6">
            <h2 className="text-2xl font-bold">Server status</h2>
            <dl className="mt-5 space-y-4 text-sm">
              <div className="flex justify-between gap-4 rounded-2xl bg-slate-950/70 p-4">
                <dt className="text-slate-400">Scope</dt>
                <dd className="text-cyan-100">current Pi session</dd>
              </div>
              <div className="flex justify-between gap-4 rounded-2xl bg-slate-950/70 p-4">
                <dt className="text-slate-400">Client</dt>
                <dd className="text-emerald-100">React + Tailwind</dd>
              </div>
              <div className="flex justify-between gap-4 rounded-2xl bg-slate-950/70 p-4">
                <dt className="text-slate-400">API</dt>
                <dd className="text-amber-100">Node HTTP</dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>
    </main>
  );
}
