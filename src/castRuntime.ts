// Stable Pi-facing runtime facade. Implementation lives in focused runtime modules.
export {
  continueNativeCast,
  currentMateria,
  handleAgentEnd,
  materiaStatusLabel,
  nativeTestInternals,
  prepareAgentStartSystemPrompt,
  prepareMultiTurnRefinementTurn,
  resumeNativeCast,
  reviveNativeCast,
  startNativeCast,
} from "./runtime/nativeLifecycle.js";

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
