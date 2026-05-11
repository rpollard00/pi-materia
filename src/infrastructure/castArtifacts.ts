import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safePathSegment } from "../artifacts.js";
import type { MateriaCastState, MateriaManifest, MateriaManifestEntry, MateriaModelSelection, MateriaRunState, PiMateriaConfig } from "../types.js";

export const MATERIA_MANIFEST_FILE = "manifest.json";
export const MAX_CONTEXT_ITEM_LABEL_LENGTH = 80;

export interface CastArtifactStore {
  initializeRun(runDir: string, config: PiMateriaConfig, manifest: MateriaManifest): Promise<void>;
  appendEvent(state: MateriaRunState, type: string, data: unknown): Promise<void>;
  writeManifest(runDir: string, manifest: MateriaManifest): Promise<void>;
  appendManifest(state: MateriaCastState, entry: Omit<MateriaManifestEntry, "timestamp">): Promise<void>;
  writeContextArtifact(input: WriteContextArtifactInput): Promise<string>;
  recordSocketOutput(input: SocketTextArtifactInput): Promise<string>;
  recordSocketParsedJson(input: SocketParsedJsonArtifactInput): Promise<string>;
  recordSocketRefinement(input: SocketTextArtifactInput & { refinementTurn: number }): Promise<string>;
  recordUtilityInput(input: UtilityInputArtifactInput): Promise<string>;
  recordCommandArtifacts(input: CommandArtifactsInput): Promise<{ stdoutArtifact: string; stderrArtifact: string; metaArtifact: string }>;
}

export function createFileCastArtifactStore(): CastArtifactStore {
  return {
    initializeRun,
    appendEvent,
    writeManifest,
    appendManifest,
    writeContextArtifact,
    recordSocketOutput,
    recordSocketParsedJson,
    recordSocketRefinement,
    recordUtilityInput,
    recordCommandArtifacts,
  };
}

export async function initializeRun(runDir: string, config: PiMateriaConfig, manifest: MateriaManifest): Promise<void> {
  await mkdir(path.join(runDir, "sockets"), { recursive: true });
  await mkdir(path.join(runDir, "contexts"), { recursive: true });
  await writeFile(path.join(runDir, "config.resolved.json"), JSON.stringify(config, null, 2));
  await writeManifest(runDir, manifest);
}

export async function appendEvent(state: MateriaRunState, type: string, data: unknown): Promise<void> {
  await appendFile(state.eventsFile, `${JSON.stringify({ ts: Date.now(), type, data })}\n`);
}

export async function writeManifest(runDir: string, manifest: MateriaManifest): Promise<void> {
  await writeFile(path.join(runDir, MATERIA_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

export async function appendManifest(state: MateriaCastState, entry: Omit<MateriaManifestEntry, "timestamp">): Promise<void> {
  const file = path.join(state.runDir, MATERIA_MANIFEST_FILE);
  let manifest: MateriaManifest;
  try {
    manifest = JSON.parse(await readFile(file, "utf8")) as MateriaManifest;
  } catch {
    manifest = { castId: state.castId, request: state.request, configSource: state.configSource, entries: [] };
  }
  const itemLabel = entry.itemLabel ?? (entry.itemKey && entry.itemKey === state.currentItemKey ? state.currentItemLabel : undefined);
  manifest.entries.push({
    ...entry,
    itemLabel,
    itemLabelShort: entry.itemLabelShort ?? shortMetadataLabel(itemLabel),
    timestamp: Date.now(),
  });
  await writeManifest(state.runDir, manifest);
}

export interface SocketTextArtifactInput {
  state: MateriaCastState;
  socketId: string;
  materia?: string;
  visit: number;
  text: string;
  entryId: string;
  kind: string;
  finalized?: boolean;
  refinementTurn?: number;
  materiaModel?: MateriaModelSelection;
}

export async function recordSocketOutput(input: SocketTextArtifactInput): Promise<string> {
  const artifact = socketArtifactPath(input.state, input.socketId, input.visit, ".md");
  await writeRunFile(input.state.runDir, artifact, input.text);
  await appendManifest(input.state, socketManifestEntry(input, artifact));
  return artifact;
}

export interface SocketParsedJsonArtifactInput {
  state: MateriaCastState;
  socketId: string;
  visit: number;
  parsed: unknown;
}

export async function recordSocketParsedJson(input: SocketParsedJsonArtifactInput): Promise<string> {
  const artifact = path.join("sockets", safePathSegment(input.socketId), `${input.visit}.json`);
  await writeRunFile(input.state.runDir, artifact, JSON.stringify(input.parsed, null, 2));
  return artifact;
}

export async function recordSocketRefinement(input: SocketTextArtifactInput & { refinementTurn: number }): Promise<string> {
  const artifact = socketArtifactPath(input.state, input.socketId, input.visit, `.refinement-${input.refinementTurn}-${safePathSegment(input.entryId)}.md`);
  await writeRunFile(input.state.runDir, artifact, input.text);
  await appendManifest(input.state, socketManifestEntry(input, artifact));
  return artifact;
}

export interface UtilityInputArtifactInput {
  state: MateriaCastState;
  socketId: string;
  materia?: string;
  visit: number;
  input: Record<string, unknown>;
}

export async function recordUtilityInput(input: UtilityInputArtifactInput): Promise<string> {
  const artifact = socketArtifactPath(input.state, input.socketId, input.visit, ".input.json");
  await writeRunFile(input.state.runDir, artifact, JSON.stringify(input.input, null, 2));
  await appendManifest(input.state, { phase: input.state.phase, socket: input.socketId, materia: input.materia, itemKey: input.state.currentItemKey, visit: input.visit, entryId: `utility:${input.socketId}:${input.visit}:input`, artifact });
  return artifact;
}

export interface CommandArtifactsInput {
  state: MateriaCastState;
  socketId: string;
  materia?: string;
  visit: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  maxBytes: number;
}

export async function recordCommandArtifacts(input: CommandArtifactsInput): Promise<{ stdoutArtifact: string; stderrArtifact: string; metaArtifact: string }> {
  const stdoutArtifact = socketArtifactPath(input.state, input.socketId, input.visit, ".command.stdout.txt");
  const stderrArtifact = socketArtifactPath(input.state, input.socketId, input.visit, ".command.stderr.txt");
  const metaArtifact = socketArtifactPath(input.state, input.socketId, input.visit, ".command.json");
  await writeRunFile(input.state.runDir, stdoutArtifact, input.stdout);
  await writeRunFile(input.state.runDir, stderrArtifact, input.stderr);
  await writeRunFile(input.state.runDir, metaArtifact, JSON.stringify({ stdoutArtifact, stderrArtifact, stdoutTruncated: input.stdoutTruncated, stderrTruncated: input.stderrTruncated, maxBytes: input.maxBytes }, null, 2));
  await appendManifest(input.state, { phase: input.state.phase, socket: input.socketId, materia: input.materia, itemKey: input.state.currentItemKey, visit: input.visit, entryId: `utility:${input.socketId}:${input.visit}:command:stdout`, artifact: stdoutArtifact });
  await appendManifest(input.state, { phase: input.state.phase, socket: input.socketId, materia: input.materia, itemKey: input.state.currentItemKey, visit: input.visit, entryId: `utility:${input.socketId}:${input.visit}:command:stderr`, artifact: stderrArtifact });
  await appendManifest(input.state, { phase: input.state.phase, socket: input.socketId, materia: input.materia, itemKey: input.state.currentItemKey, visit: input.visit, entryId: `utility:${input.socketId}:${input.visit}:command:meta`, artifact: metaArtifact });
  return { stdoutArtifact, stderrArtifact, metaArtifact };
}

export interface WriteContextArtifactInput {
  state: MateriaCastState;
  prompt: string;
  syntheticContext: string;
  activeTools: string[];
  socketId?: string;
  visit: number;
  suffix?: string;
  model: string;
  modelSource: string;
  thinking: string;
  thinkingSource: string;
}

export async function writeContextArtifact(input: WriteContextArtifactInput): Promise<string> {
  const relativePath = contextArtifactPath(input.state, input.socketId, input.visit, input.suffix);
  const content = [
    "# Materia Isolated Context",
    "",
    `cast: ${input.state.castId}`,
    `socket: ${input.socketId ?? "-"}`,
    `materia: ${input.state.currentMateria ?? "-"}`,
    `item: ${input.state.currentItemLabel ?? "-"}`,
    `visit: ${input.socketId ? input.visit : "-"}`,
    `model: ${input.model}`,
    `model source: ${input.modelSource}`,
    `thinking: ${input.thinking}`,
    `thinking source: ${input.thinkingSource}`,
    `active tools: ${input.activeTools.length ? input.activeTools.join(", ") : "none"}`,
    `timestamp: ${new Date().toISOString()}`,
    "",
    "## Synthetic cast context",
    "",
    input.syntheticContext,
    "",
    "## Hidden materia prompt",
    "",
    input.prompt,
  ].join("\n");
  await writeRunFile(input.state.runDir, relativePath, content);
  return relativePath;
}

function socketManifestEntry(input: SocketTextArtifactInput, artifact: string): Omit<MateriaManifestEntry, "timestamp"> {
  return {
    phase: input.state.phase,
    socket: input.socketId,
    materia: input.materia,
    itemKey: input.state.currentItemKey,
    visit: input.visit,
    entryId: input.entryId,
    artifact,
    kind: input.kind,
    finalized: input.finalized,
    refinementTurn: input.refinementTurn,
    materiaModel: input.materiaModel,
  };
}

function socketArtifactPath(state: MateriaCastState, socketId: string, visit: number, suffix: string): string {
  const dir = path.join("sockets", safePathSegment(socketId));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  return path.join(dir, `${visit}${item}${suffix}`);
}

function contextArtifactPath(state: MateriaCastState, socketId: string | undefined, visit: number, suffix?: string): string {
  const socket = safePathSegment(socketId ?? state.phase);
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const extra = suffix ? `-${safePathSegment(suffix)}` : "";
  return path.join("contexts", `${socket}${item}-${visit}${extra}.md`);
}

async function writeRunFile(runDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(runDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

export function shortMetadataLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const normalized = label.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_CONTEXT_ITEM_LABEL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_CONTEXT_ITEM_LABEL_LENGTH - 1)}…`;
}
