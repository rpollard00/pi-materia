import type { SaveTarget } from '../../types.js';

export interface StageApplyPanelProps {
  saveTarget: SaveTarget;
  isDirty: boolean;
  canRevert: boolean;
  onSaveTargetChange: (target: SaveTarget) => void;
  onSave: () => void;
  onRevert: () => void;
}

export function StageApplyPanel({ saveTarget, isDirty, canRevert, onSaveTargetChange, onSave, onRevert }: StageApplyPanelProps) {
  return (
    <section className="fantasy-panel p-5">
      <h2 className="text-xl font-bold">Stage & apply</h2>
      <label className="mt-4 block text-sm text-slate-300">Save target
        <select className="mt-2 w-full rounded-xl border border-cyan-200/20 bg-slate-950 px-3 py-2" value={saveTarget} onChange={(event) => onSaveTargetChange(event.target.value as SaveTarget)}>
          <option value="user">User profile</option>
          <option value="project">Project</option>
          <option value="explicit">Explicit config</option>
        </select>
      </label>
      <div className="mt-4 flex gap-3">
        <button className="materia-button flex-1" disabled={!isDirty} onClick={onSave}>Save</button>
        <button className="materia-button-secondary" disabled={!isDirty || !canRevert} onClick={onRevert}>Revert</button>
      </div>
    </section>
  );
}
