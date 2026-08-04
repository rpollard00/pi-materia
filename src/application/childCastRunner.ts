import type { ExecutionScope } from "../domain/executionScope.js";
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

export interface ChildCastUsage {
  tokens: UsageTokens;
  cost: UsageCost;
}

export const CHILD_USAGE_CHECKPOINT_EVENT_TYPE = "pi_materia_child_usage" as const;

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
}

/** Durable state returned by start, observe, and resume. */
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

export interface ResumeChildCastInput {
  childCastId: string;
  /** Resume keeps the same lane identity and increments its attempt. */
  mode?: "resume" | "restart";
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
  resume(input: ResumeChildCastInput): Promise<ChildCastStartResult>;
  abort(input: ChildCastAbortInput): Promise<ChildCastAbortResult>;
  /** Release terminal process, parser, capture, observer, and replay resources. */
  retire(input: RetireChildCastInput): Promise<void>;
}

/** Short aliases for callers that prefer the port-oriented names. */
export type ChildCastRunner = ChildCastRunnerPort;
export type ChildCastStartInput = StartChildCastInput;
export type ChildCastResumeInput = ResumeChildCastInput;
export type ChildCastObserveRequest = ChildCastObserveInput;
export type ChildCastAbortRequest = ChildCastAbortInput;
