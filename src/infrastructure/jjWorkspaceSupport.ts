import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  JJ_WORKSPACE_MANIFEST_VERSION,
  JJ_WORKSPACE_MANIFEST_DIRECTORY,
  JJ_WORKSPACE_ROOT_MANIFEST,
  JjWorkspaceError,
  type JjCommandExecutor,
  type JjFanInPreparation,
  type JjRevisionIdentity,
  type JjWorkspaceCreateInput,
  type JjWorkspaceLifecycleState,
  type JjWorkspaceManifest,
  type JjWorkspaceOwner,
} from "./jjWorkspaceBackend.js";

export function ownerOf(input: JjWorkspaceCreateInput): JjWorkspaceOwner {
  return { parentCastId: input.parentCastId, loopId: input.loopId, laneId: input.laneId };
}

export function validateOwner(input: JjWorkspaceOwner): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.trim().length === 0) throw new JjWorkspaceError("owner_invalid", `Workspace owner ${key} must be a non-empty string.`);
  }
}

export function parseBaseline(value: string | JjRevisionIdentity): JjRevisionIdentity {
  if (typeof value === "string") {
    if (!value.trim()) throw new JjWorkspaceError("baseline_invalid", "Workspace baseline commit id must be non-empty.");
    return { commitId: value.trim(), changeId: "" };
  }
  if (!isRecord(value) || typeof value.commitId !== "string" || value.commitId.trim().length === 0 || typeof value.changeId !== "string") {
    throw new JjWorkspaceError("baseline_invalid", "Workspace baseline must contain commitId and changeId strings.");
  }
  return { commitId: value.commitId.trim(), changeId: value.changeId.trim() };
}

export async function completeBaseline(repositoryRoot: string, baseline: JjRevisionIdentity, readRevision: (cwd: string, revset: string) => Promise<JjRevisionIdentity>): Promise<JjRevisionIdentity> {
  if (baseline.changeId) return baseline;
  return readRevision(repositoryRoot, baseline.commitId);
}

export function workspaceNameFor(repositoryRoot: string, owner: JjWorkspaceOwner): string {
  const hash = createHash("sha256").update(`${repositoryRoot}\0${owner.parentCastId}\0${owner.loopId}\0${owner.laneId}`).digest("hex").slice(0, 16);
  const lane = owner.laneId.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lane";
  return `materia-${lane}-${hash}`;
}

export function manifestPathFor(root: string, workspaceName: string): string {
  return path.join(path.resolve(root), JJ_WORKSPACE_MANIFEST_DIRECTORY, `${workspaceName}.json`);
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export async function assertSafeRoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  await assertNoSymlinkAncestors(resolved);
  let rootStat;
  try { rootStat = await lstat(resolved); } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ${JSON.stringify(resolved)} must be a real directory.`);
  const manifestsRoot = path.join(resolved, JJ_WORKSPACE_MANIFEST_DIRECTORY);
  try {
    const manifestsStat = await lstat(manifestsRoot);
    if (manifestsStat.isSymbolicLink() || !manifestsStat.isDirectory()) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace manifest directory ${JSON.stringify(manifestsRoot)} must be a real directory.`);
  } catch (error) {
    if (error instanceof JjWorkspaceError) throw error;
    if (!isNotFound(error)) throw error;
  }
  const markerPath = path.join(resolved, JJ_WORKSPACE_ROOT_MANIFEST);
  try {
    const markerStat = await lstat(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root marker ${JSON.stringify(markerPath)} must be a regular file.`);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
    if (!isRecord(marker) || marker.backend !== "jj" || marker.version !== JJ_WORKSPACE_MANIFEST_VERSION) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ${JSON.stringify(resolved)} is not owned by this jj backend.`);
  } catch (error) {
    if (error instanceof JjWorkspaceError) throw error;
    if (isNotFound(error)) throw new JjWorkspaceError("workspace_root_unowned", `Workspace root ${JSON.stringify(resolved)} has no ownership marker.`);
    if (error instanceof SyntaxError) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root marker ${JSON.stringify(markerPath)} is invalid JSON.`);
    throw error;
  }
}

export async function assertNoSymlinkAncestors(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new JjWorkspaceError("workspace_symlink", `Refusing to operate through symlink ${JSON.stringify(current)}.`);
    } catch (error) {
      if (error instanceof JjWorkspaceError) throw error;
      if (isNotFound(error)) break;
      throw error;
    }
  }
}

export async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new JjWorkspaceError("workspace_path_escape", "Workspace path is outside the owned root.");
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new JjWorkspaceError("workspace_symlink", `Refusing to operate through symlink ${JSON.stringify(current)}.`);
    } catch (error) {
      if (error instanceof JjWorkspaceError) throw error;
      if (!isNotFound(error)) throw error;
      break;
    }
  }
}

export async function assertAbsentOrDirectory(file: string, label: string): Promise<void> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new JjWorkspaceError("workspace_path_unsafe", `${label} ${JSON.stringify(file)} is a symlink.`);
    if (!stat.isDirectory()) throw new JjWorkspaceError("workspace_path_unsafe", `${label} ${JSON.stringify(file)} is not a directory.`);
    throw new JjWorkspaceError("workspace_exists_unowned", `${label} ${JSON.stringify(file)} already exists without a matching ownership manifest.`);
  } catch (error) {
    if (error instanceof JjWorkspaceError) throw error;
    if (!isNotFound(error)) throw error;
  }
}

export async function removeOwnedDirectory(directory: string, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (!isWithin(resolvedRoot, resolvedDirectory)) throw new JjWorkspaceError("workspace_path_escape", "Refusing to remove a directory outside the owned root.");
  await assertNoSymlinkComponents(resolvedRoot, resolvedDirectory);
  try {
    const stat = await lstat(resolvedDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new JjWorkspaceError("workspace_path_unsafe", `Refusing to remove non-directory workspace path ${JSON.stringify(resolvedDirectory)}.`);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  await rm(resolvedDirectory, { recursive: true, force: false });
}

export async function removeOwnedManifest(manifestPath: string, root: string): Promise<void> {
  const manifestsRoot = path.join(path.resolve(root), JJ_WORKSPACE_MANIFEST_DIRECTORY);
  let manifestsStat;
  try { manifestsStat = await lstat(manifestsRoot); } catch (error) {
    if (isNotFound(error)) throw new JjWorkspaceError("manifest_unsafe", `Ownership manifest directory ${JSON.stringify(manifestsRoot)} does not exist.`);
    throw error;
  }
  if (manifestsStat.isSymbolicLink() || !manifestsStat.isDirectory()) throw new JjWorkspaceError("manifest_unsafe", `Refusing to remove an ownership manifest from unsafe directory ${JSON.stringify(manifestsRoot)}.`);
  if (!isWithin(manifestsRoot, manifestPath)) throw new JjWorkspaceError("manifest_path_escape", "Refusing to remove an ownership manifest outside the manifest directory.");
  await assertNoSymlinkComponents(manifestsRoot, path.resolve(manifestPath));
  try {
    const stat = await lstat(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new JjWorkspaceError("manifest_unsafe", `Refusing to remove non-regular ownership manifest ${JSON.stringify(manifestPath)}.`);
    await rm(manifestPath, { force: false });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export function parseManifest(value: unknown, file: string): JjWorkspaceManifest {
  if (!isRecord(value) || value.version !== JJ_WORKSPACE_MANIFEST_VERSION || value.backend !== "jj" || !isRecord(value.owner) || !isRevision(value.baseline) || !isRevision(value.revision)) {
    throw new JjWorkspaceError("manifest_invalid", `Workspace ownership manifest ${JSON.stringify(file)} has an unsupported shape.`);
  }
  const owner = value.owner;
  const requiredStrings = ["repositoryRoot", "workspaceRoot", "workspacePath", "workspaceName", "operationId", "state"];
  if (requiredStrings.some((key) => typeof value[key] !== "string" || (value[key] as string).trim().length === 0) || (value.state !== "active" && value.state !== "forgotten") || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) {
    throw new JjWorkspaceError("manifest_invalid", `Workspace ownership manifest ${JSON.stringify(file)} is incomplete.`);
  }
  if (["parentCastId", "loopId", "laneId"].some((key) => typeof owner[key] !== "string" || (owner[key] as string).trim().length === 0)) {
    throw new JjWorkspaceError("manifest_invalid", `Workspace ownership manifest ${JSON.stringify(file)} has an invalid owner.`);
  }
  if (path.basename(value.workspacePath as string) !== value.workspaceName || value.workspaceName === "." || value.workspaceName === ".." || value.workspaceName.includes(path.sep)) {
    throw new JjWorkspaceError("manifest_invalid", `Workspace ownership manifest ${JSON.stringify(file)} has an unsafe workspace name or path.`);
  }
  const fanInPreparation = value.fanInPreparation === undefined ? undefined : parseFanInPreparation(value.fanInPreparation, owner, file);
  return {
    version: JJ_WORKSPACE_MANIFEST_VERSION,
    backend: "jj",
    owner: { parentCastId: owner.parentCastId as string, loopId: owner.loopId as string, laneId: owner.laneId as string },
    repositoryRoot: value.repositoryRoot as string,
    workspaceRoot: value.workspaceRoot as string,
    workspacePath: value.workspacePath as string,
    workspaceName: value.workspaceName as string,
    baseline: { commitId: value.baseline.commitId, changeId: value.baseline.changeId },
    revision: { commitId: value.revision.commitId, changeId: value.revision.changeId },
    operationId: value.operationId as string,
    state: value.state as JjWorkspaceLifecycleState,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
    ...(typeof value.forgottenAt === "number" ? { forgottenAt: value.forgottenAt } : {}),
    ...(typeof value.forgetOperationId === "string" ? { forgetOperationId: value.forgetOperationId } : {}),
    ...(fanInPreparation ? { fanInPreparation } : {}),
  };
}

function parseFanInPreparation(value: unknown, manifestOwner: Record<string, any>, file: string): JjFanInPreparation {
  const invalid = () => new JjWorkspaceError("manifest_invalid", `Workspace ownership manifest ${JSON.stringify(file)} has an invalid bounded fan-in preparation.`);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.owner)
    || ["parentCastId", "loopId", "runId"].some((key) => typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 512)
    || !isRevision(value.baseline) || !isRevision(value.workspaceRevision)
    || !Number.isSafeInteger(value.streamIndex) || value.streamIndex < 0 || value.streamIndex >= 256
    || !Number.isSafeInteger(value.queueIndex) || value.queueIndex < 0 || value.queueIndex >= 256
    || !Number.isFinite(value.preparedAt) || !Array.isArray(value.meaningfulChanges) || value.meaningfulChanges.length > 1_024
    || value.meaningfulChanges.some((revision) => !isRevision(revision))) throw invalid();
  const hasParking = value.parkedWorkspaceRevision !== undefined || value.parkedAt !== undefined || value.parkOperationId !== undefined;
  if (hasParking && (!isRevision(value.parkedWorkspaceRevision) || !Number.isFinite(value.parkedAt)
    || typeof value.parkOperationId !== "string" || value.parkOperationId.length === 0 || value.parkOperationId.length > 512)) throw invalid();
  const owner = value.owner;
  if (["parentCastId", "loopId", "laneId"].some((key) => typeof owner[key] !== "string" || owner[key].length === 0 || owner[key].length > 512)
    || owner.parentCastId !== manifestOwner.parentCastId || owner.loopId !== manifestOwner.loopId || owner.laneId !== manifestOwner.laneId
    || [value.baseline, value.workspaceRevision, ...value.meaningfulChanges, ...(hasParking ? [value.parkedWorkspaceRevision] : [])]
      .some((revision) => revision.commitId.length > 512 || revision.changeId.length > 512)) throw invalid();
  return {
    version: 1,
    parentCastId: value.parentCastId,
    loopId: value.loopId,
    runId: value.runId,
    owner: { parentCastId: owner.parentCastId, loopId: owner.loopId, laneId: owner.laneId },
    baseline: { commitId: value.baseline.commitId, changeId: value.baseline.changeId },
    workspaceRevision: { commitId: value.workspaceRevision.commitId, changeId: value.workspaceRevision.changeId },
    streamIndex: value.streamIndex,
    queueIndex: value.queueIndex,
    meaningfulChanges: value.meaningfulChanges.map((revision) => ({ commitId: revision.commitId, changeId: revision.changeId })),
    preparedAt: value.preparedAt,
    ...(hasParking ? {
      parkedWorkspaceRevision: { commitId: value.parkedWorkspaceRevision.commitId, changeId: value.parkedWorkspaceRevision.changeId },
      parkedAt: value.parkedAt,
      parkOperationId: value.parkOperationId,
    } : {}),
  };
}

function isRevision(value: unknown): value is JjRevisionIdentity {
  return isRecord(value) && typeof value.commitId === "string" && value.commitId.trim().length > 0 && typeof value.changeId === "string";
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if (isNotFound(error)) return false; throw error; }
}

export async function isDirectory(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new JjWorkspaceError("workspace_symlink", `Refusing to inspect symlink ${JSON.stringify(file)}.`);
    return stat.isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function createDefaultJjCommandExecutor(options: { timeoutMs?: number; maxOutputBytes?: number } = {}): JjCommandExecutor {
  const timeout = positiveLimit(options.timeoutMs, 30_000);
  const maxBuffer = positiveLimit(options.maxOutputBytes, 4 * 1024 * 1024);
  return ({ executable, args, cwd }) => new Promise((resolve) => {
    execFile(executable, [...args], { cwd, shell: false, timeout, maxBuffer }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: code, ...(error?.signal ? { signal: error.signal } : {}) });
    });
  });
}

export async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
