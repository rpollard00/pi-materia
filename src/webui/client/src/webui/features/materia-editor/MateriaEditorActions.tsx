import type { MateriaEditorController } from './useMateriaEditorController.js';

interface MateriaEditorActionsProps {
  form: MateriaEditorController['form'];
  roleGeneration: MateriaEditorController['roleGeneration'];
  persistence: MateriaEditorController['persistence'];
  selectedPolicy?: MateriaEditorController['selector']['selectedPolicy'];
}

export function MateriaEditorActions({ form, roleGeneration, persistence, selectedPolicy }: MateriaEditorActionsProps) {
  const { materiaForm, resetMateriaEditorForm } = form;
  const { discardGeneratedRolePrompt } = roleGeneration;
  const { saveMateriaForm, status } = persistence;
  const lockedUpdateBlocked = Boolean(materiaForm.editingSocketId && selectedPolicy && !selectedPolicy.canSave);
  const saveTitle = lockedUpdateBlocked ? selectedPolicy?.saveBlockedReason ?? 'Unlock this materia before saving changes.' : undefined;

  return (
    <>
      <div className="mt-5 flex flex-wrap gap-3">
        <button className="materia-button" data-testid="save-materia-form" disabled={lockedUpdateBlocked} title={saveTitle} onClick={() => { void saveMateriaForm(); }}>{materiaForm.editingSocketId ? 'Update materia' : 'Create materia'}</button>
        <button className="materia-button-secondary" onClick={() => { resetMateriaEditorForm(); discardGeneratedRolePrompt(); }}>Clear form</button>
      </div>
      <p className="mt-3 min-h-10 text-sm text-cyan-100" data-testid="materia-save-status">{status}</p>
    </>
  );
}
