import { thinkingLabel } from '../../utils/modelCatalog.js';
import type { MateriaEditorController } from './useMateriaEditorController.js';

interface RoleGenerationSectionProps {
  roleGeneration: MateriaEditorController['roleGeneration'];
}

export function RoleGenerationSection({ roleGeneration }: RoleGenerationSectionProps) {
  const {
    generatedRolePrompt, generationModel, generationThinking, roleBrief, roleGenerating, roleGenerationError, roleGenerationModelResolution, roleGenerationThinkingResolution, roleGenerationWarnings,
    applyGeneratedRolePrompt, discardGeneratedRolePrompt, generateRolePrompt, setRoleBrief,
  } = roleGeneration;
  const effectiveGeneratedModel = roleGenerationModelResolution?.effectiveModel
    ? roleGenerationModelResolution.effectiveModel
    : roleGenerationModelResolution ? 'Active Pi Model' : '';
  const effectiveGeneratedThinking = roleGenerationThinkingResolution?.effectiveThinking
    ? thinkingLabel(roleGenerationThinkingResolution.effectiveThinking)
    : roleGenerationThinkingResolution ? 'Active Pi Thinking' : '';
  const preferencesSaving = generationModel.saving || generationThinking.saving;
  const preferenceDataUnavailable = generationModel.preferenceStatus === 'loading' || generationThinking.preferenceStatus === 'loading';
  const generationControlsDisabled = roleGenerating || preferencesSaving || preferenceDataUnavailable;

  return (
    <section className="materia-form-section mt-5" aria-label="Generate role prompt instructions">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,34rem)_auto] lg:items-end">
        <label className="graph-field">Generate role prompt from brief
          <textarea data-testid="role-generation-brief" className="min-h-16" value={roleBrief} onChange={(event) => setRoleBrief(event.target.value)} placeholder="Describe the persona, responsibilities, constraints, and style for this materia…" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="graph-field">Prompt generation model
            <select data-testid="generation-model-select" value={generationModel.selectedModel} disabled={generationControlsDisabled} onChange={(event) => { void generationModel.changeModel(event.target.value); }}>
              {generationModel.availableOptions.map((option, index) => <option key={option.value || 'active-pi-model'} value={option.value}>{index === 0 ? option.label : `${option.label}${option.unavailable ? ' (unavailable)' : ''}`}</option>)}
            </select>
          </label>
          <label className="graph-field">Prompt generation thinking
            <select data-testid="generation-thinking-select" value={generationThinking.selectedThinking} disabled={generationControlsDisabled || generationThinking.availableOptions.length === 0} onChange={(event) => { void generationThinking.changeThinking(event.target.value); }}>
              {generationThinking.availableOptions.map((option) => <option key={option.value || 'active-pi-thinking'} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <span className="materia-field-hint sm:col-span-2">These choices affect generated prompt previews only; materia runtime model settings are separate.</span>
        </div>
        <button type="button" className="materia-button" data-testid="generate-role-prompt" disabled={generationControlsDisabled || !roleBrief.trim()} onClick={() => { void generateRolePrompt(); }}>{roleGenerating ? 'Generating…' : generatedRolePrompt ? 'Regenerate' : 'Generate'}</button>
      </div>
      {preferencesSaving && <p className="mt-3 text-sm text-cyan-200" role="status" data-testid="generation-preference-save-status">Saving prompt-generation preferences…</p>}
      {generationModel.saving && <p className="mt-3 text-sm text-cyan-200" role="status" data-testid="generation-model-save-status">Saving prompt-generation model preference…</p>}
      {generationThinking.saving && <p className="mt-3 text-sm text-cyan-200" role="status" data-testid="generation-thinking-save-status">Saving prompt-generation thinking preference…</p>}
      {generationModel.saveError && <p className="mt-3 text-sm text-rose-200" role="alert" data-testid="generation-model-save-error">Prompt-generation model preference save failed: {generationModel.saveError}</p>}
      {generationThinking.saveError && <p className="mt-3 text-sm text-rose-200" role="alert" data-testid="generation-thinking-save-error">Prompt-generation thinking preference save failed: {generationThinking.saveError}</p>}
      {generationModel.stalePreferenceWarning && <p className="mt-3 text-sm text-amber-200" role="status" data-testid="generation-model-stale-warning">{generationModel.stalePreferenceWarning}</p>}
      {generationThinking.stalePreferenceWarning && <p className="mt-3 text-sm text-amber-200" role="status" data-testid="generation-thinking-stale-warning">{generationThinking.stalePreferenceWarning}</p>}
      {generationModel.preferenceError && <p className="mt-3 text-sm text-amber-200" role="status" data-testid="generation-model-preference-error">Prompt-generation preference unavailable: {generationModel.preferenceError}</p>}
      {generationThinking.preferenceError && <p className="mt-3 text-sm text-amber-200" role="status" data-testid="generation-thinking-preference-error">Prompt-generation thinking preference unavailable: {generationThinking.preferenceError}</p>}
      {roleGenerationError && <p className="mt-3 text-sm text-rose-200" role="alert" data-testid="role-generation-error">{roleGenerationError}</p>}
      {roleGenerationWarnings.length > 0 && <p className="mt-3 text-sm text-amber-200" role="status" data-testid="role-generation-warning">{roleGenerationWarnings.join(' ')}</p>}
      {generatedRolePrompt && (
        <div className="mt-4 rounded-xl border border-cyan-200/20 bg-black/30 p-4" data-testid="role-generation-preview">
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Generated preview</p>
          {(effectiveGeneratedModel || effectiveGeneratedThinking) && <p className="mt-2 text-xs text-slate-300" data-testid="role-generation-effective-metadata">Generated with {[effectiveGeneratedModel, effectiveGeneratedThinking].filter(Boolean).join(' · ')}</p>}
          {effectiveGeneratedModel && <p className="mt-2 text-xs text-slate-300" data-testid="role-generation-effective-model">Effective model: {effectiveGeneratedModel}</p>}
          {effectiveGeneratedThinking && <p className="mt-1 text-xs text-slate-300" data-testid="role-generation-effective-thinking">Effective thinking: {effectiveGeneratedThinking}</p>}
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-sm text-cyan-50">{generatedRolePrompt}</pre>
          <div className="mt-4 flex flex-wrap gap-3"><button type="button" className="materia-button" data-testid="apply-generated-role-prompt" onClick={applyGeneratedRolePrompt}>Apply to prompt field</button><button type="button" className="materia-button-secondary" data-testid="discard-generated-role-prompt" onClick={discardGeneratedRolePrompt}>Discard</button></div>
        </div>
      )}
    </section>
  );
}
