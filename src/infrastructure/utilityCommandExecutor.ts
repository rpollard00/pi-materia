import { spawn } from "node:child_process";
import { effectiveUtilityConfig, resolvedMateriaDisplayName, resolvedMateriaId } from "../runtime/resolvedMateria.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../types.js";
import type { CommandUtilityRequest } from "../application/utilityExecution.js";
import { appendEvent, recordCommandArtifacts as recordCommandArtifactsFile } from "./castArtifacts.js";

export const DEFAULT_UTILITY_TIMEOUT_MS = 30_000;
export const MAX_UTILITY_OUTPUT_BYTES = 1024 * 1024;
export const MAX_UTILITY_ERROR_SUMMARY_LENGTH = 800;

export async function executeCommandUtility({ state, socket, input }: CommandUtilityRequest): Promise<string> {
  const command = effectiveUtilityConfig(socket).command;  if (!command || command.length === 0) throw new Error(`Utility socket "${socket.id}" has no explicit command configured.`);

  const timeoutMs = effectiveUtilityConfig(socket).timeoutMs ?? DEFAULT_UTILITY_TIMEOUT_MS;  const child = spawn(command[0], command.slice(1), { cwd: state.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const stdout = createBoundedCapture(MAX_UTILITY_OUTPUT_BYTES);
  const stderr = createBoundedCapture(MAX_UTILITY_OUTPUT_BYTES);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
  }, timeoutMs);
  timeout.unref();

  child.stdout.on("data", (chunk: Buffer | string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer | string) => stderr.push(chunk));

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end(`${JSON.stringify(input)}\n`);

  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await closed;
  } finally {
    clearTimeout(timeout);
  }

  const stdoutText = stdout.text();
  const stderrText = stderr.text();
  const artifacts = await recordCommandArtifacts(state, socket, stdoutText, stderrText, stdout.truncated, stderr.truncated);
  await appendEvent(state.runState, "utility_command", { socket: socket.id, materia: resolvedMateriaId(socket), materiaLabel: resolvedMateriaDisplayName(socket), command, code: result.code, signal: result.signal, timedOut, timeoutMs, stdoutArtifact: artifacts.stdoutArtifact, stderrArtifact: artifacts.stderrArtifact, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated });

  if (timedOut) {
    throw new CommandUtilityError(`Utility command timed out for socket "${socket.id}" after ${timeoutMs}ms: ${formatCommandForError(command)}. stdout: ${artifacts.stdoutArtifact}; stderr: ${artifacts.stderrArtifact}`, { command, result, timedOut, timeoutMs, artifacts, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated });
  }
  if (result.code !== 0) {
    const summary = summarizeStderr(stderrText, stderr.truncated);
    throw new CommandUtilityError(`Utility command failed for socket "${socket.id}": ${formatCommandForError(command)} exited with code ${result.code ?? `signal ${result.signal ?? "unknown"}`}. stderr: ${summary}. stdout: ${artifacts.stdoutArtifact}; stderr: ${artifacts.stderrArtifact}`, { command, result, timedOut, timeoutMs, artifacts, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated });
  }
  return stdoutText;
}

export class CommandUtilityError extends Error {
  constructor(message: string, readonly details: CommandUtilityEventDetails) {
    super(message);
    this.name = "CommandUtilityError";
  }
}

export interface CommandUtilityEventDetails {
  command: string[];
  result: { code: number | null; signal: NodeJS.Signals | null };
  timedOut: boolean;
  timeoutMs: number;
  artifacts: { stdoutArtifact: string; stderrArtifact: string; metaArtifact: string };
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export function commandUtilityEventDetails(error: unknown): CommandUtilityEventDetails | undefined {
  return error instanceof CommandUtilityError ? error.details : undefined;
}

export function createBoundedCapture(maxBytes: number): { push(chunk: Buffer | string): void; text(): string; truncated: boolean } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (buffer.byteLength > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
      } else {
        chunks.push(buffer);
        bytes += buffer.byteLength;
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

function recordCommandArtifacts(state: MateriaCastState, socket: ResolvedMateriaSocket, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean): Promise<{ stdoutArtifact: string; stderrArtifact: string; metaArtifact: string }> {
  return recordCommandArtifactsFile({ state, socketId: socket.id, materia: socketMateriaName(socket), materiaLabel: resolvedMateriaDisplayName(socket), visit: socketVisit(state, socket.id), stdout, stderr, stdoutTruncated, stderrTruncated, maxBytes: MAX_UTILITY_OUTPUT_BYTES });
}

function summarizeStderr(stderr: string, truncated: boolean): string {
  const summary = stderr.trim().replace(/\s+/g, " ").slice(0, MAX_UTILITY_ERROR_SUMMARY_LENGTH);
  return `${summary || "<empty>"}${truncated ? " (truncated)" : ""}`;
}

function formatCommandForError(command: string[]): string {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

function socketVisit(state: MateriaCastState, socketId: string): number {
  return state.visits[socketId] ?? 0;
}

function socketMateriaName(socket: ResolvedMateriaSocket | undefined): string | undefined {
  return resolvedMateriaId(socket);
}
