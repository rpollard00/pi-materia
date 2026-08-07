import { cloneExecutionScope, type ExecutionScope } from "../domain/executionScope.js";
import {
  DEFAULT_CHILD_CAST_RETAINED_DIAGNOSTICS,
  DEFAULT_CHILD_CAST_RETAINED_EVENTS,
  EMPTY_CHILD_CAST_USAGE,
  mergeChildCastUsage,
  type ChildCastAbortInput,
  type ChildCastDiagnostic,
  type ChildCastObserver,
  type ChildCastOperation,
  type ChildCastRecoveryDescriptor,
  type ChildCastRecoveryInput,
  type ChildCastRunnerPort,
  type ChildCastSnapshot,
  type ChildCastStartResult,
  type ChildCastStatus,
  type ChildCastStreamEvent,
  type ChildCastTerminalResult,
  type ChildCastUsage,
  type ChildCastObserveInput,
  type RecastChildCastInput,
  type ResumeChildCastInput,
  type ReviveChildCastInput,
  type StartChildCastInput,
  type ChildCastSubscription,
  createChildCastRecoveryDescriptor,
  normalizeChildCastRecoveryOperation,
  validateChildCastRecoveryDescriptor,
} from "./childCastRunner.js";

export interface FakeChildCastRunnerOptions {
  /** Injectable clock makes scheduler tests independent of wall-clock time. */
  now?: () => number;
  /** New children start running by default; queued is useful for dispatch tests. */
  initialStatus?: Extract<ChildCastStatus, "queued" | "starting" | "running">;
  /** Maximum observational replay entries retained per child. */
  maxRetainedEvents?: number;
  /** Maximum diagnostics retained per child snapshot. */
  maxRetainedDiagnostics?: number;
}

export interface FakeChildCastEventInput {
  type: string;
  payload?: unknown;
  socketId?: string;
  workItemId?: string;
  usage?: ChildCastUsage;
  position?: number;
  total?: number;
  occurredAt?: number;
}

export interface CompleteChildCastInput {
  accepted?: boolean;
  message?: string;
  output?: unknown;
  usage?: ChildCastUsage;
  executionScope?: ExecutionScope;
  occurredAt?: number;
}

export interface FailChildCastInput {
  error: string;
  message?: string;
  usage?: ChildCastUsage;
  occurredAt?: number;
}

/**
 * In-memory child runner for deterministic coordinator and scheduler tests.
 * It never creates processes, sessions, files, or workspaces.
 */
export class FakeChildCastRunner implements ChildCastRunnerPort {
  private readonly records = new Map<string, ChildCastSnapshot>();
  private readonly observers = new Map<string, Map<number, ChildCastObserver>>();
  private readonly now: () => number;
  private readonly initialStatus: Extract<ChildCastStatus, "queued" | "starting" | "running">;
  private readonly maxRetainedEvents: number;
  private readonly maxRetainedDiagnostics: number;
  private readonly nextSequences = new Map<string, number>();
  private nextObserverId = 1;
  private pendingObserverWork: Promise<void>[] = [];

  constructor(options: FakeChildCastRunnerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.initialStatus = options.initialStatus ?? "running";
    this.maxRetainedEvents = retentionLimit(options.maxRetainedEvents, DEFAULT_CHILD_CAST_RETAINED_EVENTS);
    this.maxRetainedDiagnostics = retentionLimit(options.maxRetainedDiagnostics, DEFAULT_CHILD_CAST_RETAINED_DIAGNOSTICS);
  }

  async start(input: StartChildCastInput): Promise<ChildCastStartResult> {
    validateStartInput(input);
    if (this.records.has(input.identity.childCastId)) {
      throw new Error(`Child cast ${JSON.stringify(input.identity.childCastId)} already exists.`);
    }

    const timestamp = this.now();
    const snapshot: ChildCastSnapshot = {
      identity: clone(input.identity),
      request: input.request,
      cwd: input.cwd,
      compiledLoadout: clone(input.compiledLoadout),
      paths: clone(input.paths),
      executionScope: clone(input.executionScope ?? { id: `child:${encodeURIComponent(input.identity.childCastId)}:base`, cwd: input.cwd, state: {}, exports: {} }),
      status: this.initialStatus,
      accepted: false,
      attempt: input.attempt ?? 1,
      operation: "start",
      startedAt: timestamp,
      updatedAt: timestamp,
      usage: clone(EMPTY_CHILD_CAST_USAGE),
      events: [],
      diagnostics: [],
    };
    this.records.set(input.identity.childCastId, snapshot);
    this.nextSequences.set(input.identity.childCastId, 1);
    this.emit(input.identity.childCastId, { type: "started", occurredAt: timestamp });
    return { childCastId: input.identity.childCastId, snapshot: this.requireSnapshot(input.identity.childCastId) };
  }

  async observe(input: ChildCastObserveInput): Promise<{ childCastId: string; snapshot: ChildCastSnapshot; events: readonly ChildCastStreamEvent[] } | undefined> {
    const snapshot = this.records.get(input.childCastId);
    if (!snapshot) return undefined;
    const afterSequence = input.afterSequence ?? 0;
    return {
      childCastId: input.childCastId,
      snapshot: this.requireSnapshot(input.childCastId),
      events: snapshot.events.filter((event) => event.sequence > afterSequence).map(clone),
    };
  }

  subscribe(input: ChildCastObserveInput, observer: ChildCastObserver): ChildCastSubscription {
    const snapshot = this.records.get(input.childCastId);
    if (!snapshot) throw new Error(`Unknown child cast ${JSON.stringify(input.childCastId)}.`);
    const observerId = this.nextObserverId++;
    const listeners = this.observers.get(input.childCastId) ?? new Map<number, ChildCastObserver>();
    listeners.set(observerId, observer);
    this.observers.set(input.childCastId, listeners);

    const afterSequence = input.afterSequence ?? 0;
    this.enqueueObserverCall(observer.onSnapshot?.(this.requireSnapshot(input.childCastId)));
    for (const event of snapshot.events) {
      if (event.sequence > afterSequence) this.enqueueObserverCall(observer.onEvent?.(clone(event)));
    }
    if (snapshot.terminalResult) this.enqueueObserverCall(observer.onTerminal?.(clone(snapshot.terminalResult)));

    return {
      childCastId: input.childCastId,
      unsubscribe: () => {
        const current = this.observers.get(input.childCastId);
        current?.delete(observerId);
        if (current && current.size === 0) this.observers.delete(input.childCastId);
      },
    };
  }

  async revive(input: ReviveChildCastInput | ChildCastRecoveryDescriptor): Promise<ChildCastStartResult> {
    return this.recover("revive", input);
  }

  async recast(input: RecastChildCastInput | ChildCastRecoveryDescriptor): Promise<ChildCastStartResult> {
    return this.recover("recast", input);
  }

  /** @deprecated Use revive or recast; legacy modes are normalized here. */
  async resume(input: ResumeChildCastInput): Promise<ChildCastStartResult> {
    return this.recover(normalizeChildCastRecoveryOperation(input.mode), input);
  }

  private async recover(operation: Exclude<ChildCastOperation, "start">, input: ChildCastRecoveryInput | ChildCastRecoveryDescriptor | ResumeChildCastInput): Promise<ChildCastStartResult> {
    const suppliedDescriptor = recoveryFromInput(input);
    const requestedOperation = "operation" in input ? input.operation : undefined;
    if (requestedOperation !== undefined && requestedOperation !== operation) {
      throw new Error(`Child cast recovery operation ${JSON.stringify(requestedOperation)} does not match ${operation}.`);
    }
    const requestedChildCastId = "childCastId" in input ? input.childCastId : undefined;
    const childCastId = requestedChildCastId ?? suppliedDescriptor?.identity.childCastId;
    if (!childCastId) throw new Error("Child cast recovery requires a childCastId or durable recovery descriptor.");
    const existing = this.records.get(childCastId);
    if (!existing) throw new Error(`Unknown child cast ${JSON.stringify(childCastId)}.`);
    const descriptor = suppliedDescriptor ?? createChildCastRecoveryDescriptor(existing);
    if (existing.status === "running" || existing.status === "starting" || existing.status === "queued") {
      throw new Error(`Child cast ${JSON.stringify(childCastId)} is already active.`);
    }
    if (existing.status === "succeeded" && existing.accepted) {
      throw new Error(`Child cast ${JSON.stringify(childCastId)} was accepted and cannot be resumed.`);
    }
    if (descriptor.identity.childCastId !== childCastId) {
      throw new Error(`Child cast recovery descriptor identity does not match ${JSON.stringify(childCastId)}.`);
    }
    if (!sameIdentity(existing.identity, descriptor.identity)) {
      throw new Error(`Child cast recovery descriptor identity drifted for ${JSON.stringify(childCastId)}.`);
    }
    if (descriptor.attempt !== existing.attempt) {
      throw new Error(`Child cast recovery descriptor attempt ${descriptor.attempt} does not match retained attempt ${existing.attempt}.`);
    }

    const timestamp = this.now();
    const next: ChildCastSnapshot = {
      ...existing,
      identity: clone(descriptor.identity),
      request: descriptor.request,
      cwd: descriptor.cwd,
      compiledLoadout: clone(descriptor.compiledLoadout),
      paths: clone(descriptor.paths),
      executionScope: cloneExecutionScope(descriptor.executionScope),
      status: this.initialStatus,
      accepted: false,
      attempt: descriptor.attempt + 1,
      operation,
      updatedAt: timestamp,
      usage: mergeChildCastUsage(existing.usage, descriptor.usageBaseline),
      terminalResult: undefined,
      abort: undefined,
      events: [...existing.events],
      diagnostics: [...existing.diagnostics],
    };
    this.records.set(childCastId, next);
    this.emit(childCastId, { type: "recovery", payload: { operation, attempt: next.attempt }, occurredAt: timestamp });
    return { childCastId, snapshot: this.requireSnapshot(childCastId) };
  }

  async retire(input: { childCastId: string; retainForResume: boolean }): Promise<void> {
    const snapshot = this.records.get(input.childCastId);
    if (!snapshot || !snapshot.terminalResult) return;
    this.observers.delete(input.childCastId);
    if (!input.retainForResume) {
      this.nextSequences.delete(input.childCastId);
      this.records.delete(input.childCastId);
      return;
    }
    this.records.set(input.childCastId, {
      ...snapshot,
      events: [],
      diagnostics: [],
      terminalResult: {
        status: snapshot.terminalResult.status,
        accepted: false,
        endedAt: snapshot.terminalResult.endedAt,
        ...(snapshot.terminalResult.error ? { error: snapshot.terminalResult.error } : {}),
        ...(snapshot.terminalResult.abortReason ? { abortReason: snapshot.terminalResult.abortReason } : {}),
      },
    });
  }

  async abort(input: ChildCastAbortInput): Promise<{ childCastId: string; status: "aborted" | "already_terminal" | "not_found"; aborted: boolean; snapshot?: ChildCastSnapshot }> {
    const existing = this.records.get(input.childCastId);
    if (!existing) return { childCastId: input.childCastId, status: "not_found", aborted: false };
    if (existing.terminalResult) {
      return { childCastId: input.childCastId, status: "already_terminal", aborted: false, snapshot: this.requireSnapshot(input.childCastId) };
    }

    const timestamp = this.now();
    const terminalResult: ChildCastTerminalResult = {
      status: "interrupted",
      accepted: false,
      endedAt: timestamp,
      error: input.reason,
      abortReason: input.reason,
    };
    this.records.set(input.childCastId, {
      ...existing,
      status: "interrupted",
      accepted: false,
      updatedAt: timestamp,
      terminalResult,
      abort: { reason: input.reason, requestedAt: timestamp, completedAt: timestamp },
    });
    this.emit(input.childCastId, { type: "aborted", payload: { reason: input.reason }, occurredAt: timestamp });
    this.notifyTerminal(input.childCastId, terminalResult);
    return { childCastId: input.childCastId, status: "aborted", aborted: true, snapshot: this.requireSnapshot(input.childCastId) };
  }

  /** Emit a child event without changing the child terminal state. */
  emit(childCastId: string, input: FakeChildCastEventInput): ChildCastStreamEvent {
    const existing = this.requireMutableSnapshot(childCastId);
    const timestamp = input.occurredAt ?? this.now();
    const event: ChildCastStreamEvent = {
      childCastId,
      sequence: this.nextSequences.get(childCastId) ?? 1,
      type: input.type,
      occurredAt: timestamp,
      ...(input.payload !== undefined ? { payload: clone(input.payload) } : {}),
      ...(input.socketId !== undefined ? { socketId: input.socketId } : {}),
      ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
      ...(input.usage !== undefined ? { usage: clone(input.usage) } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.total !== undefined ? { total: input.total } : {}),
    };
    this.nextSequences.set(childCastId, event.sequence + 1);
    const nextUsage = input.type === "usage_checkpoint" && input.usage
      ? mergeChildCastUsage(existing.usage, input.usage)
      : existing.usage;
    this.records.set(childCastId, { ...existing, updatedAt: timestamp, usage: nextUsage, events: retainTail(existing.events, event, this.maxRetainedEvents) });
    this.notifyEvent(childCastId, event);
    return clone(event);
  }

  addDiagnostic(childCastId: string, diagnostic: Omit<ChildCastDiagnostic, "occurredAt"> & { occurredAt?: number }): ChildCastDiagnostic {
    const existing = this.requireMutableSnapshot(childCastId);
    const nextDiagnostic: ChildCastDiagnostic = {
      ...diagnostic,
      occurredAt: diagnostic.occurredAt ?? this.now(),
      ...(diagnostic.details ? { details: clone(diagnostic.details) } : {}),
    };
    this.records.set(childCastId, { ...existing, updatedAt: nextDiagnostic.occurredAt, diagnostics: retainTail(existing.diagnostics, nextDiagnostic, this.maxRetainedDiagnostics) });
    this.emit(childCastId, { type: "diagnostic", payload: nextDiagnostic, occurredAt: nextDiagnostic.occurredAt });
    return clone(nextDiagnostic);
  }

  complete(childCastId: string, input: CompleteChildCastInput = {}): ChildCastSnapshot {
    return this.finish(childCastId, {
      status: "succeeded",
      accepted: input.accepted ?? true,
      endedAt: input.occurredAt ?? this.now(),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.output !== undefined ? { output: clone(input.output) } : {}),
      ...(input.usage !== undefined ? { usage: clone(input.usage) } : {}),
      ...(input.executionScope !== undefined ? { executionScope: cloneExecutionScope(input.executionScope) } : {}),
    });
  }

  fail(childCastId: string, input: FailChildCastInput): ChildCastSnapshot {
    return this.finish(childCastId, {
      status: "failed",
      accepted: false,
      endedAt: input.occurredAt ?? this.now(),
      error: input.error,
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.usage !== undefined ? { usage: clone(input.usage) } : {}),
    });
  }

  interrupt(childCastId: string, reason = "interrupted"): ChildCastSnapshot {
    return this.finish(childCastId, {
      status: "interrupted",
      accepted: false,
      endedAt: this.now(),
      error: reason,
      abortReason: reason,
    });
  }

  getSnapshot(childCastId: string): ChildCastSnapshot | undefined {
    return this.records.has(childCastId) ? this.requireSnapshot(childCastId) : undefined;
  }

  listSnapshots(): ChildCastSnapshot[] {
    return [...this.records.keys()].map((childCastId) => this.requireSnapshot(childCastId));
  }

  /** Flush observer promises so tests can deterministically await callbacks. */
  async drain(): Promise<void> {
    const pending = this.pendingObserverWork;
    this.pendingObserverWork = [];
    await Promise.all(pending);
  }

  private finish(childCastId: string, result: ChildCastTerminalResult & { usage?: ChildCastUsage }): ChildCastSnapshot {
    const existing = this.requireMutableSnapshot(childCastId);
    if (existing.terminalResult) return this.requireSnapshot(childCastId);
    const timestamp = result.endedAt;
    const { usage, ...terminalResult } = result;
    const snapshotUsage = usage ? mergeChildCastUsage(existing.usage, usage) : existing.usage;
    const cumulativeResult = usage ? { ...terminalResult, usage: snapshotUsage } : terminalResult;
    this.records.set(childCastId, {
      ...existing,
      status: result.status,
      accepted: result.accepted,
      updatedAt: timestamp,
      usage: snapshotUsage,
      ...(result.executionScope ? { executionScope: cloneExecutionScope(result.executionScope) } : {}),
      terminalResult: clone(cumulativeResult),
    });
    this.emit(childCastId, { type: "terminal", payload: terminalResult, ...(usage ? { usage: snapshotUsage } : {}), occurredAt: timestamp });
    this.notifyTerminal(childCastId, clone(cumulativeResult));
    return this.requireSnapshot(childCastId);
  }

  private notifyEvent(childCastId: string, event: ChildCastStreamEvent): void {
    for (const observer of this.observers.get(childCastId)?.values() ?? []) this.enqueueObserverCall(observer.onEvent?.(clone(event)));
  }

  private notifyTerminal(childCastId: string, result: ChildCastTerminalResult): void {
    for (const observer of this.observers.get(childCastId)?.values() ?? []) this.enqueueObserverCall(observer.onTerminal?.(clone(result)));
  }

  private enqueueObserverCall(result: void | Promise<void> | undefined): void {
    if (result === undefined) return;
    this.pendingObserverWork.push(Promise.resolve(result));
  }

  private requireMutableSnapshot(childCastId: string): ChildCastSnapshot {
    const snapshot = this.records.get(childCastId);
    if (!snapshot) throw new Error(`Unknown child cast ${JSON.stringify(childCastId)}.`);
    return snapshot;
  }

  private requireSnapshot(childCastId: string): ChildCastSnapshot {
    return clone(this.requireMutableSnapshot(childCastId));
  }
}

export type FakeChildCastRunnerPort = FakeChildCastRunner;

export function createFakeChildCastRunner(options: FakeChildCastRunnerOptions = {}): FakeChildCastRunner {
  return new FakeChildCastRunner(options);
}

function recoveryFromInput(input: ChildCastRecoveryInput | ChildCastRecoveryDescriptor | ResumeChildCastInput): ChildCastRecoveryDescriptor | undefined {
  const candidate = "identity" in input ? input : input.recovery ?? input.descriptor ?? input.recoveryDescriptor;
  return candidate ? validateChildCastRecoveryDescriptor(candidate) : undefined;
}

function sameIdentity(left: ChildCastSnapshot["identity"], right: ChildCastSnapshot["identity"]): boolean {
  return left.childCastId === right.childCastId
    && left.parentCastId === right.parentCastId
    && left.loopId === right.loopId
    && left.laneId === right.laneId;
}

function validateStartInput(input: StartChildCastInput): void {
  const required = [
    ["identity.childCastId", input.identity.childCastId],
    ["identity.parentCastId", input.identity.parentCastId],
    ["identity.loopId", input.identity.loopId],
    ["identity.laneId", input.identity.laneId],
    ["request", input.request],
    ["cwd", input.cwd],
    ["paths.sessionPath", input.paths.sessionPath],
    ["paths.artifactRoot", input.paths.artifactRoot],
    ["paths.runDirectory", input.paths.runDirectory],
  ] as const;
  for (const [path, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Child cast ${path} must be a non-empty string.`);
  }
  if (!input.compiledLoadout || typeof input.compiledLoadout !== "object" || !input.compiledLoadout.loadout) {
    throw new Error("Child cast compiledLoadout must contain a compiled loadout.");
  }
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) {
    throw new Error("Child cast attempt must be a positive safe integer.");
  }
}

function retentionLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function retainTail<T>(values: readonly T[], value: T, limit: number): T[] {
  return values.length < limit ? [...values, value] : [...values.slice(values.length - limit + 1), value];
}

function clone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clone(child)])) as T;
}
