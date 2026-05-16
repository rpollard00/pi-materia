import { MateriaEditorActions } from './MateriaEditorActions.js';
import { MateriaEditorSettingsSection } from './MateriaEditorSettingsSection.js';
import { MateriaPromptFields } from './MateriaPromptFields.js';
import { RoleGenerationSection } from './RoleGenerationSection.js';
import type { MateriaEditorController } from './useMateriaEditorController.js';
import type { ToolRegistrySnapshot } from '../../types.js';

interface MateriaEditorPanelProps {
  controller: MateriaEditorController;
  toolRegistry?: ToolRegistrySnapshot;
}

export function MateriaEditorPanel({ controller, toolRegistry }: MateriaEditorPanelProps) {
  const { form, modelOptions, colorPicker, roleGeneration, persistence } = controller;
  const { materiaForm } = form;

  return (
    <section className="fantasy-panel p-4 sm:p-6" aria-label="Materia creation editor">
      <div className="mb-5">
        <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">materia forge</p>
        <h2 className="mt-2 text-3xl font-black text-white">Create / edit materia</h2>
        <p className="mt-2 max-w-4xl text-sm text-slate-400">Forge reusable prompt materia or tool-invocation materia as staged definition edits. The form defaults to user profile persistence; choose Project only when you intentionally want repository-scoped materia.</p>
      </div>

      <MateriaEditorSettingsSection form={form} modelOptions={modelOptions} colorPicker={colorPicker} toolRegistry={toolRegistry} />

      {materiaForm.behavior === 'prompt' && <RoleGenerationSection roleGeneration={roleGeneration} />}

      <MateriaPromptFields form={form} />

      <MateriaEditorActions form={form} roleGeneration={roleGeneration} persistence={persistence} />
    </section>
  );
}
