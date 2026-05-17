import type { MateriaEditorController } from './useMateriaEditorController.js';

interface MateriaPromptFieldsProps {
  form: MateriaEditorController['form'];
}

export function MateriaPromptFields({ form }: MateriaPromptFieldsProps) {
  const { materiaForm, setMateriaForm } = form;

  return materiaForm.behavior === 'prompt' ? (
    <label className="graph-field materia-prompt-field mt-5">Prompt<textarea data-testid="materia-prompt" className="min-h-72" value={materiaForm.prompt} onChange={(event) => setMateriaForm({ ...materiaForm, prompt: event.target.value })} placeholder="You are a focused review materia…" /></label>
  ) : (
    <div className="mt-5 grid gap-4 lg:grid-cols-2">
      <label className="graph-field materia-prompt-field">Params JSON<textarea data-testid="materia-params" className="min-h-44" value={materiaForm.params} onChange={(event) => setMateriaForm({ ...materiaForm, params: event.target.value })} /></label>
      <label className="graph-field materia-prompt-field">Assign JSON<textarea data-testid="materia-assign" className="min-h-44" value={materiaForm.assign} onChange={(event) => setMateriaForm({ ...materiaForm, assign: event.target.value })} /></label>
    </div>
  );
}
