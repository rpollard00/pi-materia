import {
  EMPTY_CHILD_CAST_USAGE,
  type ChildCastAbortInput,
  type ChildCastDiagnostic,
  type ChildCastObserver,
  type ChildCastRunnerPort,
  type ChildCastSnapshot,
  type ChildCastStartResult,
  type ChildCastStatus,
  type ChildCastStreamEvent,
  type ChildCastTerminalResult,
  type ChildCastUsage,
  type ChildCastObserveInput,
  type ResumeChildCastInput,
  type StartChildCastInput,
  type ChildCastSubscription,
} from "./childCastRunner.js";

export interface FakeChildCastRunnerOptions {
  /** Injectable clock makes scheduler tests independent of wall-clock time. */
  now?: () => number;
  /** New children start running by default; queued is useful for dispatch tests. */
  initialStatus?: Extract<ChildCastStatus, "queued" | "starting" | "running">;
}

export interface FakeChildCastEventInput {
  type: string;
  payload?: unknown;
  socketId?: string;
  workItemId?: string;
  usage?: ChildCastUsage;
  occurredAt?: number;
}

export interface CompleteChildCastInput {
  accepted?: boolean;
  message?: string;
  output?: unknown;
  usage?: ChildCastUsage;
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
  private nextObserverId = 1;
  private pendingObserverWork: Promise<void>[] = [];

  constructor(options: FakeChildCastRunnerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.initialStatus = options.initialStatus ?? "running";
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
      startedAt: timestamp,
      updatedAt: timestamp,
      usage: clone(EMPTY_CHILD_CAST_USAGE),
      events: [],
      diagnostics: [],
    };
    this.records.set(input.identity.childCastId, snapshot);
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

  async resume(input: ResumeChildCastInput): Promise<ChildCastStartResult> {
    const existing = this.records.get(input.childCastId);
    if (!existing) throw new Error(`Unknown child cast ${JSON.stringify(input.childCastId)}.`);
    if (existing.status === "running" || existing.status === "starting" || existing.status === "queued") {
      throw new Error(`Child cast ${JSON.stringify(input.childCastId)} is already active.`);
    }
    if (existing.status === "succeeded" && existing.accepted) {
      throw new Error(`Child cast ${JSON.stringify(input.childCastId)} was accepted and cannot be resumed.`);
    }

    const timestamp = this.now();
    const next: ChildCastSnapshot = {
      ...existing,
      status: this.initialStatus,
      accepted: false,
      attempt: existing.attempt + 1,
      updatedAt: timestamp,
      terminalResult: undefined,
      abort: undefined,
      events: [...existing.events],
      diagnostics: [...existing.diagnostics],
    };
    this.records.set(input.childCastId, next);
    this.emit(input.childCastId, { type: "resumed", payload: { mode: input.mode ?? "resume" }, occurredAt: timestamp });
    return { childCastId: input.childCastId, snapshot: this.requireSnapshot(input.childCastId) };
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
      sequence: existing.events.length + 1,
      type: input.type,
      occurredAt: timestamp,
      ...(input.payload !== undefined ? { payload: clone(input.payload) } : {}),
      ...(input.socketId !== undefined ? { socketId: input.socketId } : {}),
      ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
      ...(input.usage !== undefined ? { usage: clone(input.usage) } : {}),
    };
    const nextUsage = input.usage ? clone(input.usage) : existing.usage;
    this.records.set(childCastId, { ...existing, updatedAt: timestamp, usage: nextUsage, events: [...existing.events, event] });
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
    this.records.set(childCastId, { ...existing, updatedAt: nextDiagnostic.occurredAt, diagnostics: [...existing.diagnostics, nextDiagnostic] });
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
    this.records.set(childCastId, {
      ...existing,
      status: result.status,
      accepted: result.accepted,
      updatedAt: timestamp,
      ...(usage ? { usage: clone(usage) } : {}),
      terminalResult: clone({ ...terminalResult, ...(usage ? { usage } : {}) }),
    });
    this.emit(childCastId, { type: "terminal", payload: terminalResult, ...(usage ? { usage } : {}), occurredAt: timestamp });
    this.notifyTerminal(childCastId, { ...terminalResult, ...(usage ? { usage } : {}) });
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

function clone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clone(child)])) as T;
}
