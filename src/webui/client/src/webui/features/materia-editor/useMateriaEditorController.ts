import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isGeneratorMateria } from '../../../../../../graph/generator.js';
import type { MateriaConfig } from '../../../loadoutModel.js';
import { materiaSavedEventName } from '../../constants.js';
import { generateMateriaRole, saveConfig } from '../../api/index.js';
import { useModelCatalog } from '../../hooks/useModelCatalog.js';
import type { LoadoutSourceScope, MateriaFormState, MateriaSavedEventDetail, MateriaTabId } from '../../types.js';
import {
  buildMateriaPatch,
  canonicalWorkItemsGeneratorConfig,
  emptyMateriaForm,
} from '../../utils/forms.js';
import {
  canKeepThinkingForModel,
  modelSelectOptions,
  selectedCatalogModel,
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
    roleGenerating: boolean;
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
  const [roleGenerating, setRoleGenerating] = useState(false);
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

  async function generateRolePrompt() {
    const brief = roleBrief.trim();
    if (!brief) {
      setRoleGenerationError('Describe the desired role before generating a prompt.');
      return;
    }
    setRoleGenerating(true);
    setRoleGenerationError('');
    setStatus('Generating Materia role prompt preview…');
    try {
      const generates = materiaForm.generator ? canonicalWorkItemsGeneratorConfig() : null;
      const { response, body } = await generateMateriaRole(brief, generates);
      const errorMessage = typeof body.error === 'string' ? body.error : body.error?.message;
      if (!response.ok || body.ok === false || typeof body.prompt !== 'string') throw new Error(errorMessage ?? 'Materia role generation failed.');
      setGeneratedRolePrompt(body.prompt);
      setStatus('Generated role prompt preview. Review it before applying.');
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
    setStatus('Discarded generated role prompt preview.');
  }

  function applyGeneratedRolePrompt() {
    if (!generatedRolePrompt) return;
    setMateriaForm((current) => ({ ...current, prompt: generatedRolePrompt }));
    setGeneratedRolePrompt('');
    setRoleGenerationError('');
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
      roleGenerating,
      generateRolePrompt,
      applyGeneratedRolePrompt,
      discardGeneratedRolePrompt,
    },
    persistence: { saveMateriaForm, status },
  };
}
