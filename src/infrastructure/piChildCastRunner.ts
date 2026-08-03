import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cloneExecutionScope } from "../domain/executionScope.js";
import {
  DEFAULT_CHILD_CAST_RETAINED_DIAGNOSTICS,
  DEFAULT_CHILD_CAST_RETAINED_EVENTS,
  EMPTY_CHILD_CAST_USAGE,
  type ChildCastAbortInput,
  type ChildCastAbortResult,
  type ChildCastCompiledLoadout,
  type ChildCastDiagnostic,
  type ChildCastLaunchSpec,
  type ChildCastObserveInput,
  type ChildCastObservation,
  type ChildCastObserver,
  type ChildCastRunnerPort,
  type ChildCastSnapshot,
  type ChildCastStartResult,
  type ChildCastStreamEvent,
  type ChildCastSubscription,
  type ChildCastTerminalResult,
  type ChildCastUsage,
  type ResumeChildCastInput,
  type StartChildCastInput,
} from "../application/index.js";
import {
  boundedMessage,
  buildPiChildArgs,
  callObserver,
  childUsage,
  clone,
  createBoundedCapture,
  createChildConfig,
  hasProcessExited,
  isRecord,
  JsonLineParser,
  nonNegativeLimit,
  parsePiJsonEventLine,
  positiveLimit,
  processPlatformSupportsProcessGroups,
  terminateProcessTree,
  terminalFromEvent,
  validateStartInput,
  writeJsonAtomically,
  type BoundedCapture,
} from "./piChildCastSupport.js";

export { buildPiChildArgs, parsePiJsonEventLine } from "./piChildCastSupport.js";

/** Current on-disk protocol understood by the child-launch extension. */
export const PI_CHILD_LAUNCH_SPEC_VERSION = 1 as const;
export const DEFAULT_PI_CHILD_EXECUTABLE = "pi";
export const DEFAULT_PI_CHILD_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PI_CHILD_MAX_STDERR_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PI_CHILD_MAX_JSON_LINE_BYTES = 1024 * 1024;
export const DEFAULT_PI_CHILD_KILL_GRACE_MS = 1_000;

export interface PiChildCastRunnerOptions {
  /** Executable used for the isolated session. Defaults to `pi`. */
  executable?: string;
  /** Explicit path to this extension in the child process. */
  extensionPath?: string;
  /** Alias for callers that name the executable explicitly. */
  piExecutable?: string;
  /** Environment inherited by the child. Values are never written to artifacts. */
  env?: NodeJS.ProcessEnv;
  /** Injectable process factory for infrastructure tests. */
  spawnProcess?: PiChildProcessSpawner;
  /** Short alias retained for small embedders and test fakes. */
  spawn?: PiChildProcessSpawner;
  /** Injectable clock for deterministic snapshots and diagnostics. */
  now?: () => number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxJsonLineBytes?: number;
  killGraceMs?: number;
  /** Maximum observational replay entries retained per child. */
  maxRetainedEvents?: number;
  /** Maximum diagnostics retained per child snapshot. */
  maxRetainedDiagnostics?: number;
  /** Avoids writing the generated config when a caller supplies its own path. */
  configPath?: string;
  /** Allows tests and embedders to use a different fixed child command. */
  childCommand?: string;
}

export interface PiChildProcessSpawner {
  (file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}

export interface PiChildLaunchInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  /** The environment is intentionally not exposed by this DTO. */
  specPath: string;
  configPath?: string;
}

interface MutableChildRecord {
  snapshot: ChildCastSnapshot;
  process?: ChildProcess;
  launchSpecPath: string;
  configPath?: string;
  configOwned: boolean;
  stdoutPath: string;
  stderrPath: string;
  stdoutCapture: BoundedCapture;
  stderrCapture: BoundedCapture;
  stdoutParser: JsonLineParser;
  /**
   * Print mode takes over process.stdout and redirects direct extension writes
   * to stderr. Accept the child terminal marker there as well as on stdout.
   */
  stderrParser: JsonLineParser;
  stderrTerminalSeen: boolean;
  stderrHadNonTerminalOutput: boolean;
  stdoutWrite: Promise<void>;
  stderrWrite: Promise<void>;
  close: Promise<void>;
  resolveClose: () => void;
  settledClose: boolean;
  /** Full terminal data is private to the terminal channel, never snapshots. */
  terminalResult?: ChildCastTerminalResult;
  abortRequested?: ChildCastAbortInput & { requestedAt: number };
  observers: Map<number, ChildCastObserver>;
  nextSequence: number;
  nextObserverId: number;
  launch?: PiChildLaunchInvocation;
}

/**
 * Infrastructure adapter that runs one Pi session for one child lane.
 *
 * The adapter deliberately owns only process/session mechanics. Scheduling,
 * workspace creation, and lane state transitions remain application/runtime
 * responsibilities behind {@link ChildCastRunnerPort}.
 */
export class PiChildCastRunner implements ChildCastRunnerPort {
  readonly #records = new Map<string, MutableChildRecord>();
  /** Compact terminal snapshots retained only for supported failed-lane resume. */
  readonly #resumable = new Map<string, ChildCastSnapshot>();
  readonly #executable: string;
  readonly #extensionPath: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #spawnProcess: PiChildProcessSpawner;
  readonly #now: () => number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;
  readonly #maxJsonLineBytes: number;
  readonly #killGraceMs: number;
  readonly #maxRetainedEvents: number;
  readonly #maxRetainedDiagnostics: number;
  readonly #configPath?: string;
  readonly #childCommand: string;

  constructor(options: PiChildCastRunnerOptions = {}) {
    this.#executable = options.executable ?? options.piExecutable ?? process.env.PI_CHILD_EXECUTABLE ?? DEFAULT_PI_CHILD_EXECUTABLE;
    this.#extensionPath = options.extensionPath
      ?? process.env.PI_MATERIA_EXTENSION_PATH
      ?? fileURLToPath(new URL("../index.ts", import.meta.url));
    this.#environment = { ...process.env, ...(options.env ?? {}) };
    this.#spawnProcess = options.spawnProcess ?? options.spawn ?? ((file, args, spawnOptions) => spawn(file, [...args], spawnOptions));
    this.#now = options.now ?? (() => Date.now());
    this.#maxStdoutBytes = positiveLimit(options.maxStdoutBytes, DEFAULT_PI_CHILD_MAX_STDOUT_BYTES);
    this.#maxStderrBytes = positiveLimit(options.maxStderrBytes, DEFAULT_PI_CHILD_MAX_STDERR_BYTES);
    this.#maxJsonLineBytes = positiveLimit(options.maxJsonLineBytes, DEFAULT_PI_CHILD_MAX_JSON_LINE_BYTES);
    this.#killGraceMs = nonNegativeLimit(options.killGraceMs, DEFAULT_PI_CHILD_KILL_GRACE_MS);
    this.#maxRetainedEvents = positiveLimit(options.maxRetainedEvents, DEFAULT_CHILD_CAST_RETAINED_EVENTS);
    this.#maxRetainedDiagnostics = positiveLimit(options.maxRetainedDiagnostics, DEFAULT_CHILD_CAST_RETAINED_DIAGNOSTICS);
    this.#configPath = options.configPath;
    this.#childCommand = options.childCommand ?? "child";
  }

  async start(input: StartChildCastInput): Promise<ChildCastStartResult> {
    validateStartInput(input);
    const childCastId = input.identity.childCastId;
    if (this.#records.has(childCastId) || this.#resumable.has(childCastId)) {
      throw new Error(`Child cast ${JSON.stringify(childCastId)} already exists.`);
    }

    const record = await this.#prepareRecord(input, input.attempt ?? 1);
    this.#records.set(childCastId, record);
    try {
      await this.#launch(record, input);
    } catch (error) {
      this.#records.delete(childCastId);
      await this.#cleanupLaunchFiles(record);
      throw error;
    }
    return { childCastId, snapshot: clone(record.snapshot) };
  }

  async observe(input: ChildCastObserveInput): Promise<ChildCastObservation | undefined> {
    const record = this.#records.get(input.childCastId);
    const snapshot = record?.snapshot ?? this.#resumable.get(input.childCastId);
    if (!snapshot) return undefined;
    const afterSequence = input.afterSequence ?? 0;
    return {
      childCastId: input.childCastId,
      snapshot: clone(snapshot),
      events: snapshot.events.filter((event) => event.sequence > afterSequence).map(clone),
    };
  }

  subscribe(input: ChildCastObserveInput, observer: ChildCastObserver): ChildCastSubscription {
    const record = this.#records.get(input.childCastId);
    if (!record) throw new Error(`Unknown child cast ${JSON.stringify(input.childCastId)}.`);
    const observerId = record.nextObserverId++;
    record.observers.set(observerId, observer);
    const afterSequence = input.afterSequence ?? 0;
    void callObserver(observer.onSnapshot, clone(record.snapshot));
    for (const event of record.snapshot.events) {
      if (event.sequence > afterSequence) void callObserver(observer.onEvent, clone(event));
    }
    if (record.terminalResult) void callObserver(observer.onTerminal, clone(record.terminalResult));
    return {
      childCastId: input.childCastId,
      unsubscribe: () => record.observers.delete(observerId),
    };
  }

  async resume(input: ResumeChildCastInput): Promise<ChildCastStartResult> {
    const existing = this.#records.get(input.childCastId);
    const retained = this.#resumable.get(input.childCastId);
    const snapshot = existing?.snapshot ?? retained;
    if (!snapshot) throw new Error(`Unknown child cast ${JSON.stringify(input.childCastId)}.`);
    if (existing?.process && !hasProcessExited(existing.process) && !existing.terminalResult) {
      throw new Error(`Child cast ${JSON.stringify(input.childCastId)} is already active.`);
    }
    if (snapshot.status === "succeeded" && snapshot.accepted) {
      throw new Error(`Child cast ${JSON.stringify(input.childCastId)} was accepted and cannot be resumed.`);
    }

    if (existing) await existing.close.catch(() => undefined);
    const inputForLaunch: StartChildCastInput = {
      identity: clone(snapshot.identity),
      request: snapshot.request,
      cwd: snapshot.cwd,
      compiledLoadout: clone(snapshot.compiledLoadout),
      paths: clone(snapshot.paths),
      executionScope: clone(snapshot.executionScope),
      attempt: snapshot.attempt + 1,
    };
    const replacement = await this.#prepareRecord(inputForLaunch, inputForLaunch.attempt!);
    replacement.snapshot.events = [...snapshot.events];
    replacement.snapshot.diagnostics = [...snapshot.diagnostics];
    replacement.snapshot.usage = clone(snapshot.usage);
    replacement.nextSequence = existing?.nextSequence ?? ((snapshot.events.at(-1)?.sequence ?? 0) + 1);
    if (existing) {
      replacement.observers = existing.observers;
      replacement.nextObserverId = existing.nextObserverId;
    }
    replacement.snapshot.updatedAt = this.#now();
    this.#resumable.delete(input.childCastId);
    this.#records.set(input.childCastId, replacement);
    try {
      await this.#launch(replacement, inputForLaunch);
    } catch (error) {
      this.#records.delete(input.childCastId);
      if (retained) this.#resumable.set(input.childCastId, retained);
      else if (existing) this.#records.set(input.childCastId, existing);
      throw error;
    }
    return { childCastId: input.childCastId, snapshot: clone(replacement.snapshot) };
  }

  async abort(input: ChildCastAbortInput): Promise<ChildCastAbortResult> {
    const record = this.#records.get(input.childCastId);
    if (!record) return { childCastId: input.childCastId, status: "not_found", aborted: false };
    if (record.terminalResult) {
      return {
        childCastId: input.childCastId,
        status: "already_terminal",
        aborted: false,
        snapshot: clone(record.snapshot),
      };
    }

    const requestedAt = this.#now();
    record.abortRequested = { ...input, requestedAt };
    record.snapshot.abort = { reason: input.reason, requestedAt };
    this.#addDiagnostic(record, {
      code: "child_abort_requested",
      severity: "info",
      message: "Child process abort requested.",
      occurredAt: requestedAt,
    });

    if (!record.process || hasProcessExited(record.process)) {
      this.#finish(record, {
        status: "interrupted",
        accepted: false,
        endedAt: this.#now(),
        error: input.reason,
        abortReason: input.reason,
      });
      return {
        childCastId: input.childCastId,
        status: "aborted",
        aborted: true,
        snapshot: clone(record.snapshot),
      };
    }

    await terminateProcessTree(record.process, this.#killGraceMs);
    await record.close.catch(() => undefined);
    if (!record.terminalResult) {
      this.#finish(record, {
        status: "interrupted",
        accepted: false,
        endedAt: this.#now(),
        error: input.reason,
        abortReason: input.reason,
      });
    }
    return {
      childCastId: input.childCastId,
      status: "aborted",
      aborted: true,
      snapshot: clone(record.snapshot),
    };
  }

  async retire(input: { childCastId: string; retainForResume: boolean }): Promise<void> {
    const record = this.#records.get(input.childCastId);
    if (!record || !record.terminalResult) return;
    await record.close.catch(() => undefined);
    // Close has flushed capture artifacts and synthesized any missing terminal
    // status. Detach every source of late callbacks before releasing the record.
    record.observers.clear();
    record.process?.stdout?.removeAllListeners();
    record.process?.stderr?.removeAllListeners();
    record.process?.removeAllListeners();
    if (this.#records.get(input.childCastId) !== record) return;
    this.#records.delete(input.childCastId);
    if (input.retainForResume) {
      this.#resumable.set(input.childCastId, {
        ...clone(record.snapshot),
        events: [],
        diagnostics: [],
      });
    } else {
      this.#resumable.delete(input.childCastId);
    }
  }

  /** Return a secret-free description of the most recent launch. */
  getLaunchInvocation(childCastId: string): PiChildLaunchInvocation | undefined {
    const launch = this.#records.get(childCastId)?.launch;
    return launch ? clone(launch) : undefined;
  }

  /** Return the on-disk launch DTO for diagnostics or recovery tooling. */
  async readLaunchSpec(childCastId: string): Promise<ChildCastLaunchSpec | undefined> {
    const record = this.#records.get(childCastId);
    if (!record) return undefined;
    return JSON.parse(await readFile(record.launchSpecPath, "utf8")) as ChildCastLaunchSpec;
  }

  getSnapshot(childCastId: string): ChildCastSnapshot | undefined {
    const snapshot = this.#records.get(childCastId)?.snapshot ?? this.#resumable.get(childCastId);
    return snapshot ? clone(snapshot) : undefined;
  }

  async #prepareRecord(input: StartChildCastInput, attempt: number): Promise<MutableChildRecord> {
    const timestamp = this.#now();
    const snapshot: ChildCastSnapshot = {
      identity: clone(input.identity),
      request: input.request,
      cwd: input.cwd,
      compiledLoadout: clone(input.compiledLoadout),
      paths: clone(input.paths),
      executionScope: clone(input.executionScope ?? legacyChildScope(input)),
      status: "starting",
      accepted: false,
      attempt,
      startedAt: timestamp,
      updatedAt: timestamp,
      usage: clone(EMPTY_CHILD_CAST_USAGE),
      events: [],
      diagnostics: [],
    };
    const attemptSuffix = attempt === 1 ? "" : `-attempt-${attempt}`;
    const launchSpecPath = path.join(input.paths.runDirectory, `child-launch${attemptSuffix}.json`);
    const stdoutPath = path.join(input.paths.artifactRoot, `child-stdout${attemptSuffix}.jsonl`);
    const stderrPath = path.join(input.paths.artifactRoot, `child-stderr${attemptSuffix}.log`);
    await mkdir(input.paths.runDirectory, { recursive: true });
    await mkdir(input.paths.artifactRoot, { recursive: true });
    const configPath = this.#configPath ?? path.join(input.paths.runDirectory, `child-materia-config${attemptSuffix}.json`);
    const spec: ChildCastLaunchSpec = {
      version: PI_CHILD_LAUNCH_SPEC_VERSION,
      identity: clone(input.identity),
      request: input.request,
      cwd: input.cwd,
      compiledLoadout: clone(input.compiledLoadout),
      paths: clone(input.paths),
      executionScope: clone(input.executionScope ?? legacyChildScope(input)),
      attempt,
      ...(configPath ? { configPath } : {}),
    };
    await writeJsonAtomically(launchSpecPath, spec);
    if (!this.#configPath) {
      await writeJsonAtomically(configPath, createChildConfig(input.compiledLoadout, input.paths.artifactRoot));
    }
    await writeFile(stdoutPath, "", { mode: 0o600 });
    await writeFile(stderrPath, "", { mode: 0o600 });
    let resolveClose!: () => void;
    const close = new Promise<void>((resolve) => { resolveClose = resolve; });
    let preparedRecord!: MutableChildRecord;
    preparedRecord = {
      snapshot,
      launchSpecPath,
      configPath,
      configOwned: !this.#configPath,
      stdoutPath,
      stderrPath,
      stdoutCapture: createBoundedCapture(this.#maxStdoutBytes),
      stderrCapture: createBoundedCapture(this.#maxStderrBytes),
      // Capture the record itself, not a map lookup. Late output from an old
      // attempt must never be delivered to a replacement attempt on resume.
      stdoutParser: new JsonLineParser(this.#maxJsonLineBytes, (line) => this.#handleStdoutLine(preparedRecord, line), () => this.#addDiagnostic(preparedRecord, {
        code: "child_jsonl_line_too_large",
        severity: "warning",
        message: "Child stdout contained an oversized JSONL record; it was ignored.",
        occurredAt: this.#now(),
        details: { maxBytes: this.#maxJsonLineBytes },
      })),
      stderrParser: new JsonLineParser(this.#maxJsonLineBytes, (line) => this.#handleStderrLine(preparedRecord, line), () => this.#addDiagnostic(preparedRecord, {
        code: "child_stderr_line_too_large",
        severity: "warning",
        message: "Child stderr contained an oversized JSONL record; it was ignored.",
        occurredAt: this.#now(),
        details: { maxBytes: this.#maxJsonLineBytes },
      })),
      stdoutWrite: Promise.resolve(),
      stderrWrite: Promise.resolve(),
      stderrTerminalSeen: false,
      stderrHadNonTerminalOutput: false,
      close,
      resolveClose,
      settledClose: false,
      observers: new Map(),
      nextSequence: 1,
      nextObserverId: 1,
    };
    return preparedRecord;
  }

  async #launch(record: MutableChildRecord, input: StartChildCastInput): Promise<void> {
    const args = buildPiChildArgs({
      sessionPath: input.paths.sessionPath,
      specPath: record.launchSpecPath,
      configPath: record.configPath,
      extensionPath: this.#extensionPath,
      childCommand: this.#childCommand,
    });
    const childEnvironment = {
      ...this.#environment,
      PI_MATERIA_CHILD: "1",
      PI_MATERIA_CHILD_LAUNCH_SPEC: record.launchSpecPath,
    };
    const process = this.#spawnProcess(this.#executable, args, {
      cwd: input.cwd,
      env: childEnvironment,
      shell: false,
      detached: processPlatformSupportsProcessGroups(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    record.process = process;
    record.launch = {
      executable: this.#executable,
      args,
      cwd: input.cwd,
      specPath: record.launchSpecPath,
      ...(record.configPath ? { configPath: record.configPath } : {}),
    };
    record.snapshot.status = "running";
    record.snapshot.updatedAt = this.#now();

    process.stdout?.on("data", (chunk: Buffer | string) => {
      const text = record.stdoutCapture.push(chunk);
      // Continue parsing after capture fills so terminal delivery still works,
      // but do not grow a promise chain with no-op artifact writes.
      if (text.length > 0) record.stdoutWrite = record.stdoutWrite.then(() => appendFile(record.stdoutPath, text)).catch(() => undefined);
      record.stdoutParser.push(chunk);
    });
    process.stderr?.on("data", (chunk: Buffer | string) => {
      const text = record.stderrCapture.push(chunk);
      if (text.length > 0) record.stderrWrite = record.stderrWrite.then(() => appendFile(record.stderrPath, text)).catch(() => undefined);
      record.stderrParser.push(chunk);
    });
    process.once("error", (error) => {
      this.#addDiagnostic(record, {
        code: "child_process_error",
        severity: "error",
        message: boundedMessage(error instanceof Error ? error.message : String(error)),
        occurredAt: this.#now(),
      });
    });
    process.once("close", (code, signal) => {
      record.stdoutParser.end();
      void this.#handleClose(record, code, signal);
    });
  }

  #handleStderrLine(record: MutableChildRecord | undefined, line: string): void {
    if (!record || line.length === 0 || record.terminalResult) return;
    const leadingType = leadingJsonEventType(line);
    if (leadingType !== undefined && !TERMINAL_EVENT_TYPES.has(leadingType)) {
      record.stderrHadNonTerminalOutput = true;
      return;
    }
    const parsed = parsePiJsonEventLine(line);
    if (!parsed) {
      record.stderrHadNonTerminalOutput = true;
      return;
    }
    const terminal = terminalFromEvent(parsed, this.#now);
    if (!terminal) {
      record.stderrHadNonTerminalOutput = true;
      return;
    }
    record.stderrTerminalSeen = true;
    this.#finish(record, terminal);
  }

  #handleStdoutLine(record: MutableChildRecord | undefined, line: string): void {
    // Once a terminal marker settles the record, do not parse duplicate or
    // buffered lines at all. The first marker is the sole terminal delivery.
    if (!record || line.length === 0 || record.terminalResult) return;
    // Pi's highest-volume records put `type` first. Reject known content-bearing
    // records from a short prefix so their messages/tool data are never parsed,
    // cloned, or admitted to child telemetry.
    const leadingType = leadingJsonEventType(line);
    if (leadingType !== undefined && DISCARDED_CHILD_EVENT_TYPES.has(leadingType)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#addDiagnostic(record, {
        code: "child_invalid_jsonl",
        severity: "warning",
        message: "Child stdout contained a non-JSON line; it was ignored.",
        occurredAt: this.#now(),
      });
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.#addDiagnostic(record, {
        code: "child_invalid_event",
        severity: "warning",
        message: "Child stdout JSON did not contain an event object.",
        occurredAt: this.#now(),
      });
      return;
    }
    const event = parsed as Record<string, unknown>;
    const terminal = terminalFromEvent(event, this.#now);
    if (terminal) {
      // The complete result is delivered through the terminal channel only;
      // never project the marker or its payload into the replay event stream.
      this.#finish(record, terminal);
      return;
    }

    const rawUsage = event.usage
      ?? (isRecord(event.result) ? event.result.usage : undefined)
      ?? (isRecord(event.message) ? event.message.usage : undefined);
    const usage = childUsage(rawUsage);
    if (!usage) return;
    // Pi reports flat message_end usage per message, not per session. Project a
    // cumulative checkpoint so dispatcher deltas cannot regress when a later
    // message is smaller. Nested usage is already aggregate-shaped.
    const checkpoint = isRecord(rawUsage) && !isRecord(rawUsage.tokens)
      ? addUsage(record.snapshot.usage, usage)
      : usage;
    record.snapshot.usage = clone(checkpoint);
    this.#emit(record, {
      type: "usage_checkpoint",
      usage: checkpoint,
      ...(typeof event.socketId === "string" ? { socketId: event.socketId } : {}),
      ...(typeof event.workItemId === "string" ? { workItemId: event.workItemId } : {}),
      ...(typeof event.occurredAt === "number" ? { occurredAt: event.occurredAt } : {}),
    });
  }

  async #handleClose(record: MutableChildRecord, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    record.stderrParser.end();
    await Promise.all([record.stdoutWrite, record.stderrWrite]);
    if (record.settledClose) return;
    const endedAt = this.#now();
    const stderr = record.stderrCapture.text();
    const hasDiagnosticStderr = record.stderrHadNonTerminalOutput
      || (!record.terminalResult && stderr.trim().length > 0 && !record.stderrTerminalSeen);
    if (record.stdoutCapture.truncated) {
      this.#addDiagnostic(record, {
        code: "child_stdout_truncated",
        severity: "warning",
        message: "Child stdout capture reached its configured bound.",
        occurredAt: endedAt,
        details: { artifact: record.stdoutPath, maxBytes: this.#maxStdoutBytes },
      });
    }
    if (record.stderrCapture.truncated) {
      this.#addDiagnostic(record, {
        code: "child_stderr_truncated",
        severity: "warning",
        message: "Child stderr capture reached its configured bound.",
        occurredAt: endedAt,
        details: { artifact: record.stderrPath, maxBytes: this.#maxStderrBytes },
      });
    }
    if (hasDiagnosticStderr) {
      this.#addDiagnostic(record, {
        code: "child_stderr",
        severity: code === 0 ? "warning" : "error",
        message: "Child process wrote diagnostic output; inspect the bounded stderr artifact.",
        occurredAt: endedAt,
        details: {
          artifact: record.stderrPath,
          truncated: record.stderrCapture.truncated,
        },
      });
    }
    if (!record.terminalResult) {
      const aborted = record.abortRequested;
      const interrupted = aborted !== undefined || signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT";
      this.#finish(record, interrupted
        ? {
            status: "interrupted",
            accepted: false,
            endedAt,
            error: aborted?.reason ?? `Child process terminated by ${signal ?? "signal"}.`,
            ...(aborted ? { abortReason: aborted.reason } : {}),
          }
        : code === 0
          ? {
              // A process exit is not an acceptance signal. The child launch
              // command normally emits an explicit terminal marker; when it
              // does not, preserve the clean exit but keep the lane ineligible
              // for fan-in.
              status: "succeeded",
              accepted: false,
              endedAt,
              message: "Child Pi session exited without an explicit terminal result.",
            }
          : {
              status: "failed",
              accepted: false,
              endedAt,
              error: `Child Pi session exited with code ${code ?? "unknown"}; inspect the bounded stderr artifact.`,
            });
    }
    record.settledClose = true;
    record.resolveClose();
  }

  #emit(record: MutableChildRecord, input: Omit<ChildCastStreamEvent, "childCastId" | "sequence" | "occurredAt"> & { occurredAt?: number }): void {
    const occurredAt = input.occurredAt ?? this.#now();
    const event: ChildCastStreamEvent = {
      childCastId: record.snapshot.identity.childCastId,
      sequence: record.nextSequence++,
      type: input.type,
      occurredAt,
      ...(input.payload !== undefined ? { payload: clone(input.payload) } : {}),
      ...(input.socketId !== undefined ? { socketId: input.socketId } : {}),
      ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
      ...(input.usage !== undefined ? { usage: clone(input.usage) } : {}),
    };
    record.snapshot.events = retainTail(record.snapshot.events, event, this.#maxRetainedEvents);
    record.snapshot.updatedAt = occurredAt;
    for (const observer of record.observers.values()) void callObserver(observer.onEvent, clone(event));
  }

  #addDiagnostic(record: MutableChildRecord, diagnostic: Omit<ChildCastDiagnostic, "occurredAt"> & { occurredAt?: number }): void {
    const next: ChildCastDiagnostic = {
      ...diagnostic,
      occurredAt: diagnostic.occurredAt ?? this.#now(),
      ...(diagnostic.details ? { details: clone(diagnostic.details) } : {}),
    };
    record.snapshot.diagnostics = retainTail(record.snapshot.diagnostics, next, this.#maxRetainedDiagnostics);
    record.snapshot.updatedAt = next.occurredAt;
    this.#emit(record, { type: "diagnostic", payload: next, occurredAt: next.occurredAt });
  }

  #finish(record: MutableChildRecord, result: ChildCastTerminalResult): void {
    if (record.terminalResult) return;
    record.terminalResult = clone(result);
    record.snapshot.status = result.status;
    record.snapshot.accepted = result.accepted;
    if (result.executionScope) record.snapshot.executionScope = cloneExecutionScope(result.executionScope);
    if (result.usage) record.snapshot.usage = clone(result.usage);
    record.snapshot.updatedAt = result.endedAt;
    if (record.snapshot.abort && result.abortReason) record.snapshot.abort.completedAt = result.endedAt;
    for (const observer of record.observers.values()) void callObserver(observer.onTerminal, clone(result));
  }

  async #cleanupLaunchFiles(record: MutableChildRecord): Promise<void> {
    await Promise.all([
      rm(record.launchSpecPath, { force: true }).catch(() => undefined),
      record.configOwned && record.configPath ? rm(record.configPath, { force: true }).catch(() => undefined) : Promise.resolve(),
    ]);
  }
}

export type PiChildCastRunnerPort = PiChildCastRunner;

const DISCARDED_CHILD_EVENT_TYPES = new Set([
  "message_update",
  "tool_execution_update",
  "entry_appended",
  "message",
  "turn",
  "tool",
  "session",
]);
const TERMINAL_EVENT_TYPES = new Set(["pi_materia_child_terminal", "child_terminal", "terminal"]);

function retainTail<T>(values: readonly T[], value: T, limit: number): T[] {
  return values.length < limit ? [...values, value] : [...values.slice(values.length - limit + 1), value];
}

function addUsage(left: ChildCastUsage, right: ChildCastUsage): ChildCastUsage {
  return {
    tokens: {
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
      cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
      total: left.tokens.total + right.tokens.total,
    },
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

/** Read only a leading JSON string `type` value without parsing the payload. */
function leadingJsonEventType(line: string): string | undefined {
  const match = /^\s*\{\s*"type"\s*:\s*("(?:\\.|[^"\\])*")/.exec(line.slice(0, 512));
  if (!match) return undefined;
  try {
    const type: unknown = JSON.parse(match[1]);
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

function legacyChildScope(input: StartChildCastInput) {
  return { id: `child:${encodeURIComponent(input.identity.childCastId)}:base`, cwd: input.cwd, state: {}, exports: {} };
}

export function createPiChildCastRunner(options: PiChildCastRunnerOptions = {}): PiChildCastRunner {
  return new PiChildCastRunner(options);
}

/** Naming aliases used by callers that describe the adapter as a subprocess. */
export { PiChildCastRunner as PiChildSubprocessRunner };
export const createPiChildSubprocessRunner = createPiChildCastRunner;

