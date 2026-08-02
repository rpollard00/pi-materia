import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { rename, writeFile } from "node:fs/promises";
import { createExecutionScope, type ExecutionScope } from "../domain/executionScope.js";
import {
  type ChildCastCompiledLoadout,
  type ChildCastTerminalResult,
  type ChildCastUsage,
  type StartChildCastInput,
} from "../application/index.js";
import type {
  MateriaAgentConfig,
  MateriaPipelineConfig,
  MateriaPipelineSocketConfig,
  MateriaUtilityConfig,
  ResolvedMateriaPipeline,
  UsageCost,
  UsageTokens,
} from "../types.js";

export interface BoundedCapture {
  push(chunk: Buffer | string): string;
  text(): string;
  readonly truncated: boolean;
}

export function createBoundedCapture(maxBytes: number): BoundedCapture {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (bytes >= maxBytes) {
        truncated = true;
        return "";
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      const selected = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(selected);
      bytes += selected.byteLength;
      if (selected.byteLength !== buffer.byteLength) truncated = true;
      return selected.toString("utf8");
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    get truncated() { return truncated; },
  };
}

/** Strict LF-framed parser used by the child stdout adapter. */
export class JsonLineParser {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #discardUntilNewline = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversized: () => void,
  ) {}

  push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    if (this.#discardUntilNewline) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      this.#discardUntilNewline = false;
      this.#buffer = text.slice(newline + 1);
    } else {
      this.#buffer += text;
    }

    while (true) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) {
        if (Buffer.byteLength(this.#buffer, "utf8") > this.maxBytes) {
          this.#buffer = "";
          this.#discardUntilNewline = true;
          this.onOversized();
        }
        return;
      }
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") <= this.maxBytes) this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      else this.onOversized();
    }
  }

  end(): void {
    this.#buffer += this.#decoder.end();
    if (this.#buffer.length === 0 || this.#discardUntilNewline) return;
    if (Buffer.byteLength(this.#buffer, "utf8") > this.maxBytes) {
      this.onOversized();
      return;
    }
    this.onLine(this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer);
    this.#buffer = "";
  }
}

export function buildPiChildArgs(input: {
  sessionPath: string;
  specPath: string;
  configPath?: string;
  extensionPath: string;
  childCommand?: string;
}): string[] {
  const command = input.childCommand ?? "child";
  return [
    "--mode", "json",
    "--session", input.sessionPath,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--extension", input.extensionPath,
    ...(input.configPath ? ["--materia-config", input.configPath] : []),
    "--print",
    `/materia ${command} ${input.specPath}`,
  ];
}

export function parsePiJsonEventLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
    return isRecord(value) && typeof value.type === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function terminalFromEvent(event: Record<string, unknown>, now: () => number = () => Date.now()): ChildCastTerminalResult | undefined {
  const candidate = event.type === "pi_materia_child_terminal" || event.type === "child_terminal" || event.type === "terminal"
    ? isRecord(event.result) ? event.result : isRecord(event.payload) ? event.payload : event
    : undefined;
  if (!candidate) return undefined;
  const status = candidate.status;
  if (status !== "succeeded" && status !== "failed" && status !== "interrupted") return undefined;
  const executionScope = terminalExecutionScope(candidate);
  // A present scope is part of the terminal acceptance protocol. Never
  // silently fall back to the launch scope when that terminal snapshot is
  // malformed; ignoring the marker leaves the child unaccepted on exit.
  if (Object.hasOwn(candidate, "executionScope") && !executionScope) return undefined;
  return {
    status,
    accepted: candidate.accepted === true && status === "succeeded",
    endedAt: typeof candidate.endedAt === "number" ? candidate.endedAt : now(),
    ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
    ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
    ...(Object.prototype.hasOwnProperty.call(candidate, "output") ? { output: clone(candidate.output) } : {}),
    ...(childUsage(candidate.usage) ? { usage: childUsage(candidate.usage) } : {}),
    ...(executionScope ? { executionScope } : {}),
    ...(typeof candidate.abortReason === "string" ? { abortReason: candidate.abortReason } : {}),
  };
}

function terminalExecutionScope(candidate: Record<string, unknown>): ExecutionScope | undefined {
  if (!Object.hasOwn(candidate, "executionScope")) return undefined;
  const value = candidate.executionScope;
  if (!isRecord(value)
    || !Object.hasOwn(value, "state")
    || !Object.hasOwn(value, "exports")
    || !isRecord(value.state)
    || !isRecord(value.exports)) return undefined;
  try {
    return createExecutionScope({
      id: value.id as string,
      cwd: value.cwd as string,
      state: value.state as Record<string, unknown>,
      exports: value.exports as ExecutionScope["exports"],
    });
  } catch {
    return undefined;
  }
}

export function extractEventOutput(event: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(event, "message")) return clone(event.message);
  if (Object.prototype.hasOwnProperty.call(event, "payload")) return clone(event.payload);
  return undefined;
}

export function childUsage(value: unknown): ChildCastUsage | undefined {
  if (!isRecord(value) || !isRecord(value.tokens) || !isRecord(value.cost)) return undefined;
  if (!numericUsage(value.tokens) || !numericUsage(value.cost)) return undefined;
  return {
    tokens: clone(value.tokens) as UsageTokens,
    cost: clone(value.cost) as UsageCost,
  };
}

function numericUsage(value: Record<string, unknown>): boolean {
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}

export function createChildConfig(compiled: ChildCastCompiledLoadout, artifactRoot: string): Record<string, unknown> {
  if (!isResolvedPipeline(compiled.loadout)) {
    // A config-shaped graph has no reusable materia definitions in the child
    // DTO. It is retained for port compatibility, but the child command will
    // fail clearly instead of silently executing an incomplete graph.
    return {
      artifactDir: artifactRoot,
      materia: {},
      loadouts: { child: compiled.loadout },
      activeLoadout: "child",
    };
  }
  const resolved = compiled.loadout;
  const materia: Record<string, MateriaAgentConfig | MateriaUtilityConfig> = {};
  const sockets: Record<string, MateriaPipelineSocketConfig> = {};
  for (const [socketId, resolvedSocket] of Object.entries(resolved.sockets)) {
    const materiaId = `child_${stablePathPart(socketId)}_${stableHash(socketId)}`;
    materia[materiaId] = clone(resolvedSocket.materia) as MateriaAgentConfig | MateriaUtilityConfig;
    sockets[socketId] = {
      ...clone(resolvedSocket.socket),
      materia: materiaId,
    };
  }
  const loadout: MateriaPipelineConfig = {
    id: "parallel-child",
    entry: resolved.entry.id,
    sockets,
    ...(resolved.loops ? { loops: clone(resolved.loops) } : {}),
  };
  return {
    artifactDir: artifactRoot,
    materia,
    loadouts: { child: loadout },
    activeLoadout: "child",
    activeLoadoutId: "parallel-child",
  };
}

export function isResolvedPipeline(value: ChildCastCompiledLoadout["loadout"]): value is ResolvedMateriaPipeline {
  return isRecord(value) && isRecord(value.entry) && isRecord(value.entry.socket) && isRecord(value.entry.materia);
}

function stablePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60) || "socket";
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function validateStartInput(input: StartChildCastInput): void {
  const required = [
    ["identity.childCastId", input.identity?.childCastId],
    ["identity.parentCastId", input.identity?.parentCastId],
    ["identity.loopId", input.identity?.loopId],
    ["identity.laneId", input.identity?.laneId],
    ["request", input.request],
    ["cwd", input.cwd],
    ["paths.sessionPath", input.paths?.sessionPath],
    ["paths.artifactRoot", input.paths?.artifactRoot],
    ["paths.runDirectory", input.paths?.runDirectory],
  ] as const;
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Child cast ${field} must be a non-empty string.`);
  }
  if (!input.compiledLoadout || typeof input.compiledLoadout !== "object" || !input.compiledLoadout.loadout) {
    throw new Error("Child cast compiledLoadout must contain a compiled loadout.");
  }
  if (input.executionScope && (input.executionScope.cwd !== input.cwd || typeof input.executionScope.id !== "string")) {
    throw new Error("Child cast executionScope must be valid and match cwd.");
  }
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) {
    throw new Error("Child cast attempt must be a positive safe integer.");
  }
}

export async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  const exited = hasProcessExited(child)
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("close", () => resolve()));
  const pid = child.pid;
  if (pid && process.platform !== "win32") {
    try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already exited */ } }
    await Promise.race([exited, delay(graceMs)]);
    if (!hasProcessExited(child)) {
      try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
    }
    return;
  }
  if (pid && process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { shell: false, stdio: "ignore", windowsHide: true });
    await new Promise<void>((resolve) => killer.once("close", () => resolve()));
    return;
  }
  try { child.kill("SIGTERM"); } catch { /* already exited */ }
}

export function hasProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}


export function processPlatformSupportsProcessGroups(): boolean {
  return process.platform !== "win32";
}

export function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function nonNegativeLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function boundedMessage(value: string, max = 800): string {
  const normalized = value.trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function callObserver<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): Promise<void> {
  if (!callback) return;
  try { await callback(value); } catch { /* observer failures never stop a child */ }
}

export function clone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clone(child)])) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

