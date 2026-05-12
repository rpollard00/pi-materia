import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ok, type DomainIssue, type DomainResult } from "../domain/result.js";
import { HANDOFF_ENVELOPE_FIELDS, pickHandoffEnvelopeFields } from "../domain/handoff.js";
import type { MateriaManifest } from "../types.js";
import type { PreviousCastArtifactSummary, PreviousCastContext, PreviousCastHandoff } from "./types.js";

export const DEFAULT_PREVIOUS_CAST_MAX_ARTIFACT_BYTES = 4_000;
export const DEFAULT_PREVIOUS_CAST_MAX_ARTIFACTS = 20;

export interface PreviousCastContextLoadInput {
  fromCastId: string;
  /** Artifact root for this project/session; loaders must not read arbitrary paths outside known cast roots. */
  artifactRoot: string;
  /** Maximum bytes/characters to retain per loaded artifact preview. */
  maxArtifactBytes?: number;
  /** Maximum artifact previews to expose in transient runtime state. */
  maxArtifacts?: number;
}

/**
 * Previous-cast context loader boundary for `/materia link --from`.
 *
 * Responsibility: validate/load bounded structured previous-cast state. The
 * returned context is transient runtime state for opt-in materia/loadouts; it is
 * not automatic prompt injection and is not persisted wholesale in lineage.
 */
export interface PreviousCastContextLoader {
  load(input: PreviousCastContextLoadInput): Promise<DomainResult<PreviousCastContext>> | DomainResult<PreviousCastContext>;
}

export type LoadPreviousCastContext = PreviousCastContextLoader["load"];

export function createFilePreviousCastContextLoader(): PreviousCastContextLoader {
  return { load: loadPreviousCastContext };
}

export async function loadPreviousCastContext(input: PreviousCastContextLoadInput): Promise<DomainResult<PreviousCastContext>> {
  const fromCastId = input.fromCastId.trim();
  const maxArtifactBytes = normalizeLimit(input.maxArtifactBytes, DEFAULT_PREVIOUS_CAST_MAX_ARTIFACT_BYTES);
  const maxArtifacts = normalizeLimit(input.maxArtifacts, DEFAULT_PREVIOUS_CAST_MAX_ARTIFACTS);
  if (!fromCastId) return failure("link.fromCastId", "missing previous cast id after `--from`");
  if (fromCastId.includes("/") || fromCastId.includes("\\") || fromCastId.includes("..")) {
    return failure("link.fromCastId", `invalid previous cast id ${JSON.stringify(fromCastId)}; cast ids must refer to a run directory under the artifact root`);
  }

  const root = path.resolve(input.artifactRoot);
  const runDir = path.resolve(root, fromCastId);
  const boundary = await assertInsideExistingRun(root, runDir, fromCastId);
  if (!boundary.ok) return boundary;

  const manifestResult = await readManifest(runDir);
  const artifactRefs: Array<{ path: string; kind?: string }> = [];
  for (const entry of manifestResult.manifest?.entries ?? []) {
    if (typeof entry.artifact === "string" && entry.artifact.length > 0) artifactRefs.push({ path: entry.artifact, ...(entry.kind ? { kind: entry.kind } : {}) });
  }
  const discovered = await discoverJsonArtifacts(runDir, maxArtifacts);
  const artifactInputs = uniqueArtifactRefs([...artifactRefs, ...discovered]).slice(0, maxArtifacts);

  const artifacts: PreviousCastArtifactSummary[] = [];
  let handoff: PreviousCastHandoff | undefined = manifestResult.handoff;
  for (const artifact of artifactInputs) {
    const loaded = await loadArtifactPreview(runDir, artifact.path, artifact.kind, maxArtifactBytes);
    if (!loaded) continue;
    artifacts.push(loaded.summary);
    if (!handoff && loaded.handoff) handoff = loaded.handoff;
  }

  return ok({
    castId: fromCastId,
    ...(manifestResult.manifest?.request ? { request: manifestResult.manifest.request } : {}),
    runDir,
    ...(handoff ? { handoff } : {}),
    artifacts,
    loadedAt: Date.now(),
  });
}

async function assertInsideExistingRun(root: string, runDir: string, castId: string): Promise<DomainResult<void>> {
  let rootReal: string;
  let runReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return failure("link.artifactRoot", `artifact root ${JSON.stringify(root)} does not exist; cannot load previous cast ${JSON.stringify(castId)}`);
  }
  try {
    const info = await stat(runDir);
    if (!info.isDirectory()) return failure("link.fromCastId", `previous cast ${JSON.stringify(castId)} is not a run directory under ${rootReal}`);
    runReal = await realpath(runDir);
  } catch {
    return failure("link.fromCastId", `unknown previous cast id ${JSON.stringify(castId)}; no run directory exists under ${rootReal}`);
  }
  const relative = path.relative(rootReal, runReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return failure("link.fromCastId", `previous cast ${JSON.stringify(castId)} resolves outside the artifact root`);
  return ok(undefined);
}

async function readManifest(runDir: string): Promise<{ manifest?: MateriaManifest; handoff?: PreviousCastHandoff }> {
  try {
    const raw = await readFile(path.join(runDir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as MateriaManifest & Record<string, unknown>;
    return { manifest: parsed, handoff: pickPreviousCastHandoff(parsed) };
  } catch {
    return {};
  }
}

async function discoverJsonArtifacts(runDir: string, maxArtifacts: number): Promise<Array<{ path: string; kind?: string }>> {
  const found: Array<{ path: string; kind?: string }> = [];
  await walk(runDir, "", found, maxArtifacts);
  return found;
}

async function walk(root: string, relativeDir: string, found: Array<{ path: string; kind?: string }>, maxArtifacts: number): Promise<void> {
  if (found.length >= maxArtifacts) return;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(path.join(root, relativeDir), { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= maxArtifacts) return;
    const child = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) await walk(root, child, found, maxArtifacts);
    else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json") found.push({ path: child, kind: "json" });
  }
}

async function loadArtifactPreview(runDir: string, relativePath: string, kind: string | undefined, maxBytes: number): Promise<{ summary: PreviousCastArtifactSummary; handoff?: PreviousCastHandoff } | undefined> {
  if (!isSafeRelativePath(relativePath)) return undefined;
  const fullPath = path.resolve(runDir, relativePath);
  const relative = path.relative(runDir, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  let buffer: Buffer;
  try {
    const handle = await readFile(fullPath);
    buffer = handle.subarray(0, maxBytes);
    const truncated = handle.byteLength > maxBytes;
    const text = buffer.toString("utf8");
    const handoff = relativePath.endsWith(".json") ? handoffFromText(text) : undefined;
    return { summary: { path: relativePath, ...(kind ? { kind } : {}), maxBytes, truncated, content: text }, ...(handoff ? { handoff } : {}) };
  } catch {
    return undefined;
  }
}

function handoffFromText(text: string): PreviousCastHandoff | undefined {
  try {
    return pickPreviousCastHandoff(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function pickPreviousCastHandoff(value: unknown): PreviousCastHandoff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!HANDOFF_ENVELOPE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(record, field))) return undefined;
  return pickHandoffEnvelopeFields(record) as PreviousCastHandoff;
}

function uniqueArtifactRefs(refs: Array<{ path: string; kind?: string }>): Array<{ path: string; kind?: string }> {
  const seen = new Set<string>();
  const unique: Array<{ path: string; kind?: string }> = [];
  for (const ref of refs) {
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    unique.push(ref);
  }
  return unique;
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function failure(path: string, message: string): DomainResult<never> {
  const issues: DomainIssue[] = [{ path, message }];
  return { ok: false, issues };
}
