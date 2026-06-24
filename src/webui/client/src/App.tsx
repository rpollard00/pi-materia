import { useEffect, useRef } from 'react';
import { AppShell } from './webui/components/AppShell.js';
import { LocalSessionRequired } from './webui/components/LocalSessionRequired.js';
import { LoadoutListPanel } from './webui/features/loadout/LoadoutListPanel.js';
import { MateriaPalettePanel } from './webui/features/loadout/MateriaPalettePanel.js';
import { StageApplyPanel } from './webui/features/loadout/StageApplyPanel.js';
import { LoadoutGraphPanel } from './webui/features/loadout/LoadoutGraphPanel.js';
import { MateriaEditorPanel } from './webui/features/materia-editor/MateriaEditorPanel.js';
import { MonitorPanel } from './webui/features/monitor/MonitorPanel.js';
import { QuestPanel } from './webui/features/quests/QuestPanel.js';
import { useAppNavigation } from './webui/hooks/useAppNavigation.js';
import { emitLoadoutStatusToast, type LoadoutStatusOptions, type LoadoutStatusToastIntent } from './webui/utils/loadoutNotifications.js';
import { useCastCompletionToasts } from './webui/hooks/useCastCompletionToasts.js';
import { useMonitorSnapshot } from './webui/hooks/useMonitorSnapshot.js';
import { useBackendMode } from './webui/hooks/useBackendMode.js';
import { useWebuiConfig } from './webui/hooks/useWebuiConfig.js';
import { useMateriaEditorController } from './webui/features/materia-editor/useMateriaEditorController.js';
import { useLoadoutSocketInteractionController } from './webui/features/loadout/useLoadoutSocketInteractionController.js';
import { useLoadoutGraphMutationController } from './webui/features/loadout/useLoadoutGraphMutationController.js';

const isStatusAlsoShownAsValidationToast = (message: string) => /^(Cannot|Blocked\b|.*\bblocked:|Ignored\b)/i.test(message);

// Stable API entry point for the browser bundle and tests. Keep feature
// logic in hooks/controllers; App composes those boundaries into the shell.
export function App() {
  const { selectedTab, selectTab } = useAppNavigation();
  const {
    editingLoadout,
    applyExternalRuntimeActiveLoadout,
    activeLoadoutPolicy,
    editingLoadoutName,
    canDeleteLoadout,
    canRevert,
    commitEditingLoadoutRename,
    createLoadout,
    defaultLoadoutId,
    questDefaultLoadoutId,
    questDefaultLoadoutWarning,
    defaultMateriaIds,
    deleteLoadout: deleteLoadoutDraft,
    draftConfig,
    duplicateLoadout,
    isDirty,
    loadoutNameInput,
    loadoutSources,
    materiaSources,
    loadouts,
    persistedLoadouts,
    configuredActiveLoadoutId,
    reloadConfig,
    revertDraft,
    saveDraft,
    saveTarget,
    getLoadoutLockEligibility,
    setDefaultLoadout,
    setQuestDefaultLoadout,
    setLoadoutNameInput,
    setLoadoutLockState,
    setRuntimeActiveLoadout,
    setSaveTarget,
    setStatus,
    source,
    status,
    switchEditingLoadoutDraft,
    updateLoadoutDraft,
    updateLoadoutLayout,
  } = useWebuiConfig();
  const modalErrorResetRef = useRef(() => undefined as void);
  const socketPropertyErrorResetRef = useRef(() => undefined as void);
  // Backend mode discovery reports whether this UI is attached to a local
  // session, a central control plane, or both. We guard local-session-only
  // controls only when discovery has authoritatively resolved a central-admin
  // topology (no local session); during loading/error we keep the local
  // workflow fully available so the default local-only experience is never
  // blocked (docs/enterprise-control-plane.md §8, §9).
  const backendMode = useBackendMode();
  const localSessionAvailable = backendMode.loadState !== 'ready' || backendMode.hasLocalSession;
  const monitor = useMonitorSnapshot({ enabled: localSessionAvailable });
  useCastCompletionToasts(monitor);

  useEffect(() => {
    if (monitor?.activeCast?.active || !monitor?.activeLoadoutId) return;
    applyExternalRuntimeActiveLoadout(monitor.activeLoadoutId, monitor.activeLoadout);
  }, [applyExternalRuntimeActiveLoadout, monitor?.activeCast?.active, monitor?.activeLoadout, monitor?.activeLoadoutId]);

  const runningLoadoutIdentity = monitor?.activeCast?.active
    ? { loadoutId: monitor.activeCast.loadoutId, loadoutName: monitor.activeCast.loadoutName }
    : undefined;

  const setLoadoutStatus = (message: string, options?: LoadoutStatusOptions | LoadoutStatusToastIntent) => {
    emitLoadoutStatusToast(message, options);
    setStatus(message);
  };

  const socketInteractions = useLoadoutSocketInteractionController({
    activeLoadout: editingLoadout,
    activeLoadoutName: editingLoadoutName ?? '',
    editPolicy: activeLoadoutPolicy,
    deleteLoadoutDraft,
    draftConfig,
    loadouts,
    monitor,
    setStatus: setLoadoutStatus,
    switchLoadoutDraft: switchEditingLoadoutDraft,
    updateLoadoutDraft,
    updateLoadoutLayout,
    onModalErrorReset: () => modalErrorResetRef.current(),
    onSocketPropertyErrorReset: () => socketPropertyErrorResetRef.current(),
  });
  const {
    viewModel: {
      materia,
      palette,
      loadoutGraph,
      loopRegions,
      loopMemberships,
      loopExitBadges,
      routedEdges,
      selectedLoopSocketSet,
      selectedLoopSockets,
      loopSelectionRectangle,
      createLoopDisabled,
      socketLabel,
      socketDisplayLabel,
      currentMonitorSocket,
      activeMonitorSocketId,
      elapsed,
    },
    selectedMateriaId,
    setSelectedMateriaId,
    socketActionId,
    socketActionMode,
    setSocketActionMode,
    socketLayoutDrag,
    selectedLoopSocketIds,
    setSelectedLoopSocketIds,
    switchLoadout,
    deleteLoadout,
    closeSocketActionModal,
    openSocketActionModal,
    removeMateria,
    replaceMateriaFromModal,
    dragMateria,
    handleDrop,
    handleGraphDrop,
    handleSocketClick,
    beginSocketLayoutDrag,
    moveSocketLayoutDrag,
    finishSocketLayoutDrag,
    cancelSocketLayoutDrag,
    beginSocketRegionSelection,
    moveSocketRegionSelection,
    finishSocketRegionSelection,
    cancelSocketRegionSelection,
  } = socketInteractions;
  const materiaEditorController = useMateriaEditorController({ materia, materiaSources, defaultMateriaIds, selectedTab, status, setStatus, reloadConfig });

  const graphMutation = useLoadoutGraphMutationController({
    activeLoadout: editingLoadout,
    activeLoadoutName: editingLoadoutName ?? '',
    editPolicy: activeLoadoutPolicy,
    loadoutGraph,
    materia,
    selectedLoopSockets,
    setSelectedLoopSocketIds,
    setStatus: setLoadoutStatus,
    updateLoadoutDraft,
    updateLoadoutLayout,
    closeSocketActionModal,
    openSocketActionModal,
    socketLabel,
    socketDisplayLabel,
  });
  const {
    socketPropertyForm,
    setSocketPropertyForm,
    socketPropertyError,
    edgeTargetId,
    setEdgeTargetId,
    edgeCondition,
    setEdgeCondition,
    edgeMutationError,
    resetModalErrors,
    resetSocketPropertyError,
    openSocketPropertyEditor,
    openEdgeConnector,
    deleteSocket,
    createConnectedSocket,
    createTaskIteratorLoop,
    updateLoopExit,
    clearLoopExit,
    breakLoop,
    createEdge,
    removeLoopExitConnection,
    toggleLoopExitCondition,
    removeEdge,
    saveSocketProperties,
    toggleEdgeCondition,
  } = graphMutation;

  modalErrorResetRef.current = resetModalErrors;
  socketPropertyErrorResetRef.current = resetSocketPropertyError;

  const closeLoadoutSocketActionModal = () => {
    closeSocketActionModal();
    resetModalErrors();
  };

  return (
    <AppShell
      source={source}
      isDirty={isDirty}
      status={isStatusAlsoShownAsValidationToast(status) ? '' : status}
      selectedTab={selectedTab}
      onSelectTab={selectTab}
      loadoutWorkspace={(
        <div className="loadout-workspace grid gap-6 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
          <LoadoutListPanel
            loadouts={loadouts}
            editingLoadoutName={editingLoadoutName}
            configuredActiveLoadoutId={configuredActiveLoadoutId}
            runningLoadoutIdentity={runningLoadoutIdentity}
            defaultLoadoutId={defaultLoadoutId}
            questDefaultLoadoutId={questDefaultLoadoutId}
            persistedLoadouts={persistedLoadouts}
            loadoutSources={loadoutSources}
            canDeleteLoadout={canDeleteLoadout}
            onCreateLoadout={createLoadout}
            onSwitchEditingLoadout={switchLoadout}
            onDeleteLoadout={deleteLoadout}
            onDuplicateLoadout={duplicateLoadout}
            onSetDefaultLoadout={setDefaultLoadout}
            onSetQuestDefaultLoadout={setQuestDefaultLoadout}
            onSetRuntimeActiveLoadout={setRuntimeActiveLoadout}
            getLoadoutLockEligibility={getLoadoutLockEligibility}
            onToggleLoadoutLock={setLoadoutLockState}
            runtimeActiveLoadoutControlsEnabled={localSessionAvailable}
          />

          <LoadoutGraphPanel
            viewModel={{
              activeLoadout: editingLoadout,
              activeLoadoutName: editingLoadoutName,
              currentMonitorSocket: activeMonitorSocketId,
              loadoutGraph,
              loopExitBadges,
              loopMemberships,
              loopRegions,
              loopSelectionRectangle,
              materia,
              palette,
              routedEdges,
              selectedLoopSocketIds,
              selectedLoopSocketSet,
              selectedMateriaId,
              socketLayoutDrag,
              createLoopDisabled: createLoopDisabled || !activeLoadoutPolicy.canEdit,
              editPolicy: activeLoadoutPolicy,
              socketDisplayLabel,
              socketLabel,
            }}
            toolbar={{
              loadoutNameInput,
              setLoadoutNameInput,
              commitActiveLoadoutRename: commitEditingLoadoutRename,
            }}
            canvasActions={{
              beginSocketLayoutDrag,
              beginSocketRegionSelection,
              cancelSocketLayoutDrag,
              cancelSocketRegionSelection,
              dragMateria,
              finishSocketLayoutDrag,
              finishSocketRegionSelection,
              handleDrop,
              handleGraphDrop,
              handleSocketClick,
              moveSocketLayoutDrag,
              moveSocketRegionSelection,
              toggleEdgeCondition,
              toggleLoopExitCondition,
            }}
            loopActions={{
              breakLoop,
              clearLoopExit,
              createTaskIteratorLoop,
              updateLoopExit,
            }}
            socketModal={{
              state: {
                edgeCondition,
                edgeMutationError,
                edgeTargetId,
                socketActionId,
                socketActionMode,
                socketPropertyError,
                socketPropertyForm,
              },
              actions: {
                closeSocketActionModal: closeLoadoutSocketActionModal,
                createConnectedSocket,
                createEdge,
                deleteSocket,
                openEdgeConnector,
                openSocketPropertyEditor,
                removeEdge,
                removeLoopExitConnection,
                removeMateria,
                replaceMateriaFromModal,
                saveSocketProperties,
                setEdgeCondition,
                setEdgeTargetId,
                setSocketActionMode,
                setSocketPropertyForm,
              },
            }}
          />

          <aside className="loadout-side-panel flex flex-col gap-6">
            <MateriaPalettePanel
              palette={palette}
              materia={materia}
              selectedMateriaId={selectedMateriaId}
              onDragMateria={dragMateria}
              onSelectMateria={setSelectedMateriaId}
            />

            <StageApplyPanel
              saveTarget={saveTarget}
              isDirty={isDirty}
              canRevert={canRevert}
              onSaveTargetChange={setSaveTarget}
              onSave={() => saveDraft().catch(() => undefined)}
              onRevert={revertDraft}
            />
          </aside>
        </div>
      )}
      materiaEditorWorkspace={<MateriaEditorPanel controller={materiaEditorController} toolRegistry={monitor?.toolRegistry} />}
      questWorkspace={
        localSessionAvailable ? (
          <QuestPanel
            persistedLoadouts={persistedLoadouts}
            questDefaultLoadoutId={questDefaultLoadoutId}
            questDefaultLoadoutWarning={questDefaultLoadoutWarning}
            setQuestDefaultLoadout={setQuestDefaultLoadout}
          />
        ) : (
          <LocalSessionRequired
            title="Quests need a local session"
            description="The quest board is a project-local outer-loop queue tied to this repository session. Connect this UI to a local pi-materia session to view, create, and run quests."
            testId="quests-local-session-required"
          />
        )
      }
      monitorWorkspace={
        localSessionAvailable ? (
          <MonitorPanel monitor={monitor} currentMonitorSocket={currentMonitorSocket} elapsed={elapsed} />
        ) : (
          <LocalSessionRequired
            title="Live monitoring needs a local session"
            description="The runtime event monitor streams live events from the local pi-materia session that launched this UI. Connect this UI to a local session to monitor an active cast."
            testId="monitor-local-session-required"
          />
        )
      }
    />
  );
}
