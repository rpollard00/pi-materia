import { READ_ONLY_TOOL_NAMES, TOOL_SCOPE_BASH_WARNING, TOOL_SCOPE_PRESET_OPTIONS, TOOL_SCOPE_TOOL_OPTIONS, isToolScopePreset, type ToolScopePreset } from '../../../../../../domain/toolScope.js';
import type { MateriaFormState, SaveTarget } from '../../types.js';
import { thinkingLabel } from '../../utils/modelCatalog.js';
import { ColorPickerField } from './ColorPickerField.js';
import type { MateriaEditorController } from './useMateriaEditorController.js';

interface MateriaEditorSettingsSectionProps {
  form: MateriaEditorController['form'];
  modelOptions: MateriaEditorController['modelOptions'];
  colorPicker: MateriaEditorController['colorPicker'];
}

const allCustomToolNames = TOOL_SCOPE_TOOL_OPTIONS.map((option) => option.value);

function customToolsForPreset(preset: ToolScopePreset): string[] {
  if (preset === 'none') return [];
  if (preset === 'readOnly') return [...READ_ONLY_TOOL_NAMES];
  return allCustomToolNames;
}

function parseCustomTools(raw: string): string[] {
  return raw.split(/[\s,]+/).map((tool) => tool.trim()).filter(Boolean);
}

export function MateriaEditorSettingsSection({ form, modelOptions: modelSection, colorPicker }: MateriaEditorSettingsSectionProps) {
  const {
    editableDefinitionIds, materiaForm, setMateriaForm, editMateria, handleMateriaModelChange, resetMateriaEditorForm,
  } = form;
  const {
    activeModelDescription, modelCatalog, modelCatalogError, modelCatalogStatus, modelOptions, selectedModel,
    thinkingLevelsForSelection, thinkingOptions,
  } = modelSection;

  return (
    <section className="materia-form-section materia-settings-section" aria-label="Materia settings">
      <p className="materia-form-section-title">Settings</p>
      <div className="materia-compact-grid">
        <label className="graph-field">Edit existing
          <select data-testid="edit-materia-select" value={materiaForm.editingSocketId} onChange={(event) => event.target.value ? editMateria(event.target.value) : resetMateriaEditorForm()}>
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
                <select data-testid="materia-tools" value={isToolScopePreset(materiaForm.toolAccess) ? materiaForm.toolAccess : 'custom'} onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'custom') {
                    const tools = isToolScopePreset(materiaForm.toolAccess) ? customToolsForPreset(materiaForm.toolAccess) : [...materiaForm.toolAccess.tools];
                    setMateriaForm({ ...materiaForm, toolAccess: { type: 'custom', tools } });
                  } else {
                    setMateriaForm({ ...materiaForm, toolAccess: value as ToolScopePreset });
                  }
                }}>
                  {TOOL_SCOPE_PRESET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  <option value="custom">Custom allowlist</option>
                </select>
                <span className="materia-field-hint">Build enables all available tools; Read-Only enables read/search tools; None disables tools.</span>
              </label>
              {!isToolScopePreset(materiaForm.toolAccess) ? (() => {
                const customToolAccess = materiaForm.toolAccess;
                return (
                  <div className="graph-field materia-custom-tools" data-testid="materia-custom-tools-panel">
                    <span>Custom tool allowlist</span>
                    <div className="materia-tool-checkbox-list" aria-label="Custom tool allowlist">
                      {TOOL_SCOPE_TOOL_OPTIONS.map((option) => {
                        const checked = customToolAccess.tools.includes(option.value);
                        return (
                          <label key={option.value} className="graph-field-inline text-sm" title={option.description}>
                            <input
                              data-testid={`materia-tool-${option.value}`}
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                const tools = event.target.checked
                                  ? [...customToolAccess.tools, option.value]
                                  : customToolAccess.tools.filter((tool: string) => tool !== option.value);
                                setMateriaForm({ ...materiaForm, toolAccess: { type: 'custom', tools } });
                              }}
                            />
                            {option.label} <span className="materia-field-hint">({option.value})</span>
                          </label>
                        );
                      })}
                    </div>
                    <label className="graph-field">Tool names
                      <input
                        data-testid="materia-custom-tools"
                        value={customToolAccess.tools.join(', ')}
                        onChange={(event) => setMateriaForm({ ...materiaForm, toolAccess: { type: 'custom', tools: parseCustomTools(event.target.value) } })}
                        placeholder="read, grep, find, ls, bash"
                      />
                    </label>
                    <span className="materia-field-hint">Custom allowlists are saved as explicit tool names, not as a preset. {TOOL_SCOPE_BASH_WARNING}</span>
                  </div>
                );
              })() : null}
              <ColorPickerField form={form} colorPicker={colorPicker} />
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
  );
}
