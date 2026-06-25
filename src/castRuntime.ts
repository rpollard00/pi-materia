// Stable Pi-facing runtime facade. Implementation lives in focused runtime modules.
export {
  buildPipelineSocketDetails,
  cancelNativeCast,
  continueNativeCast,
  currentMateria,
  findMultiTurnAgentSockets,
  handleAgentEnd,
  isAgentControllerPresetActive,
  materiaStatusLabel,
  nativeTestInternals,
  prepareAgentStartSystemPrompt,
  prepareMultiTurnRefinementTurn,
  resumeNativeCast,
  reviveNativeCast,
  startNativeCast,
  validateAgentControllerMultiTurnSockets,
} from "./runtime/nativeLifecycle.js";

export type { AgentControllerValidationResult, PipelineSocketDetail } from "./runtime/nativeLifecycle.js";

export { activeMateriaSystemPrompt, buildIsolatedMateriaContext } from "./application/promptAssembly.js";
export { classifyTurnFailure, extendEdgeTraversalAllowanceForRevive, extendSameSocketRecoveryAllowanceForRevive } from "./application/recoveryPolicy.js";
export { defaultProactiveCompactionThresholdPercent } from "./runtime/compaction.js";
export {
  clearCastState,
  listLatestCastStates,
  listResumableCastStates,
  listRevivableCastStates,
  loadActiveCastState,
  loadCastStateById,
  saveCastState,
} from "./infrastructure/castStateRepository.js";
