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
  parallelLaneRecovery,
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
  ParallelFanInCompletionInput,
  ParallelRunFailureInput,
  ParallelLaneArtifactIdentity,
  ParallelLaneArtifactPaths,
  ParallelLaneArtifactPort,
  ParallelLaneDiagnosticArtifact,
  ParallelLaneEventArtifact,
  NormalizedParallelPlan,
  NormalizedParallelStream,
  ParallelLoopCancellationInput,
  ParallelLoopDispatchInput,
  ParallelLoopRecoveryInput,
  ParallelLoopRecoveryOperation,
  ParallelLoopRecoveryResult,
  ParallelLoopReviveInput,
  ParallelLoopReviveResult,
  ParallelRecoveryInput,
  ParallelRecoveryOperation,
  ParallelLoopDispatcherDependencies,
} from "./runtime/parallelDispatcher.js";

export { activeMateriaSystemPrompt, buildIsolatedMateriaContext, projectMateriaContext } from "./application/promptAssembly.js";
export { summarizeParallelRun, summarizeParallelRuns } from "./application/parallelMonitoring.js";
export { collectAcceptedParallelBranches, intrinsicParallelFanInHandoff } from "./domain/parallelFanIn.js";
export type { IntrinsicParallelFanInResult, OrderedParallelBranchResult } from "./domain/parallelFanIn.js";
export type { ParallelLaneMonitorSummary, ParallelRunMonitorCounts, ParallelRunMonitorSummary } from "./application/parallelMonitoring.js";
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
  isParallelLaneRevivalCandidate,
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
