import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isGeneratorMateria } from '../../../../../../graph/generator.js';
import type { MateriaConfig } from '../../../loadoutModel.js';
import { materiaSavedEventName } from '../../constants.js';
import { generateMateriaRole, getRoleGenerationPreference, saveConfig, saveRoleGenerationPreference } from '../../api/index.js';
import { activeModelOptionLabel, activeThinkingOptionLabel } from '../../constants.js';
import { useModelCatalog } from '../../hooks/useModelCatalog.js';
import type { LoadoutSourceScope, MateriaFormState, MateriaSavedEventDetail, MateriaTabId, RoleGenerationModelResolution, RoleGenerationThinkingResolution, SelectOption } from '../../types.js';
import {
  buildMateriaPatch,
  canonicalWorkItemsGeneratorConfig,
  emptyMateriaForm,
} from '../../utils/forms.js';
import {
  canKeepThinkingForModel,
  modelSelectOptions,
  selectedCatalogModel,
  thinkingLabel,
  thinkingSelectOptions,
} from '../../utils/modelCatalog.js';
import { buildMateriaSelectorItems, getMateriaEditPolicy, type MateriaSelectorItem } from './materiaEditPolicy.js';

function dispatchMateriaSavedEvent(detail: MateriaSavedEventDetail) {
  window.dispatchEvent(new CustomEvent<MateriaSavedEventDetail>(materiaSavedEventName, { detail }));
}

export interface UseMateriaEditorControllerOptions {
  materia: MateriaConfig['materia'];
  materiaSources: Record<string, LoadoutSourceScope>;
  defaultMateriaIds: string[];
  selectedTab: MateriaTabId;
  status: string;
  setStatus: (status: string) => void;
  reloadConfig: (options?: { preserveLoadoutEdits?: boolean; readyStatus?: string; cancelled?: () => boolean }) => Promise<void>;
}

export interface MateriaEditorController {
  metadata: {
    materiaSources: Record<string, LoadoutSourceScope>;
    defaultMateriaIds: string[];
  };
  form: {
    editableDefinitionIds: string[];
    materiaForm: MateriaFormState;
    setMateriaForm: Dispatch<SetStateAction<MateriaFormState>>;
    editMateria: (id: string) => void;
    handleMateriaModelChange: (model: string) => void;
    resetMateriaEditorForm: () => void;
  };
  selector: {
    items: MateriaSelectorItem[];
    selectedPolicy: MateriaSelectorItem | undefined;
    duplicateMateria: (id: string) => void;
    setMateriaLockState: (id: string, lockState: 'locked' | 'unlocked') => Promise<void>;
    deleteMateria: (id: string) => Promise<void>;
  };
  modelOptions: {
    activeModelDescription?: string | null;
    modelCatalog: ReturnType<typeof useModelCatalog>['modelCatalog'];
    modelCatalogError: string;
    modelCatalogStatus: ReturnType<typeof useModelCatalog>['modelCatalogStatus'];
    modelOptions: ReturnType<typeof modelSelectOptions>;
    selectedModel: ReturnType<typeof selectedCatalogModel>;
    thinkingLevelsForSelection: string[];
    thinkingOptions: ReturnType<typeof thinkingSelectOptions>;
  };
  colorPicker: {
    materiaColorDropdownRef: RefObject<HTMLFieldSetElement | null>;
    materiaColorOpen: boolean;
    setMateriaColorOpen: Dispatch<SetStateAction<boolean>>;
  };
  roleGeneration: {
    roleBrief: string;
    setRoleBrief: Dispatch<SetStateAction<string>>;
    generatedRolePrompt: string;
    roleGenerationError: string;
    roleGenerationWarnings: string[];
    roleGenerationModelResolution: RoleGenerationModelResolution | null;
    roleGenerationThinkingResolution: RoleGenerationThinkingResolution | null;
    roleGenerating: boolean;
    generationModel: {
      selectedModel: string;
      persistedModel: string | null;
      stalePreferenceWarning: string;
      availableOptions: SelectOption[];
      activeModelLabel: string;
      activeModelDetail: string;
      preferenceStatus: 'idle' | 'loading' | 'ready' | 'error';
      preferenceError: string;
      saving: boolean;
      saveError: string;
      changeModel: (model: string) => Promise<void>;
    };
    generationThinking: {
      selectedThinking: string;
      persistedThinking: string | null;
      stalePreferenceWarning: string;
      availableOptions: SelectOption[];
      activeThinkingLabel: string;
      activeThinkingDetail: string;
      preferenceStatus: 'idle' | 'loading' | 'ready' | 'error';
      preferenceError: string;
      saving: boolean;
      saveError: string;
      changeThinking: (thinking: string) => Promise<void>;
    };
    generateRolePrompt: () => Promise<void>;
    applyGeneratedRolePrompt: () => void;
    discardGeneratedRolePrompt: () => void;
  };
  persistence: {
    saveMateriaForm: () => Promise<void>;
    status: string;
  };
}

export function useMateriaEditorController({ materia, materiaSources, defaultMateriaIds, selectedTab, status, setStatus, reloadConfig }: UseMateriaEditorControllerOptions): MateriaEditorController {
  const [materiaForm, setMateriaForm] = useState<MateriaFormState>(() => emptyMateriaForm());
  const [originalMateriaModelSettings, setOriginalMateriaModelSettings] = useState<{ editingSocketId: string; model: string; thinking: string } | undefined>();
  const { modelCatalog, modelCatalogStatus, modelCatalogError } = useModelCatalog(selectedTab);
  const [materiaColorOpen, setMateriaColorOpen] = useState(false);
  const materiaColorDropdownRef = useRef<HTMLFieldSetElement | null>(null);
  const [roleBrief, setRoleBrief] = useState('');
  const [generatedRolePrompt, setGeneratedRolePrompt] = useState('');
  const [roleGenerationError, setRoleGenerationError] = useState('');
  const [roleGenerationWarnings, setRoleGenerationWarnings] = useState<string[]>([]);
  const [roleGenerationModelResolution, setRoleGenerationModelResolution] = useState<RoleGenerationModelResolution | null>(null);
  const [roleGenerationThinkingResolution, setRoleGenerationThinkingResolution] = useState<RoleGenerationThinkingResolution | null>(null);
  const [roleGenerating, setRoleGenerating] = useState(false);
  const [generationPreferenceStatus, setGenerationPreferenceStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [persistedGenerationModel, setPersistedGenerationModel] = useState<string | null>(null);
  const [persistedGenerationThinking, setPersistedGenerationThinking] = useState<string | null>(null);
  const [generationPreferenceError, setGenerationPreferenceError] = useState('');
  const [generationModelSaving, setGenerationModelSaving] = useState(false);
  const [generationModelSaveError, setGenerationModelSaveError] = useState('');
  const [generationThinkingSaving, setGenerationThinkingSaving] = useState(false);
  const [generationThinkingSaveError, setGenerationThinkingSaveError] = useState('');
  const roleGenerationPreferenceRequestedRef = useRef(false);
  const [pendingReloadSelection, setPendingReloadSelection] = useState<{ id: string; deletedSource: LoadoutSourceScope | undefined } | null>(null);

  useEffect(() => {
    if (!materiaColorOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (materiaColorDropdownRef.current?.contains(event.target as Node)) return;
      setMateriaColorOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMateriaColorOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [materiaColorOpen]);

  useEffect(() => {
    if (selectedTab !== 'materia-editor' || roleGenerationPreferenceRequestedRef.current) return;
    roleGenerationPreferenceRequestedRef.current = true;
    let cancelled = false;
    setGenerationPreferenceStatus('loading');
    setGenerationPreferenceError('');
    getRoleGenerationPreference().then(({ response, body }) => {
      if (cancelled) return;
      const errorMessage = typeof body.error === 'string' ? body.error : body.error?.message;
      if (!response.ok || body.ok === false) throw new Error(errorMessage ?? 'Role-generation preference request failed.');
      setPersistedGenerationModel(typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null);
      setPersistedGenerationThinking(typeof body.thinking === 'string' && body.thinking.trim() ? body.thinking.trim() : null);
      setGenerationPreferenceStatus('ready');
    }).catch((error) => {
      if (cancelled) return;
      setPersistedGenerationModel(null);
      setPersistedGenerationThinking(null);
      setGenerationPreferenceStatus('error');
      setGenerationPreferenceError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [selectedTab]);

  useEffect(() => {
    let cancelled = false;
    const handleMateriaSaved = (event: Event) => {
      const detail = (event as CustomEvent<MateriaSavedEventDetail>).detail;
      const name = detail?.name ?? detail?.id ?? 'materia';
      const behavior = detail?.behavior ?? 'prompt';
      const scope = detail?.scope ?? 'configured';
      void reloadConfig({
        preserveLoadoutEdits: true,
        readyStatus: `Saved reusable ${behavior} materia ${name} to ${scope} scope. Loadout draft edits were left unchanged.`,
        cancelled: () => cancelled,
      });
    };
    window.addEventListener(materiaSavedEventName, handleMateriaSaved);
    return () => {
      cancelled = true;
      window.removeEventListener(materiaSavedEventName, handleMateriaSaved);
    };
  }, [reloadConfig]);

  const editableDefinitionIds = useMemo(() => Object.keys(materia ?? {}).sort((a, b) => a.localeCompare(b)), [materia]);
  const selectorItems = useMemo(() => buildMateriaSelectorItems(materia, materiaSources, defaultMateriaIds), [materia, materiaSources, defaultMateriaIds]);
  const selectedPolicy = useMemo(() => selectorItems.find((item) => item.id === materiaForm.editingSocketId), [selectorItems, materiaForm.editingSocketId]);
  const modelOptions = useMemo(() => modelSelectOptions(modelCatalog, originalMateriaModelSettings), [modelCatalog, originalMateriaModelSettings]);
  const thinkingOptions = useMemo(() => thinkingSelectOptions(modelCatalog, materiaForm, originalMateriaModelSettings), [modelCatalog, materiaForm.editingSocketId, materiaForm.model, materiaForm.thinking, originalMateriaModelSettings]);
  const activeModelDescription = modelCatalog.activeModel?.label ?? modelCatalog.activeModelValue;
  const selectedModel = selectedCatalogModel(modelCatalog, materiaForm.model);
  const thinkingLevelsForSelection = selectedModel?.supportedThinkingLevels ?? [];
  const activeGenerationModelLabel = modelCatalog.activeModel?.label ?? activeModelOptionLabel;
  const activeGenerationModelDetail = modelCatalog.activeModelValue ?? modelCatalog.activeModel?.value ?? '';
  const generationModelOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [{ value: '', label: activeGenerationModelDetail ? `${activeModelOptionLabel} (${activeGenerationModelDetail})` : activeModelOptionLabel }];
    const seen = new Set<string>();
    for (const model of modelCatalog.models) {
      if (!model.value || seen.has(model.value)) continue;
      seen.add(model.value);
      options.push({ value: model.value, label: model.label });
    }
    const savedModel = persistedGenerationModel?.trim();
    if (savedModel && !seen.has(savedModel) && modelCatalogStatus !== 'ready') {
      options.push({ value: savedModel, label: `${savedModel} (saved preference)`, unavailable: true });
    }
    return options;
  }, [activeGenerationModelDetail, modelCatalog.models, modelCatalogStatus, persistedGenerationModel]);
  const savedGenerationModelAvailable = Boolean(persistedGenerationModel && modelCatalog.models.some((model) => model.value === persistedGenerationModel));
  const staleGenerationModelWarning = persistedGenerationModel && modelCatalogStatus === 'ready' && !savedGenerationModelAvailable
    ? 'Saved generation model is unavailable; using Active Pi Model.'
    : '';
  const selectedGenerationModel = persistedGenerationModel
    ? (modelCatalogStatus === 'ready' ? (savedGenerationModelAvailable ? persistedGenerationModel : '') : persistedGenerationModel)
    : '';
  const selectedGenerationCatalogModel = selectedGenerationModel
    ? modelCatalog.models.find((model) => model.value === selectedGenerationModel)
    : selectedCatalogModel(modelCatalog, '');
  const generationThinkingOptions = useMemo<SelectOption[]>(() => {
    const supported = selectedGenerationCatalogModel?.supportedThinkingLevels ?? [];
    return [
      { value: '', label: modelCatalog.activeThinking ? `${activeThinkingOptionLabel} (${thinkingLabel(modelCatalog.activeThinking)})` : activeThinkingOptionLabel },
      ...supported.map((level) => ({ value: level, label: thinkingLabel(level) })),
    ];
  }, [modelCatalog.activeThinking, selectedGenerationCatalogModel]);
  const generationThinkingSupported = Boolean(persistedGenerationThinking && selectedGenerationCatalogModel?.supportedThinkingLevels.includes(persistedGenerationThinking));
  const selectedGenerationThinking = generationThinkingSupported ? (persistedGenerationThinking ?? '') : '';
  const staleGenerationThinkingWarning = persistedGenerationThinking && modelCatalogStatus === 'ready' && !generationThinkingSupported
    ? 'Saved generation thinking is unsupported by the selected generation model; using Active Pi Thinking.'
    : '';
  const activeGenerationThinkingDetail = modelCatalog.activeThinking ?? '';
  const generationPreferenceSaving = generationModelSaving || generationThinkingSaving;

  useEffect(() => {
    if (!pendingReloadSelection) return;
    const { id, deletedSource } = pendingReloadSelection;
    const definition = materia?.[id];
    const currentSource = getMateriaEditPolicy({ id, definition, source: materiaSources[id], defaultMateriaIds }).source;
    if (definition && currentSource === deletedSource) return;
    if (definition) editMateria(id);
    else resetMateriaEditorForm();
    setPendingReloadSelection(null);
  }, [materia, materiaSources, defaultMateriaIds, pendingReloadSelection]);

  function resetMateriaEditorForm() {
    setMateriaForm(emptyMateriaForm());
    setOriginalMateriaModelSettings(undefined);
  }

  function handleMateriaModelChange(model: string) {
    setMateriaForm((current) => ({
      ...current,
      model,
      thinking: canKeepThinkingForModel(modelCatalog, model, current.thinking, current, originalMateriaModelSettings) ? current.thinking : '',
    }));
  }

  function formStateForMateria(id: string, options: { duplicate?: boolean } = {}): MateriaFormState | undefined {
    const definition = materia?.[id];
    if (!definition) return undefined;
    const isUtility = definition.type === 'utility';
    const generator = isGeneratorMateria(definition);
    const savedModel = isUtility ? '' : String(definition.model ?? '').trim();
    const savedThinking = isUtility ? '' : String(definition.thinking ?? '').trim();
    const policy = getMateriaEditPolicy({ id, definition, source: materiaSources[id], defaultMateriaIds });
    const name = options.duplicate ? uniqueMateriaCopyName(id) : id;
    return {
      editingSocketId: options.duplicate ? '' : id,
      name,
      behavior: isUtility ? 'tool' : 'prompt',
      label: String(definition.label ?? ''),
      description: String(definition.description ?? ''),
      group: String(definition.group ?? ''),
      prompt: isUtility ? '' : String(definition.prompt ?? ''),
      toolAccess: isUtility ? 'none' : (definition.tools ?? 'none'),
      model: savedModel,
      thinking: savedThinking,
      color: String(definition.color ?? ''),
      outputFormat: definition.parse === 'json' ? 'json' : 'text',
      multiTurn: isUtility ? false : Boolean(definition.multiTurn),
      generator,
      utility: isUtility ? String(definition.utility ?? '') : '',
      command: isUtility ? (definition.command ?? []).join(' ') : '',
      params: isUtility ? JSON.stringify(definition.params ?? {}, null, 2) : '{}',
      assign: isUtility ? JSON.stringify(definition.assign ?? {}, null, 2) : '{}',
      timeoutMs: isUtility && definition.timeoutMs !== undefined ? String(definition.timeoutMs) : '',
      persistScope: options.duplicate ? 'user' : policy.saveScope,
    };
  }

  function uniqueMateriaCopyName(id: string): string {
    const base = `${id} Copy`;
    if (!materia?.[base]) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base} ${index}`;
      if (!materia?.[candidate]) return candidate;
    }
    return `${base} ${Date.now()}`;
  }

  function editMateria(id: string) {
    const definition = materia?.[id];
    const nextForm = formStateForMateria(id);
    if (!definition || !nextForm) return;
    const isUtility = definition.type === 'utility';
    const savedModel = isUtility ? '' : String(definition.model ?? '').trim();
    const savedThinking = isUtility ? '' : String(definition.thinking ?? '').trim();
    setOriginalMateriaModelSettings({ editingSocketId: id, model: savedModel, thinking: savedThinking });
    setMateriaForm(nextForm);
    const policy = getMateriaEditPolicy({ id, definition, source: materiaSources[id], defaultMateriaIds });
    const scopeText = policy.source === 'default' ? 'as a user override draft' : `from ${policy.saveScope} scope`;
    setStatus(`Editing reusable materia definition ${id} ${scopeText}. Save the staged form to update definitions only.`);
  }

  function duplicateMateria(id: string) {
    const nextForm = formStateForMateria(id, { duplicate: true });
    if (!nextForm) return;
    setOriginalMateriaModelSettings(undefined);
    setMateriaForm(nextForm);
    setStatus(`Duplicated ${id} as ${nextForm.name}. Save the staged form to create it.`);
  }

  async function changeGenerationModel(model: string) {
    const nextModel = model.trim() || null;
    if (generationPreferenceSaving) return;
    const nextCatalogModel = nextModel ? modelCatalog.models.find((catalogModel) => catalogModel.value === nextModel) : selectedCatalogModel(modelCatalog, '');
    const shouldClearThinking = Boolean(persistedGenerationThinking && !nextCatalogModel?.supportedThinkingLevels.includes(persistedGenerationThinking));
    setGenerationModelSaving(true);
    setGenerationModelSaveError('');
    setGenerationThinkingSaveError('');
    try {
      const { response, body } = await saveRoleGenerationPreference({ model: nextModel, ...(shouldClearThinking ? { thinking: null } : {}) });
      if (!response.ok || body.ok === false) throw new Error(responseError(body, 'Role-generation model preference save failed'));
      const savedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
      const savedThinking = typeof body.thinking === 'string' && body.thinking.trim() ? body.thinking.trim() : null;
      setPersistedGenerationModel(savedModel);
      setPersistedGenerationThinking(savedThinking);
      setGenerationPreferenceStatus('ready');
      setGenerationPreferenceError('');
      const thinkingSuffix = shouldClearThinking ? ' Reset prompt-generation thinking to Active Pi Thinking because the saved value is unsupported by that model.' : '';
      setStatus(`${savedModel ? `Saved prompt-generation model preference: ${savedModel}.` : 'Prompt generation will use the Active Pi Model.'}${thinkingSuffix}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGenerationModelSaveError(message);
      setStatus(`Prompt-generation model preference save failed: ${message}`);
    } finally {
      setGenerationModelSaving(false);
    }
  }

  async function changeGenerationThinking(thinking: string) {
    const nextThinking = thinking.trim() || null;
    if (generationPreferenceSaving) return;
    setGenerationThinkingSaving(true);
    setGenerationThinkingSaveError('');
    try {
      const { response, body } = await saveRoleGenerationPreference({ thinking: nextThinking });
      if (!response.ok || body.ok === false) throw new Error(responseError(body, 'Role-generation thinking preference save failed'));
      const savedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
      const savedThinking = typeof body.thinking === 'string' && body.thinking.trim() ? body.thinking.trim() : null;
      setPersistedGenerationModel(savedModel);
      setPersistedGenerationThinking(savedThinking);
      setGenerationPreferenceStatus('ready');
      setGenerationPreferenceError('');
      setStatus(savedThinking ? `Saved prompt-generation thinking preference: ${thinkingLabel(savedThinking)}.` : 'Prompt generation will use Active Pi Thinking.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGenerationThinkingSaveError(message);
      setStatus(`Prompt-generation thinking preference save failed: ${message}`);
    } finally {
      setGenerationThinkingSaving(false);
    }
  }

  async function generateRolePrompt() {
    const brief = roleBrief.trim();
    if (!brief) {
      setRoleGenerationError('Describe the desired role before generating a prompt.');
      return;
    }
    if (generationPreferenceSaving) {
      setRoleGenerationError('Wait for prompt-generation preferences to finish saving before generating.');
      return;
    }
    setRoleGenerating(true);
    setRoleGenerationError('');
    setRoleGenerationWarnings([]);
    setRoleGenerationModelResolution(null);
    setRoleGenerationThinkingResolution(null);
    setStatus('Generating Materia role prompt preview…');
    try {
      const generates = materiaForm.generator ? canonicalWorkItemsGeneratorConfig() : null;
      const { response, body } = await generateMateriaRole(brief, generates);
      const errorMessage = typeof body.error === 'string' ? body.error : body.error?.message;
      if (!response.ok || body.ok === false || typeof body.prompt !== 'string') throw new Error(errorMessage ?? 'Materia role generation failed.');
      const warnings = Array.isArray(body.warnings) ? body.warnings.filter((warning): warning is string => typeof warning === 'string' && Boolean(warning.trim())) : [];
      setGeneratedRolePrompt(body.prompt);
      setRoleGenerationWarnings(warnings);
      setRoleGenerationModelResolution(body.modelResolution ?? null);
      setRoleGenerationThinkingResolution(body.thinkingResolution ?? null);
      setStatus(warnings.length ? `Generated role prompt preview with warning: ${warnings.join(' ')}` : 'Generated role prompt preview. Review it before applying.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRoleGenerationError(message);
      setStatus(`Materia role generation failed: ${message}`);
    } finally {
      setRoleGenerating(false);
    }
  }

  function discardGeneratedRolePrompt() {
    setGeneratedRolePrompt('');
    setRoleGenerationError('');
    setRoleGenerationWarnings([]);
    setRoleGenerationModelResolution(null);
    setRoleGenerationThinkingResolution(null);
    setStatus('Discarded generated role prompt preview.');
  }

  function applyGeneratedRolePrompt() {
    if (!generatedRolePrompt) return;
    setMateriaForm((current) => ({ ...current, prompt: generatedRolePrompt }));
    setGeneratedRolePrompt('');
    setRoleGenerationError('');
    setRoleGenerationWarnings([]);
    setRoleGenerationModelResolution(null);
    setRoleGenerationThinkingResolution(null);
    setStatus('Applied generated role prompt to the form. Save when ready.');
  }

  function responseError(body: { error?: string | { message?: string } }, fallback: string): string {
    return typeof body.error === 'string' ? body.error : body.error?.message ?? fallback;
  }

  async function setMateriaLockState(id: string, lockState: 'locked' | 'unlocked') {
    const definition = materia?.[id];
    const policy = getMateriaEditPolicy({ id, definition, source: materiaSources[id], defaultMateriaIds });
    if (!definition || !policy.canToggleLock) {
      setStatus(policy.lockTitle);
      return;
    }
    try {
      const target = policy.saveScope;
      setStatus(`${lockState === 'locked' ? 'Locking' : 'Unlocking'} materia ${id} in ${target} scope…`);
      const { response, body } = await saveConfig(target, { materia: { [id]: { lockState } } });
      if (!response.ok || body.ok === false) throw new Error(responseError(body, 'Materia lock update failed'));
      await reloadConfig({ preserveLoadoutEdits: true, readyStatus: `${lockState === 'locked' ? 'Locked' : 'Unlocked'} materia ${id}. Loadout draft edits were left unchanged.` });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteMateria(id: string) {
    const definition = materia?.[id];
    const policy = getMateriaEditPolicy({ id, definition, source: materiaSources[id], defaultMateriaIds });
    if (!definition || !policy.canDelete) {
      setStatus(policy.deleteTitle);
      return;
    }
    try {
      const target = policy.saveScope;
      setStatus(`Deleting materia ${id} from ${target} scope…`);
      const { response, body } = await saveConfig(target, { materia: { [id]: null } });
      if (!response.ok || body.ok === false) throw new Error(responseError(body, 'Materia delete failed'));
      if (materiaForm.editingSocketId === id) setPendingReloadSelection({ id, deletedSource: policy.source });
      await reloadConfig({
        preserveLoadoutEdits: true,
        readyStatus: `Deleted materia ${id} from ${target} scope.`,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveMateriaForm() {
    try {
      const savedName = materiaForm.name.trim();
      const selectedId = materiaForm.editingSocketId;
      if (selectedId && selectedId === savedName) {
        const definition = materia?.[selectedId];
        const policy = getMateriaEditPolicy({ id: selectedId, definition, source: materiaSources[selectedId], defaultMateriaIds });
        if (!policy.canSave) throw new Error(policy.saveBlockedReason ?? `Materia definition ${selectedId} cannot be saved.`);
      }
      const patch = buildMateriaPatch(materiaForm);
      const savedBehavior = materiaForm.behavior;
      const target = materiaForm.persistScope;
      const effectiveSource = savedName ? materiaSources[savedName] : undefined;
      if (effectiveSource && effectiveSource !== target && effectiveSource !== 'default') {
        setStatus(`Saving ${savedName} to ${target} scope while ${effectiveSource} remains the effective definition…`);
      } else {
        setStatus(`Saving reusable ${savedBehavior} materia to ${target} scope…`);
      }
      const { response, body } = await saveConfig(target, patch);
      if (!response.ok || body.ok === false) throw new Error(responseError(body, 'Materia save failed'));
      const scope = body.target ?? target;
      dispatchMateriaSavedEvent({ id: savedName, name: savedName, behavior: savedBehavior, requestedScope: target, scope });
      resetMateriaEditorForm();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    metadata: { materiaSources, defaultMateriaIds },
    form: { editableDefinitionIds, materiaForm, setMateriaForm, editMateria, handleMateriaModelChange, resetMateriaEditorForm },
    selector: { items: selectorItems, selectedPolicy, duplicateMateria, setMateriaLockState, deleteMateria },
    modelOptions: {
      activeModelDescription,
      modelCatalog,
      modelCatalogError,
      modelCatalogStatus,
      modelOptions,
      selectedModel,
      thinkingLevelsForSelection,
      thinkingOptions,
    },
    colorPicker: { materiaColorDropdownRef, materiaColorOpen, setMateriaColorOpen },
    roleGeneration: {
      roleBrief,
      setRoleBrief,
      generatedRolePrompt,
      roleGenerationError,
      roleGenerationWarnings,
      roleGenerationModelResolution,
      roleGenerationThinkingResolution,
      roleGenerating,
      generationModel: {
        selectedModel: selectedGenerationModel,
        persistedModel: persistedGenerationModel,
        stalePreferenceWarning: staleGenerationModelWarning,
        availableOptions: generationModelOptions,
        activeModelLabel: activeGenerationModelLabel,
        activeModelDetail: activeGenerationModelDetail,
        preferenceStatus: generationPreferenceStatus,
        preferenceError: generationPreferenceError,
        saving: generationModelSaving,
        saveError: generationModelSaveError,
        changeModel: changeGenerationModel,
      },
      generationThinking: {
        selectedThinking: selectedGenerationThinking,
        persistedThinking: persistedGenerationThinking,
        stalePreferenceWarning: staleGenerationThinkingWarning,
        availableOptions: generationThinkingOptions,
        activeThinkingLabel: activeThinkingOptionLabel,
        activeThinkingDetail: activeGenerationThinkingDetail,
        preferenceStatus: generationPreferenceStatus,
        preferenceError: generationPreferenceError,
        saving: generationThinkingSaving,
        saveError: generationThinkingSaveError,
        changeThinking: changeGenerationThinking,
      },
      generateRolePrompt,
      applyGeneratedRolePrompt,
      discardGeneratedRolePrompt,
    },
    persistence: { saveMateriaForm, status },
  };
}
