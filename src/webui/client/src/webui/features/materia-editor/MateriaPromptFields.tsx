import type { MateriaEditorController } from './useMateriaEditorController.js';

interface MateriaPromptFieldsProps {
  form: MateriaEditorController['form'];
}

export function MateriaPromptFields({ form }: MateriaPromptFieldsProps) {
  const { materiaForm, setMateriaForm } = form;

  return materiaForm.behavior === 'prompt' ? (
    <label className="graph-field materia-prompt-field mt-5">Prompt<textarea data-testid="materia-prompt" className="min-h-72" value={materiaForm.prompt} onChange={(event) => setMateriaForm({ ...materiaForm, prompt: event.target.value })} placeholder="You are a focused review materia…" /></label>
  ) : (
    <label className="graph-field materia-prompt-field mt-5">Params JSON<textarea data-testid="materia-params" className="min-h-44" value={materiaForm.params} onChange={(event) => setMateriaForm({ ...materiaForm, params: event.target.value })} /></label>
  );
}
