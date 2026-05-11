import type { MateriaEditorController } from './useMateriaEditorController.js';

interface MateriaEditorActionsProps {
  form: MateriaEditorController['form'];
  roleGeneration: MateriaEditorController['roleGeneration'];
  persistence: MateriaEditorController['persistence'];
}

export function MateriaEditorActions({ form, roleGeneration, persistence }: MateriaEditorActionsProps) {
  const { materiaForm, resetMateriaEditorForm } = form;
  const { discardGeneratedRolePrompt } = roleGeneration;
  const { saveMateriaForm, status } = persistence;

  return (
    <>
      <div className="mt-5 flex flex-wrap gap-3">
        <button className="materia-button" data-testid="save-materia-form" onClick={() => { void saveMateriaForm(); }}>{materiaForm.editingSocketId ? 'Update materia' : 'Create materia'}</button>
        <button className="materia-button-secondary" onClick={() => { resetMateriaEditorForm(); discardGeneratedRolePrompt(); }}>Clear form</button>
      </div>
      <p className="mt-3 min-h-10 text-sm text-cyan-100" data-testid="materia-save-status">{status}</p>
    </>
  );
}
