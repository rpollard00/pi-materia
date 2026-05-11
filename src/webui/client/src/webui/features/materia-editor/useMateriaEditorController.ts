import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isGeneratorMateria } from '../../../../../../graph/generator.js';
import type { MateriaConfig } from '../../../loadoutModel.js';
import { materiaSavedEventName } from '../../constants.js';
import { generateMateriaRole, saveConfig } from '../../api/index.js';
import { useModelCatalog } from '../../hooks/useModelCatalog.js';
import type { MateriaFormState, MateriaSavedEventDetail, MateriaTabId } from '../../types.js';
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

function dispatchMateriaSavedEvent(detail: MateriaSavedEventDetail) {
  window.dispatchEvent(new CustomEvent<MateriaSavedEventDetail>(materiaSavedEventName, { detail }));
}

export interface UseMateriaEditorControllerOptions {
  materia: MateriaConfig['materia'];
  selectedTab: MateriaTabId;
  status: string;
  setStatus: (status: string) => void;
  reloadConfig: (options?: { preserveLoadoutEdits?: boolean; readyStatus?: string; cancelled?: () => boolean }) => Promise<void>;
}

export interface MateriaEditorController {
  form: {
    editableDefinitionIds: string[];
    materiaForm: MateriaFormState;
    setMateriaForm: Dispatch<SetStateAction<MateriaFormState>>;
    editMateria: (id: string) => void;
    handleMateriaModelChange: (model: string) => void;
    resetMateriaEditorForm: () => void;
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

export function useMateriaEditorController({ materia, selectedTab, status, setStatus, reloadConfig }: UseMateriaEditorControllerOptions): MateriaEditorController {
  const [materiaForm, setMateriaForm] = useState<MateriaFormState>(() => emptyMateriaForm());
  const [originalMateriaModelSettings, setOriginalMateriaModelSettings] = useState<{ editingSocketId: string; model: string; thinking: string } | undefined>();
  const { modelCatalog, modelCatalogStatus, modelCatalogError } = useModelCatalog(selectedTab);
  const [materiaColorOpen, setMateriaColorOpen] = useState(false);
  const materiaColorDropdownRef = useRef<HTMLFieldSetElement | null>(null);
  const [roleBrief, setRoleBrief] = useState('');
  const [generatedRolePrompt, setGeneratedRolePrompt] = useState('');
  const [roleGenerationError, setRoleGenerationError] = useState('');
  const [roleGenerating, setRoleGenerating] = useState(false);

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
  const modelOptions = useMemo(() => modelSelectOptions(modelCatalog, originalMateriaModelSettings), [modelCatalog, originalMateriaModelSettings]);
  const thinkingOptions = useMemo(() => thinkingSelectOptions(modelCatalog, materiaForm, originalMateriaModelSettings), [modelCatalog, materiaForm.editingSocketId, materiaForm.model, materiaForm.thinking, originalMateriaModelSettings]);
  const activeModelDescription = modelCatalog.activeModel?.label ?? modelCatalog.activeModelValue;
  const selectedModel = selectedCatalogModel(modelCatalog, materiaForm.model);
  const thinkingLevelsForSelection = selectedModel?.supportedThinkingLevels ?? [];

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

  function editMateria(id: string) {
    const definition = materia?.[id];
    if (!definition) return;
    const isUtility = definition.type === 'utility';
    const generator = isGeneratorMateria(definition);
    const savedModel = isUtility ? '' : String(definition.model ?? '').trim();
    const savedThinking = isUtility ? '' : String(definition.thinking ?? '').trim();
    setOriginalMateriaModelSettings({ editingSocketId: id, model: savedModel, thinking: savedThinking });
    setMateriaForm({
      editingSocketId: id,
      name: id,
      behavior: isUtility ? 'tool' : 'prompt',
      prompt: isUtility ? '' : String(definition.prompt ?? ''),
      toolAccess: isUtility ? 'none' : (definition.tools ?? 'none'),
      model: savedModel,
      thinking: savedThinking,
      color: String(definition.color ?? ''),
      outputFormat: definition.parse === 'json' ? 'json' : 'text',
      multiTurn: isUtility ? false : Boolean(definition.multiTurn),
      generator: !isUtility && generator,
      utility: isUtility ? String(definition.utility ?? '') : '',
      command: isUtility ? (definition.command ?? []).join(' ') : '',
      params: isUtility ? JSON.stringify(definition.params ?? {}, null, 2) : '{}',
      timeoutMs: isUtility && definition.timeoutMs !== undefined ? String(definition.timeoutMs) : '',
      persistScope: 'user',
    });
    setStatus(`Editing reusable materia definition ${id}. Save the staged form to update definitions only.`);
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

  async function saveMateriaForm() {
    try {
      const patch = buildMateriaPatch(materiaForm);
      const savedName = materiaForm.name.trim();
      const savedBehavior = materiaForm.behavior;
      const target = materiaForm.persistScope;
      setStatus(`Saving reusable ${savedBehavior} materia to ${target} scope…`);
      const { response, body } = await saveConfig(target, patch);
      if (!response.ok || body.ok === false) throw new Error(body.error ?? 'Materia save failed');
      const scope = body.target ?? target;
      dispatchMateriaSavedEvent({ id: savedName, name: savedName, behavior: savedBehavior, requestedScope: target, scope });
      resetMateriaEditorForm();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    form: { editableDefinitionIds, materiaForm, setMateriaForm, editMateria, handleMateriaModelChange, resetMateriaEditorForm },
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
