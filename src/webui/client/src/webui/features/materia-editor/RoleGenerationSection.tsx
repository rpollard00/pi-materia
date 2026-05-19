import type { MateriaEditorController } from './useMateriaEditorController.js';

interface RoleGenerationSectionProps {
  roleGeneration: MateriaEditorController['roleGeneration'];
}

export function RoleGenerationSection({ roleGeneration }: RoleGenerationSectionProps) {
  const {
    generatedRolePrompt, generationModel, roleBrief, roleGenerating, roleGenerationError, roleGenerationWarnings, applyGeneratedRolePrompt,
    discardGeneratedRolePrompt, generateRolePrompt, setRoleBrief,
  } = roleGeneration;

  return (
    <section className="materia-form-section mt-5" aria-label="Generate role prompt instructions">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <label className="graph-field">Generate role prompt from brief
          <textarea data-testid="role-generation-brief" className="min-h-16" value={roleBrief} onChange={(event) => setRoleBrief(event.target.value)} placeholder="Describe the persona, responsibilities, constraints, and style for this materia…" />
        </label>
        <button type="button" className="materia-button" data-testid="generate-role-prompt" disabled={roleGenerating || generationModel.saving || !roleBrief.trim()} onClick={() => { void generateRolePrompt(); }}>{roleGenerating ? 'Generating…' : generatedRolePrompt ? 'Regenerate' : 'Generate'}</button>
      </div>
      {roleGenerationError && <p className="mt-3 text-sm text-rose-200" role="alert" data-testid="role-generation-error">{roleGenerationError}</p>}
      {roleGenerationWarnings.length > 0 && <p className="mt-3 text-sm text-amber-200" role="status" data-testid="role-generation-warning">{roleGenerationWarnings.join(' ')}</p>}
      {generatedRolePrompt && (
        <div className="mt-4 rounded-xl border border-cyan-200/20 bg-black/30 p-4" data-testid="role-generation-preview">
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Generated preview</p>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-sm text-cyan-50">{generatedRolePrompt}</pre>
          <div className="mt-4 flex flex-wrap gap-3"><button type="button" className="materia-button" data-testid="apply-generated-role-prompt" onClick={applyGeneratedRolePrompt}>Apply to prompt field</button><button type="button" className="materia-button-secondary" data-testid="discard-generated-role-prompt" onClick={discardGeneratedRolePrompt}>Discard</button></div>
        </div>
      )}
    </section>
  );
}
