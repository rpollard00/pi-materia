interface ParallelismSettingsPanelProps {
  maxConcurrency: number | undefined;
  onChange: (maxConcurrency: number) => void;
}

/** App-level, workspace-neutral bound shared by intrinsic parallel generators. */
export function ParallelismSettingsPanel({ maxConcurrency, onChange }: ParallelismSettingsPanelProps) {
  const value = maxConcurrency ?? 2;
  return (
    <section className="fantasy-panel p-4" aria-label="Parallel generation settings">
      <p className="text-xs uppercase tracking-[0.25em] text-cyan-200">parallel generation</p>
      <label className="graph-field mt-3">App max concurrency
        <input
          data-testid="app-parallel-max-concurrency"
          type="number"
          min="1"
          step="1"
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isSafeInteger(next) && next >= 1) onChange(next);
          }}
        />
      </label>
      <p className="mt-2 text-xs text-slate-400">Bounds concurrently running streams. Consuming loops may provide a smaller or larger explicit override.</p>
    </section>
  );
}
