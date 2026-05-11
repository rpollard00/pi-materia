import type { MonitorSnapshot } from '../../types.js';
import { formatTime } from '../../utils/display.js';

export interface MonitorPanelProps {
  monitor: MonitorSnapshot | undefined;
  currentMonitorSocket: string | undefined;
  elapsed: string;
}

export function MonitorPanel({ monitor, currentMonitorSocket, elapsed }: MonitorPanelProps) {
  return (
    <section className="fantasy-panel p-6" aria-label="Live session monitor">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">session monitor</p>
          <h2 className="mt-2 text-3xl font-black text-white">Live cast telemetry</h2>
          <p className="mt-2 max-w-4xl text-sm text-slate-400">Scoped to the Pi session that launched <code>/materia ui</code>. Native materia session entries and run artifacts are streamed from this session only.</p>
        </div>
        <div className="monitor-stat-grid">
          <div><span>socket</span><b>{currentMonitorSocket ?? 'idle'}</b></div>
          <div><span>state</span><b>{monitor?.activeCast?.socketState ?? 'no active cast'}</b></div>
          <div><span>elapsed</span><b>{elapsed}</b></div>
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <article className="monitor-card xl:col-span-1">
          <h3>Emitted outputs</h3>
          <div className="monitor-scroll">
            {(monitor?.emittedOutputs ?? []).length === 0 ? <p className="text-sm text-slate-500">Waiting for session output…</p> : monitor?.emittedOutputs?.slice(-10).reverse().map((output) => (
              <div key={output.id} className="monitor-output">
                <div><b>{output.type}</b><span>{formatTime(output.timestamp)}</span></div>
                <p>{output.text}</p>
              </div>
            ))}
          </div>
        </article>
        <article className="monitor-card xl:col-span-1">
          <h3>Artifact summary</h3>
          <pre className="monitor-summary">{monitor?.artifactSummary?.summary ?? 'No pi-materia artifacts found for this launched session yet.'}</pre>
          {monitor?.artifactSummary?.runDir && <p className="mt-3 break-all text-xs text-cyan-100/70">{monitor.artifactSummary.runDir}</p>}
        </article>
        <article className="monitor-card xl:col-span-1">
          <h3>Recent artifacts</h3>
          <div className="monitor-scroll">
            {(monitor?.artifactSummary?.outputs ?? []).length === 0 ? <p className="text-sm text-slate-500">Artifacts will appear as sockets emit context and output files.</p> : monitor?.artifactSummary?.outputs?.slice(-8).reverse().map((entry, index) => (
              <details key={`${entry.artifact}-${index}`} className="monitor-artifact">
                <summary>{entry.socket ?? entry.phase ?? 'cast'} · {entry.kind ?? 'artifact'}</summary>
                <p className="break-all text-xs text-cyan-100/70">{entry.artifact}</p>
                {entry.content && <pre>{entry.content}</pre>}
              </details>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
