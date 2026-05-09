import type { Dispatch, RefObject, SetStateAction } from 'react';
import { materiaColorChoices } from '../../../loadoutModel.js';
import type { MateriaFormState, ModelCatalogLoadState, ModelCatalogResponse, ModelCatalogModel, SaveTarget, SelectOption } from '../../types.js';
import { Orb } from '../../components/Orb.js';
import { thinkingLabel } from '../../utils/modelCatalog.js';

interface MateriaEditorPanelProps {
  activeModelDescription?: string | null;
  editableDefinitionIds: string[];
  generatedRolePrompt: string;
  materiaColorDropdownRef: RefObject<HTMLFieldSetElement | null>;
  materiaColorOpen: boolean;
  materiaForm: MateriaFormState;
  modelCatalog: ModelCatalogResponse;
  modelCatalogError: string;
  modelCatalogStatus: ModelCatalogLoadState;
  modelOptions: SelectOption[];
  roleBrief: string;
  roleGenerating: boolean;
  roleGenerationError: string;
  selectedModel?: ModelCatalogModel;
  status: string;
  thinkingLevelsForSelection: string[];
  thinkingOptions: SelectOption[];
  applyGeneratedRolePrompt: () => void;
  discardGeneratedRolePrompt: () => void;
  editMateria: (id: string) => void;
  generateRolePrompt: () => Promise<void>;
  handleMateriaModelChange: (model: string) => void;
  resetMateriaEditorForm: () => void;
  saveMateriaForm: () => Promise<void>;
  setMateriaColorOpen: Dispatch<SetStateAction<boolean>>;
  setMateriaForm: Dispatch<SetStateAction<MateriaFormState>>;
  setRoleBrief: Dispatch<SetStateAction<string>>;
}

export function MateriaEditorPanel(props: MateriaEditorPanelProps) {
  const {
    activeModelDescription, editableDefinitionIds, generatedRolePrompt, materiaColorDropdownRef, materiaColorOpen,
    materiaForm, modelCatalog, modelCatalogError, modelCatalogStatus, modelOptions, roleBrief, roleGenerating,
    roleGenerationError, selectedModel, status, thinkingLevelsForSelection, thinkingOptions, applyGeneratedRolePrompt,
    discardGeneratedRolePrompt, editMateria, generateRolePrompt, handleMateriaModelChange, resetMateriaEditorForm,
    saveMateriaForm, setMateriaColorOpen, setMateriaForm, setRoleBrief,
  } = props;

  return (
    <section className="fantasy-panel p-4 sm:p-6" aria-label="Materia creation editor">
      <div className="mb-5">
        <p className="text-sm uppercase tracking-[0.35em] text-cyan-200">materia forge</p>
        <h2 className="mt-2 text-3xl font-black text-white">Create / edit materia</h2>
        <p className="mt-2 max-w-4xl text-sm text-slate-400">Forge reusable prompt materia or tool-invocation materia as staged definition edits. The form defaults to user profile persistence; choose Project only when you intentionally want repository-scoped materia.</p>
      </div>

      <section className="materia-form-section materia-settings-section" aria-label="Materia settings">
        <p className="materia-form-section-title">Settings</p>
        <div className="materia-compact-grid">
          <label className="graph-field">Edit existing
            <select data-testid="edit-materia-select" value={materiaForm.editingNodeId} onChange={(event) => event.target.value ? editMateria(event.target.value) : resetMateriaEditorForm()}>
              <option value="">new materia…</option>
              {editableDefinitionIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <label className="graph-field">Name
            <input data-testid="materia-name" value={materiaForm.name} onChange={(event) => setMateriaForm({ ...materiaForm, name: event.target.value })} placeholder="Critique" />
          </label>
          <label className="graph-field">Behavior
            <select data-testid="materia-behavior" value={materiaForm.behavior} onChange={(event) => setMateriaForm({ ...materiaForm, behavior: event.target.value as MateriaFormState['behavior'] })}>
              <option value="prompt">Prompt / agent</option>
              <option value="tool">Tool invocation</option>
            </select>
          </label>
          <label className="graph-field">Output format
            <select data-testid="materia-output-format" value={materiaForm.outputFormat} onChange={(event) => setMateriaForm({ ...materiaForm, outputFormat: event.target.value as MateriaFormState['outputFormat'] })}>
              <option value="text">Text</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <label className="graph-field">Save scope
            <select data-testid="materia-persist-scope" value={materiaForm.persistScope} onChange={(event) => setMateriaForm({ ...materiaForm, persistScope: event.target.value as SaveTarget })}>
              <option value="user">User profile (~/.config/pi/pi-materia)</option>
              <option value="project">Project (.pi/pi-materia.json)</option>
              <option value="explicit">Explicit config</option>
            </select>
          </label>
          {materiaForm.behavior === 'prompt' ? (
            <fieldset className="materia-settings-group materia-agent-options" aria-label="Prompt agent options">
              <legend>Prompt / agent options</legend>
              <div className="materia-compact-grid materia-settings-subgrid">
                <label className="graph-field">Model
                  <select data-testid="materia-model" value={materiaForm.model} onChange={(event) => handleMateriaModelChange(event.target.value)}>
                    {modelOptions.map((option) => <option key={option.value || 'active-pi-model'} value={option.value}>{option.label}</option>)}
                  </select>
                  <span className="materia-field-hint" data-testid="materia-model-catalog-status">
                    {modelCatalogStatus === 'loading' ? 'Loading available Pi models…' : modelCatalogStatus === 'error' ? `Model list unavailable: ${modelCatalogError}` : `${modelCatalog.models.length} available Pi model${modelCatalog.models.length === 1 ? '' : 's'}${activeModelDescription ? `; active ${activeModelDescription}` : ''}.`}
                  </span>
                </label>
                <label className="graph-field">Thinking
                  <select data-testid="materia-thinking" value={materiaForm.thinking} onChange={(event) => setMateriaForm({ ...materiaForm, thinking: event.target.value })}>
                    {thinkingOptions.map((option) => <option key={option.value || 'active-pi-thinking'} value={option.value}>{option.label}</option>)}
                  </select>
                  <span className="materia-field-hint" data-testid="materia-thinking-options-status">
                    {materiaForm.model ? `Uses thinking levels for ${selectedModel?.label ?? materiaForm.model}.` : 'Uses thinking levels for the active Pi model.'}
                    {thinkingLevelsForSelection.length > 0 ? ` Offered: ${thinkingLevelsForSelection.map(thinkingLabel).join(', ')}.` : ''}
                    {modelCatalog.activeThinking ? ` Active Pi thinking: ${modelCatalog.activeThinking}.` : ''}
                  </span>
                </label>
                <label className="graph-field">Tools
                  <select data-testid="materia-tools" value={materiaForm.toolAccess} onChange={(event) => setMateriaForm({ ...materiaForm, toolAccess: event.target.value as MateriaFormState['toolAccess'] })}>
                    <option value="none">none</option><option value="readOnly">read only</option><option value="coding">coding</option>
                  </select>
                </label>
                <fieldset ref={materiaColorDropdownRef} className="graph-field materia-color-picker" data-testid="materia-color" aria-label="Color">
                <legend>Color</legend>
                <div className="materia-color-dropdown">
                  <button type="button" className="materia-color-trigger" aria-haspopup="listbox" aria-expanded={materiaColorOpen} aria-controls="materia-color-options" aria-label="Select materia color" data-testid="materia-color-trigger" onClick={() => setMateriaColorOpen((open) => !open)}>
                    <Orb small color={materiaForm.color} label="Selected materia color" />
                    <span aria-hidden className="materia-color-trigger-caret">▾</span>
                  </button>
                  {materiaColorOpen && (
                    <div id="materia-color-options" className="materia-color-options" role="listbox" aria-label="Materia color choices">
                      {materiaColorChoices.map((choice) => {
                        const selected = materiaForm.color === choice.value;
                        return (
                          <button key={choice.id} type="button" role="option" aria-selected={selected} aria-label={`${choice.label} materia color`} data-testid={`materia-color-${choice.id}`} className={`materia-color-option ${selected ? 'materia-color-option-selected' : ''}`} onClick={() => { setMateriaForm({ ...materiaForm, color: choice.value }); setMateriaColorOpen(false); }} title={`${choice.label} materia color`}>
                            <Orb small color={choice.value} label={`${choice.label} materia color`} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {materiaForm.color && !materiaColorChoices.some((choice) => choice.value === materiaForm.color) && <p className="materia-color-legacy">Legacy custom color is selected; choose a palette color to replace it.</p>}
                </fieldset>
                <div className="materia-toggle-row materia-settings-toggle-row" aria-label="Boolean materia controls">
                <label className="graph-field graph-field-inline text-sm">Multiturn
                  <input data-testid="materia-multiturn" type="checkbox" checked={materiaForm.multiTurn} onChange={(event) => setMateriaForm({ ...materiaForm, multiTurn: event.target.checked })} />
                </label>
                <label className="graph-field graph-field-inline text-sm" title="Generator materia parse JSON and produce the canonical workItems envelope for downstream loops or generator pipeline stages.">Generator
                  <input data-testid="materia-generator" type="checkbox" checked={materiaForm.generator} onChange={(event) => setMateriaForm({ ...materiaForm, generator: event.target.checked })} />
                </label>
                </div>
              </div>
            </fieldset>
          ) : (
            <fieldset className="materia-settings-group materia-tool-options" aria-label="Tool invocation options">
              <legend>Tool invocation options</legend>
              <div className="materia-compact-grid materia-settings-subgrid">
                <label className="graph-field">Utility<input data-testid="materia-utility" value={materiaForm.utility} onChange={(event) => setMateriaForm({ ...materiaForm, utility: event.target.value })} placeholder="shell" /></label>
                <label className="graph-field">Command<input data-testid="materia-command" value={materiaForm.command} onChange={(event) => setMateriaForm({ ...materiaForm, command: event.target.value })} placeholder="npm test" /></label>
                <label className="graph-field">Timeout ms<input data-testid="materia-timeout" value={materiaForm.timeoutMs} onChange={(event) => setMateriaForm({ ...materiaForm, timeoutMs: event.target.value })} placeholder="60000" /></label>
              </div>
            </fieldset>
          )}
        </div>
      </section>

      {materiaForm.behavior === 'prompt' && (
        <section className="materia-form-section mt-5" aria-label="Generate role prompt instructions">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <label className="graph-field">Generate role prompt from brief
              <textarea data-testid="role-generation-brief" className="min-h-16" value={roleBrief} onChange={(event) => setRoleBrief(event.target.value)} placeholder="Describe the persona, responsibilities, constraints, and style for this materia…" />
            </label>
            <button type="button" className="materia-button" data-testid="generate-role-prompt" disabled={roleGenerating || !roleBrief.trim()} onClick={() => { void generateRolePrompt(); }}>{roleGenerating ? 'Generating…' : generatedRolePrompt ? 'Regenerate' : 'Generate'}</button>
          </div>
          {roleGenerationError && <p className="mt-3 text-sm text-rose-200" role="alert" data-testid="role-generation-error">{roleGenerationError}</p>}
          {generatedRolePrompt && (
            <div className="mt-4 rounded-xl border border-cyan-200/20 bg-black/30 p-4" data-testid="role-generation-preview">
              <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Generated preview</p>
              <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-sm text-cyan-50">{generatedRolePrompt}</pre>
              <div className="mt-4 flex flex-wrap gap-3"><button type="button" className="materia-button" data-testid="apply-generated-role-prompt" onClick={applyGeneratedRolePrompt}>Apply to prompt field</button><button type="button" className="materia-button-secondary" data-testid="discard-generated-role-prompt" onClick={discardGeneratedRolePrompt}>Discard</button></div>
            </div>
          )}
        </section>
      )}

      {materiaForm.behavior === 'prompt' ? (
        <label className="graph-field materia-prompt-field mt-5">Prompt<textarea data-testid="materia-prompt" className="min-h-72" value={materiaForm.prompt} onChange={(event) => setMateriaForm({ ...materiaForm, prompt: event.target.value })} placeholder="You are a focused review materia…" /></label>
      ) : (
        <label className="graph-field materia-prompt-field mt-5">Params JSON<textarea data-testid="materia-params" className="min-h-44" value={materiaForm.params} onChange={(event) => setMateriaForm({ ...materiaForm, params: event.target.value })} /></label>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button className="materia-button" data-testid="save-materia-form" onClick={() => { void saveMateriaForm(); }}>{materiaForm.editingNodeId ? 'Update materia' : 'Create materia'}</button>
        <button className="materia-button-secondary" onClick={() => { resetMateriaEditorForm(); discardGeneratedRolePrompt(); }}>Clear form</button>
      </div>
      <p className="mt-3 min-h-10 text-sm text-cyan-100" data-testid="materia-save-status">{status}</p>
    </section>
  );
}
