import { cloneExecutionScope, type ExecutionScope } from "../domain/executionScope.js";
import type { NominalParallelLaneProgressDefinition } from "../domain/parallelProgress.js";
import type {
  MateriaPipelineConfig,
  ResolvedMateriaPipeline,
  UsageCost,
  UsageTokens,
} from "../types.js";

/** A graph compiled for one isolated child lane. */
export type ChildCastPipeline = MateriaPipelineConfig | ResolvedMateriaPipeline;

/**
 * The application-facing representation of a compiled child loadout.
 *
 * The runner deliberately treats the graph as data. Graph extraction belongs to
 * the graph layer and process/session concerns belong to infrastructure.
 */
export interface ChildCastCompiledLoadout {
  /** Stable ephemeral identity produced by the loop compiler. */
  childLoadoutId?: string;
  /** The extracted sequential graph. */
  loadout: ChildCastPipeline;
  /** State seeded into the child cast before its first socket starts. */
  initialData: Readonly<Record<string, unknown>>;
  /** Content-free graph metadata used only by the isolated child progress emitter. */
  nominalProgress?: NominalParallelLaneProgressDefinition;
  /** Optional provenance retained for artifacts and diagnostics. */
  loopId?: string;
  laneId?: string;
}

/** Stable identity shared by all observations of one child lane cast. */
export interface ChildCastIdentity {
  childCastId: string;
  parentCastId: string;
  loopId: string;
  laneId: string;
}

/** Files owned by a child runner for one lane. */
export interface ChildCastPaths {
  /** Persistent Pi session file used by the child process. */
  sessionPath: string;
  /** Root directory containing child cast artifacts. */
  artifactRoot: string;
  /** Child run directory, when distinct from the artifact root. */
  runDirectory: string;
}

export type ChildCastStatus = "queued" | "starting" | "running" | "succeeded" | "failed" | "interrupted";
export type ChildCastTerminalStatus = Extract<ChildCastStatus, "succeeded" | "failed" | "interrupted">;

/** The lifecycle operation represented by a child launch. */
export type ChildCastOperation = "start" | "revive" | "recast";
export type ChildCastRecoveryOperation = Exclude<ChildCastOperation, "start">;
export type LegacyChildCastRecoveryOperation = "resume" | "restart";

export interface ChildCastUsage {
  tokens: UsageTokens;
  cost: UsageCost;
}

export const CHILD_USAGE_CHECKPOINT_EVENT_TYPE = "pi_materia_child_usage" as const;
export const CHILD_PROGRESS_CHECKPOINT_EVENT_TYPE = "pi_materia_child_progress" as const;

export const EMPTY_CHILD_CAST_USAGE: ChildCastUsage = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Preserve the monotonic baseline of cumulative child usage checkpoints. */
export function mergeChildCastUsage(previous: ChildCastUsage, checkpoint: ChildCastUsage): ChildCastUsage {
  return {
    tokens: {
      input: Math.max(previous.tokens.input, checkpoint.tokens.input),
      output: Math.max(previous.tokens.output, checkpoint.tokens.output),
      cacheRead: Math.max(previous.tokens.cacheRead, checkpoint.tokens.cacheRead),
      cacheWrite: Math.max(previous.tokens.cacheWrite, checkpoint.tokens.cacheWrite),
      total: Math.max(previous.tokens.total, checkpoint.tokens.total),
    },
    cost: {
      input: Math.max(previous.cost.input, checkpoint.cost.input),
      output: Math.max(previous.cost.output, checkpoint.cost.output),
      cacheRead: Math.max(previous.cost.cacheRead, checkpoint.cost.cacheRead),
      cacheWrite: Math.max(previous.cost.cacheWrite, checkpoint.cost.cacheWrite),
      total: Math.max(previous.cost.total, checkpoint.cost.total),
    },
  };
}

/** Default replay tails retained by child runners; sequence numbers remain global. */
export const DEFAULT_CHILD_CAST_RETAINED_EVENTS = 256;
export const DEFAULT_CHILD_CAST_RETAINED_DIAGNOSTICS = 64;

export type ChildCastDiagnosticSeverity = "info" | "warning" | "error";

/** A bounded, secret-free diagnostic suitable for durable lane state. */
export interface ChildCastDiagnostic {
  code: string;
  message: string;
  severity: ChildCastDiagnosticSeverity;
  occurredAt: number;
  details?: Readonly<Record<string, unknown>>;
}

/** The process-independent result reported when a child reaches a terminal state. */
export interface ChildCastTerminalResult {
  status: ChildCastTerminalStatus;
  /** Whether the child output is eligible for the lane's accepted head. */
  accepted: boolean;
  endedAt: number;
  message?: string;
  error?: string;
  output?: unknown;
  /** Aggregate child usage at terminal time, when the adapter reports it. */
  usage?: ChildCastUsage;
  /** Validated scope active when the child became terminal. */
  executionScope?: ExecutionScope;
  /** Set when the terminal state was caused by an abort request. */
  abortReason?: string;
}

export interface ChildCastAbortMetadata {
  reason: string;
  requestedAt: number;
  completedAt?: number;
}

/** A runtime-neutral event forwarded from a child session. */
export interface ChildCastStreamEvent {
  childCastId: string;
  sequence: number;
  type: string;
  occurredAt: number;
  payload?: unknown;
  socketId?: string;
  workItemId?: string;
  /** Cumulative child-cast usage snapshot; repeated events must be idempotent. */
  usage?: ChildCastUsage;
  /** Bounded nominal position, present only on dedicated progress checkpoints. */
  position?: number;
  /** Bounded nominal total, present only on dedicated progress checkpoints. */
  total?: number;
}

/**
 * Process-independent information needed to recover a retained child cast.
 *
 * This descriptor intentionally excludes process state, replay tails, and
 * terminal output. It is safe for coordinators to persist and pass to a new
 * runner instance after the original process has been retired.
 */
export interface ChildCastRecoveryDescriptor {
  identity: ChildCastIdentity;
  request: string;
  /** Stable child-process/session cwd; the active execution scope may move to another workspace. */
  cwd: string;
  compiledLoadout: ChildCastCompiledLoadout;
  paths: ChildCastPaths;
  executionScope: ExecutionScope;
  /** Attempt most recently completed (or currently retained) by the child. */
  attempt: number;
  /** Monotonic usage already accounted for before the next attempt starts. */
  usageBaseline: ChildCastUsage;
}

/** Durable state returned by start, observe, and recovery operations. */
export interface ChildCastSnapshot {
  identity: ChildCastIdentity;
  request: string;
  cwd: string;
  compiledLoadout: ChildCastCompiledLoadout;
  paths: ChildCastPaths;
  executionScope: ExecutionScope;
  status: ChildCastStatus;
  /** False until a terminal result explicitly accepts the child output. */
  accepted: boolean;
  attempt: number;
  /** The operation that created this attempt. Initial starts report `start`. */
  operation: ChildCastOperation;
  startedAt: number;
  updatedAt: number;
  usage: ChildCastUsage;
  events: readonly ChildCastStreamEvent[];
  diagnostics: readonly ChildCastDiagnostic[];
  terminalResult?: ChildCastTerminalResult;
  abort?: ChildCastAbortMetadata;
}

export interface StartChildCastInput {
  identity: ChildCastIdentity;
  request: string;
  cwd: string;
  compiledLoadout: ChildCastCompiledLoadout;
  paths: ChildCastPaths;
  /** Detached parent branch scope; cwd may intentionally equal another lane. */
  executionScope?: ExecutionScope;
  /** Initial attempt number for revival/recovery; defaults to one. */
  attempt?: number;
}

/**
 * File-backed handoff consumed by an isolated Pi process.
 *
 * Keeping the request and compiled graph in a file means a lane launch never
 * places user-controlled prompt or graph data in argv. The file is an
 * implementation-neutral DTO so the infrastructure adapter and the Pi
 * extension can agree on the launch protocol without sharing runtime objects.
 */
export interface ChildCastLaunchSpec {
  version: 1;
  identity: ChildCastIdentity;
  request: string;
  cwd: string;
  compiledLoadout: ChildCastCompiledLoadout;
  paths: ChildCastPaths;
  executionScope: ExecutionScope;
  attempt: number;
  /** Operation represented by this launch. Legacy files normalize to `start`. */
  operation: ChildCastOperation;
  /** Explicit config generated for the child, when one is required. */
  configPath?: string;
}

export interface ChildCastStartResult {
  childCastId: string;
  snapshot: ChildCastSnapshot;
}

export interface ChildCastObserveInput {
  childCastId: string;
  /** Return only events after this per-child sequence number. */
  afterSequence?: number;
}

export interface ChildCastObservation {
  childCastId: string;
  snapshot: ChildCastSnapshot;
  events: readonly ChildCastStreamEvent[];
}

export interface ChildCastObserver {
  onEvent?(event: ChildCastStreamEvent): void | Promise<void>;
  onSnapshot?(snapshot: ChildCastSnapshot): void | Promise<void>;
  onTerminal?(result: ChildCastTerminalResult): void | Promise<void>;
}

export interface ChildCastSubscription {
  readonly childCastId: string;
  unsubscribe(): void;
}

/** Input accepted by explicit revive and recast operations. */
export interface ChildCastRecoveryInput {
  /** Optional when the descriptor identity is the source of truth. */
  childCastId?: string;
  /** Durable retained state. The other names are compatibility aliases. */
  recovery?: ChildCastRecoveryDescriptor;
  descriptor?: ChildCastRecoveryDescriptor;
  recoveryDescriptor?: ChildCastRecoveryDescriptor;
  /** Optional for unified callers; explicit methods validate this value. */
  operation?: ChildCastRecoveryOperation;
}

export interface ReviveChildCastInput extends ChildCastRecoveryInput {
  operation?: "revive";
}

export interface RecastChildCastInput extends ChildCastRecoveryInput {
  operation?: "recast";
}

/** Legacy input retained for callers that have not migrated to explicit verbs. */
export interface ResumeChildCastInput {
  childCastId: string;
  /** `resume` normalizes to revive; `restart` normalizes to recast. */
  mode?: LegacyChildCastRecoveryOperation;
  recovery?: ChildCastRecoveryDescriptor;
  descriptor?: ChildCastRecoveryDescriptor;
  recoveryDescriptor?: ChildCastRecoveryDescriptor;
}

export interface ChildCastAbortInput {
  childCastId: string;
  reason: string;
}

export type ChildCastAbortStatus = "aborted" | "already_terminal" | "not_found";

export interface ChildCastAbortResult {
  childCastId: string;
  status: ChildCastAbortStatus;
  /** True only when this request caused the child to become interrupted. */
  aborted: boolean;
  snapshot?: ChildCastSnapshot;
}

export interface RetireChildCastInput {
  childCastId: string;
  /** Keep only the durable identity needed to resume a failed/interrupted lane. */
  retainForResume: boolean;
}

/**
 * Application port for isolated child casts.
 *
 * Implementations may use Pi sessions, subprocesses, or a deterministic fake,
 * but callers only exchange DTOs and never depend on those implementations.
 */
export interface ChildCastRunnerPort {
  start(input: StartChildCastInput): Promise<ChildCastStartResult>;
  observe(input: ChildCastObserveInput): Promise<ChildCastObservation | undefined>;
  subscribe(input: ChildCastObserveInput, observer: ChildCastObserver): ChildCastSubscription;
  revive(input: ReviveChildCastInput | ChildCastRecoveryDescriptor): Promise<ChildCastStartResult>;
  recast(input: RecastChildCastInput | ChildCastRecoveryDescriptor): Promise<ChildCastStartResult>;
  /** @deprecated Use revive or recast. Legacy modes are normalized. */
  resume(input: ResumeChildCastInput): Promise<ChildCastStartResult>;
  abort(input: ChildCastAbortInput): Promise<ChildCastAbortResult>;
  /** Release terminal process, parser, capture, observer, and replay resources. */
  retire(input: RetireChildCastInput): Promise<void>;
}

/**
 * Validate and clone a durable recovery descriptor before it crosses an
 * application/infrastructure boundary.
 */
export function validateChildCastRecoveryDescriptor(input: unknown): ChildCastRecoveryDescriptor {
  if (!isRecord(input)) throw new Error("Child cast recovery descriptor must be an object.");
  const identity = validateIdentity(input.identity);
  const request = requiredString(input.request, "request");
  const cwd = requiredString(input.cwd, "cwd");
  const paths = validatePaths(input.paths);
  if (!isRecord(input.compiledLoadout) || !input.compiledLoadout.loadout || !isRecord(input.compiledLoadout.initialData)) {
    throw new Error("Child cast recovery descriptor compiledLoadout must contain a loadout and initialData object.");
  }
  if (!isRecord(input.executionScope)) throw new Error("Child cast recovery descriptor executionScope must be an object.");
  // Recovery retains both the Pi session's process cwd and its current active
  // execution scope. A utility may have moved that scope to a branch workspace,
  // so unlike an initial child start these two cwd values need not be equal.
  const scope = cloneExecutionScope(input.executionScope as ExecutionScope);
  const attempt = input.attempt;
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) throw new Error("Child cast recovery descriptor attempt must be a positive safe integer.");
  const usageBaseline = validateUsage(input.usageBaseline, "usageBaseline");
  return {
    identity,
    request,
    cwd,
    compiledLoadout: cloneValue(input.compiledLoadout) as ChildCastCompiledLoadout,
    paths,
    executionScope: scope,
    attempt: attempt as number,
    usageBaseline,
  };
}

/** Build a recovery descriptor from a child snapshot without retaining replay data. */
export function createChildCastRecoveryDescriptor(snapshot: ChildCastSnapshot): ChildCastRecoveryDescriptor {
  return validateChildCastRecoveryDescriptor({
    identity: snapshot.identity,
    request: snapshot.request,
    cwd: snapshot.cwd,
    compiledLoadout: snapshot.compiledLoadout,
    paths: snapshot.paths,
    executionScope: snapshot.executionScope,
    attempt: snapshot.attempt,
    usageBaseline: snapshot.usage,
  });
}

/** Compatibility spelling for code that treats the descriptor as a projection. */
export const childCastRecoveryDescriptorFromSnapshot = createChildCastRecoveryDescriptor;

/** Normalize old resume/restart names at the contract boundary. */
export function normalizeChildCastRecoveryOperation(operation: ChildCastRecoveryOperation | LegacyChildCastRecoveryOperation | undefined): ChildCastRecoveryOperation {
  if (operation === undefined || operation === "resume" || operation === "revive") return "revive";
  if (operation === "restart" || operation === "recast") return "recast";
  throw new Error(`Unknown child cast recovery operation ${JSON.stringify(operation)}.`);
}

/** Short aliases for callers that prefer the port-oriented names. */
export type ChildCastRunner = ChildCastRunnerPort;
export type ChildCastStartInput = StartChildCastInput;
export type ChildCastResumeInput = ResumeChildCastInput;
export type ChildCastReviveInput = ReviveChildCastInput;
export type ChildCastRecastInput = RecastChildCastInput;
export type ChildCastRecoveryRequest = ChildCastRecoveryInput;
export type ChildCastObserveRequest = ChildCastObserveInput;
export type ChildCastAbortRequest = ChildCastAbortInput;

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Child cast recovery descriptor ${label} must be a non-empty string.`);
  return value;
}

function validateIdentity(value: unknown): ChildCastIdentity {
  if (!isRecord(value)) throw new Error("Child cast recovery descriptor identity must be an object.");
  return {
    childCastId: requiredString(value.childCastId, "identity.childCastId"),
    parentCastId: requiredString(value.parentCastId, "identity.parentCastId"),
    loopId: requiredString(value.loopId, "identity.loopId"),
    laneId: requiredString(value.laneId, "identity.laneId"),
  };
}

function validatePaths(value: unknown): ChildCastPaths {
  if (!isRecord(value)) throw new Error("Child cast recovery descriptor paths must be an object.");
  return {
    sessionPath: requiredString(value.sessionPath, "paths.sessionPath"),
    artifactRoot: requiredString(value.artifactRoot, "paths.artifactRoot"),
    runDirectory: requiredString(value.runDirectory, "paths.runDirectory"),
  };
}

function validateUsage(value: unknown, label: string): ChildCastUsage {
  if (!isRecord(value) || !isRecord(value.tokens) || !isRecord(value.cost)) throw new Error(`Child cast recovery descriptor ${label} must contain tokens and cost.`);
  const tokens = validateUsageNumbers(value.tokens, `${label}.tokens`);
  const cost = validateUsageNumbers(value.cost, `${label}.cost`);
  return { tokens, cost };
}

function validateUsageNumbers(value: Record<string, any>, label: string): UsageTokens {
  const fields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  const result = {} as UsageTokens;
  for (const field of fields) {
    const number = value[field];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new Error(`Child cast recovery descriptor ${label}.${field} must be a finite non-negative number.`);
    result[field] = number;
  }
  return result;
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, cloneValue(child)])) as T;
}
