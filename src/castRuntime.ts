// Stable Pi-facing runtime facade. Implementation lives in focused runtime modules.
export {
  buildPipelineSocketDetails,
  cancelNativeCast,
  continueNativeCast,
  currentMateria,
  findMultiTurnAgentSockets,
  handleAgentEnd,
  handleAgentHandoffToolExecutionEnd,
  handleAgentSettled,
  isAgentControllerPresetActive,
  materiaStatusLabel,
  nativeTestInternals,
  prepareAgentStartSystemPrompt,
  prepareMultiTurnRefinementTurn,
  persistCastBudget,
  reactivateQueuedNativeCast,
  resumeNativeCast,
  reviveNativeCast,
  startNativeCast,
  validateAgentControllerMultiTurnSockets,
} from "./runtime/nativeLifecycle.js";

export type { AgentControllerValidationResult, PipelineSocketDetail } from "./runtime/nativeLifecycle.js";
export {
  createParallelLaneScheduler,
  createParallelLoopDispatcher,
  parallelLoopForSocket,
  ParallelLaneScheduler,
  ParallelLoopDispatcher,
} from "./runtime/parallelDispatcher.js";
export type {
  ParallelLaneArtifactIdentity,
  ParallelLaneArtifactPaths,
  ParallelLaneArtifactPort,
  ParallelLaneDiagnosticArtifact,
  ParallelLaneEventArtifact,
  ParallelLaneRevisionArtifact,
  NormalizedParallelPlan,
  NormalizedParallelStream,
  ParallelLoopDispatchInput,
  ParallelLoopDispatcherDependencies,
  ParallelWorkspaceInspection,
  ParallelWorkspacePort,
  ParallelWorkspaceRecord,
  ParallelWorkspaceRevision,
} from "./runtime/parallelDispatcher.js";

export { activeMateriaSystemPrompt, buildIsolatedMateriaContext, projectMateriaContext } from "./application/promptAssembly.js";
export { classifyTurnFailure, extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive } from "./application/recoveryPolicy.js";
export { defaultProactiveCompactionThresholdPercent } from "./runtime/compaction.js";
export {
  appendParallelLaneDiagnostic,
  applyParallelLaneTransition,
  applyParallelLaneTransitionToCast,
  applyParallelRunPhaseTransition,
  applyParallelRunTransition,
  applyParallelTransitionToCastState,
  attachParallelRunToCastState,
  beginParallelCoordinator,
  beginParallelLaneAttempt,
  cloneParallelRunState,
  createParallelCoordinatorState,
  createParallelRun,
  createParallelRunState,
  guardedParallelLaneTransition,
  initializeParallelRunState,
  parallelLaneKey,
  parallelRunKey,
  restartParallelLane,
  restartParallelLaneAttempt,
  reviveParallelLane,
  transitionParallelLane,
  transitionParallelLaneState,
  transitionParallelRun,
  transitionParallelRunPhase,
  updateParallelRunState,
} from "./runtime/parallelCoordinatorState.js";
export type {
  CastParallelTransitionResult,
  CreateParallelRunStateInput,
  ParallelLaneTransitionInput,
  ParallelRunGuard,
  ParallelRunPhaseTransitionInput,
  ParallelRunTransitionResult,
  ParallelTransitionGuard,
  RestartParallelLaneInput,
  ParallelTransitionIgnoreReason,
} from "./runtime/parallelCoordinatorState.js";
export {
  clearCastState,
  listLatestCastStates,
  listResumableCastStates,
  listRevivableCastStates,
  loadActiveCastState,
  loadCastStateById,
  saveCastState,
} from "./infrastructure/castStateRepository.js";
