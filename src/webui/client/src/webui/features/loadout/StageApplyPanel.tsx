import type { DragEvent } from 'react';
import type { SaveTarget } from '../../types.js';

export interface StageApplyPanelProps {
  saveTarget: SaveTarget;
  dragOverTrash: boolean;
  isDirty: boolean;
  canRevert: boolean;
  status: string;
  onSaveTargetChange: (target: SaveTarget) => void;
  onTrashDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onTrashDragLeave: () => void;
  onTrashDrop: (event: DragEvent<HTMLDivElement>) => void;
  onSave: () => void;
  onRevert: () => void;
}

export function StageApplyPanel({ saveTarget, dragOverTrash, isDirty, canRevert, status, onSaveTargetChange, onTrashDragOver, onTrashDragLeave, onTrashDrop, onSave, onRevert }: StageApplyPanelProps) {
  return (
    <section className="fantasy-panel p-5">
      <h2 className="text-xl font-bold">Stage & apply</h2>
      <p className="mt-2 text-sm text-slate-400">Nothing is persisted until Save is pressed. User scope is the safe default.</p>
      <label className="mt-4 block text-sm text-slate-300">Save target
        <select className="mt-2 w-full rounded-xl border border-cyan-200/20 bg-slate-950 px-3 py-2" value={saveTarget} onChange={(event) => onSaveTargetChange(event.target.value as SaveTarget)}>
          <option value="user">User profile</option>
          <option value="project">Project</option>
          <option value="explicit">Explicit config</option>
        </select>
      </label>
      <div
        data-testid="trash-socket"
        className={`trash-socket ${dragOverTrash ? 'trash-socket-hot' : ''}`}
        onDragOver={onTrashDragOver}
        onDragLeave={onTrashDragLeave}
        onDrop={onTrashDrop}
      >
        Drag socket here or onto the graph background to unsocket materia
      </div>
      <div className="mt-4 flex gap-3">
        <button className="materia-button flex-1" disabled={!isDirty} onClick={onSave}>Save</button>
        <button className="materia-button-secondary" disabled={!isDirty || !canRevert} onClick={onRevert}>Revert</button>
      </div>
      <p className="mt-3 min-h-10 text-sm text-cyan-100">{status}</p>
    </section>
  );
}
