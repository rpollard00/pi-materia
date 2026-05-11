import { useRef } from 'react';
import { AppShell } from './webui/components/AppShell.js';
import { LoadoutListPanel } from './webui/features/loadout/LoadoutListPanel.js';
import { MateriaPalettePanel } from './webui/features/loadout/MateriaPalettePanel.js';
import { StageApplyPanel } from './webui/features/loadout/StageApplyPanel.js';
import { LoadoutGraphPanel } from './webui/features/loadout/LoadoutGraphPanel.js';
import { MateriaEditorPanel } from './webui/features/materia-editor/MateriaEditorPanel.js';
import { MonitorPanel } from './webui/features/monitor/MonitorPanel.js';
import { useAppNavigation } from './webui/hooks/useAppNavigation.js';
import { useCastCompletionToasts } from './webui/hooks/useCastCompletionToasts.js';
import { useMonitorSnapshot } from './webui/hooks/useMonitorSnapshot.js';
import { useWebuiConfig } from './webui/hooks/useWebuiConfig.js';
import { useMateriaEditorController } from './webui/features/materia-editor/useMateriaEditorController.js';
import { useLoadoutSocketInteractionController } from './webui/features/loadout/useLoadoutSocketInteractionController.js';
import { useLoadoutGraphMutationController } from './webui/features/loadout/useLoadoutGraphMutationController.js';

// Compatibility entry point for the browser bundle and tests. Keep feature
// logic in hooks/controllers; App composes those boundaries into the shell.
export function App() {
  const { selectedTab, selectTab } = useAppNavigation();
  const {
    activeLoadout,
    activeLoadoutName,
    canDeleteLoadout,
    canRevert,
    commitActiveLoadoutRename,
    createLoadout,
    deleteLoadout: deleteLoadoutDraft,
    draftConfig,
    isDirty,
    loadoutNameInput,
    loadoutSources,
    loadouts,
    persistedActiveLoadoutName,
    persistedLoadouts,
    reloadConfig,
    revertDraft,
    saveDraft,
    saveTarget,
    setLoadoutNameInput,
    setPersistedActiveLoadout,
    setSaveTarget,
    setStatus,
    source,
    status,
    switchLoadout: switchLoadoutDraft,
    updateLoadoutDraft,
    updateLoadoutLayout,
  } = useWebuiConfig();
  const modalErrorResetRef = useRef(() => undefined as void);
  const socketPropertyErrorResetRef = useRef(() => undefined as void);
  const monitor = useMonitorSnapshot();
  useCastCompletionToasts(monitor);

  const socketInteractions = useLoadoutSocketInteractionController({
    activeLoadout,
    activeLoadoutName,
    deleteLoadoutDraft,
    draftConfig,
    loadouts,
    monitor,
    setStatus,
    switchLoadoutDraft,
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
  const materiaEditorController = useMateriaEditorController({ materia, selectedTab, status, setStatus, reloadConfig });

  const graphMutation = useLoadoutGraphMutationController({
    activeLoadout,
    activeLoadoutName,
    loadoutGraph,
    materia,
    selectedLoopSockets,
    setSelectedLoopSocketIds,
    setStatus,
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
    removeLegacyNextEdge,
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
      selectedTab={selectedTab}
      onSelectTab={selectTab}
      loadoutWorkspace={(
        <div className="loadout-workspace grid gap-6 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
          <LoadoutListPanel
            loadouts={loadouts}
            activeLoadoutName={activeLoadoutName}
            persistedActiveLoadoutName={persistedActiveLoadoutName}
            persistedLoadouts={persistedLoadouts}
            loadoutSources={loadoutSources}
            canDeleteLoadout={canDeleteLoadout}
            onCreateLoadout={createLoadout}
            onSwitchLoadout={switchLoadout}
            onDeleteLoadout={deleteLoadout}
            onSetActiveLoadout={setPersistedActiveLoadout}
          />

          <LoadoutGraphPanel
            viewModel={{
              activeLoadout,
              activeLoadoutName,
              currentMonitorSocket,
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
              createLoopDisabled,
              socketDisplayLabel,
              socketLabel,
            }}
            toolbar={{
              loadoutNameInput,
              setLoadoutNameInput,
              commitActiveLoadoutRename,
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
                removeLegacyNextEdge,
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
              status={status}
              onSaveTargetChange={setSaveTarget}
              onSave={() => saveDraft().catch(() => undefined)}
              onRevert={revertDraft}
            />
          </aside>
        </div>
      )}
      materiaEditorWorkspace={<MateriaEditorPanel controller={materiaEditorController} />}
      monitorWorkspace={<MonitorPanel monitor={monitor} currentMonitorSocket={currentMonitorSocket} elapsed={elapsed} />}
    />
  );
}
