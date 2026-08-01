import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertAbsentOrDirectory,
  assertNoSymlinkAncestors,
  assertNoSymlinkComponents,
  assertSafeRoot,
  completeBaseline,
  createDefaultJjCommandExecutor,
  exists,
  isDirectory,
  isNotFound,
  isRecord,
  isWithin,
  manifestPathFor,
  ownerOf,
  parseBaseline,
  parseManifest,
  positiveLimit,
  removeOwnedDirectory,
  removeOwnedManifest,
  samePath,
  validateOwner,
  workspaceNameFor,
  writeJsonAtomically,
} from "./jjWorkspaceSupport.js";

/** The version of the on-disk ownership records written by this adapter. */
export const JJ_WORKSPACE_MANIFEST_VERSION = 1 as const;
export const JJ_WORKSPACE_ROOT_MANIFEST = ".pi-materia-jj-workspace-root.json";
export const JJ_WORKSPACE_MANIFEST_DIRECTORY = ".manifests";
export const DEFAULT_JJ_WORKSPACE_ROOT = path.join(os.tmpdir(), "pi-materia", "jj-workspaces");

const REVISION_TEMPLATE = 'commit_id ++ "\\t" ++ change_id ++ "\\n"';
const OPERATION_TEMPLATE = 'id ++ "\\n"';

export interface JjCommandInput {
  executable: string;
  args: readonly string[];
  cwd: string;
}

export interface JjCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  /** Optional optimization for command fakes; real jj commands use op log. */
  operationId?: string;
}

/** Injectable, shell-free command boundary for the jj adapter. */
export type JjCommandExecutor = (input: JjCommandInput) => Promise<JjCommandResult>;

export interface JjRevisionIdentity {
  commitId: string;
  changeId: string;
}

export interface JjWorkspaceOwner {
  parentCastId: string;
  loopId: string;
  laneId: string;
}

export type JjWorkspaceLifecycleState = "active" | "forgotten";

/** Durable ownership record kept outside the child working copy. */
export interface JjWorkspaceManifest {
  version: typeof JJ_WORKSPACE_MANIFEST_VERSION;
  backend: "jj";
  owner: JjWorkspaceOwner;
  repositoryRoot: string;
  workspaceRoot: string;
  workspacePath: string;
  workspaceName: string;
  baseline: JjRevisionIdentity;
  revision: JjRevisionIdentity;
  operationId: string;
  state: JjWorkspaceLifecycleState;
  createdAt: number;
  updatedAt: number;
  forgottenAt?: number;
  forgetOperationId?: string;
}

/** Public record returned by lifecycle operations. */
export interface JjWorkspaceRecord extends JjWorkspaceManifest {
  /** Alias retained for callers that use cwd terminology for a lane. */
  cwd: string;
  /** Alias retained for callers that use path terminology for a lane. */
  path: string;
  /** Absolute path to the ownership manifest. */
  manifestPath: string;
  baselineCommitId: string;
  revisionCommitId: string;
}

export interface JjWorkspaceInspection extends JjWorkspaceRecord {
  exists: boolean;
  tracked: boolean;
  currentRevision?: JjRevisionIdentity;
}

export interface JjWorkspaceCreateInput extends JjWorkspaceOwner {
  /** Any directory inside the jj repository. Defaults to the configured root. */
  cwd?: string;
  /** Explicit repository root, useful when the backend is not preconfigured. */
  repositoryRoot?: string;
  /** Per-run override. It must be outside the repository and be runtime-owned. */
  workspaceRoot?: string;
  /** A literal commit id or a previously pinned baseline identity. */
  baseline?: string | JjRevisionIdentity;
  /** Alias for integrations that persist only the commit identity. */
  baselineCommitId?: string;
}

export type JjWorkspaceReference = string | (Partial<Pick<JjWorkspaceRecord, "workspacePath" | "path">> & Partial<JjWorkspaceOwner> & { workspaceRoot?: string; workspaceName?: string });

export interface JjWorkspaceBackendOptions {
  jjExecutable?: string;
  executable?: string;
  repositoryRoot?: string;
  workspaceRoot?: string;
  command?: JjCommandExecutor;
  runCommand?: JjCommandExecutor;
  now?: () => number;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface JjRepositoryCapability {
  repositoryRoot: string;
  executable: string;
}

export interface JjPinnedBaseline {
  repositoryRoot: string;
  baseline: JjRevisionIdentity;
  pinnedAt: number;
  operationId: string;
}

export interface JjWorkspaceRemovalResult {
  workspacePath: string;
  manifestPath: string;
  workspaceName: string;
  operationId: string;
  removed: boolean;
}

export class JjWorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JjWorkspaceError";
    this.code = code;
  }
}

export class JjWorkspaceCommandError extends JjWorkspaceError {
  readonly command: JjCommandInput;
  readonly result: JjCommandResult;

  constructor(command: JjCommandInput, result: JjCommandResult) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    super("jj_command_failed", `jj command failed (${command.args.join(" ")}): ${details}`);
    this.name = "JjWorkspaceCommandError";
    this.command = command;
    this.result = result;
  }
}

/**
 * jj-only lifecycle adapter for isolated parallel lanes.
 *
 * All repository commands use --ignore-working-copy. In particular, fan-out
 * never runs `jj new` (or any other command) in the parent working copy: the
 * lane is created directly from a literal baseline commit by `workspace add`.
 */
export class JjWorkspaceBackend {
  readonly #executable: string;
  readonly #configuredRepositoryRoot?: string;
  readonly #configuredWorkspaceRoot: string;
  readonly #command: JjCommandExecutor;
  readonly #now: () => number;
  readonly #knownWorkspaceRoots = new Set<string>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: JjWorkspaceBackendOptions = {}) {
    this.#executable = options.jjExecutable ?? options.executable ?? "jj";
    this.#configuredRepositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : undefined;
    this.#configuredWorkspaceRoot = path.resolve(options.workspaceRoot ?? DEFAULT_JJ_WORKSPACE_ROOT);
    this.#command = options.command ?? options.runCommand ?? createDefaultJjCommandExecutor({
      timeoutMs: options.commandTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    this.#now = options.now ?? (() => Date.now());
    this.#knownWorkspaceRoots.add(this.#configuredWorkspaceRoot);
  }

  /** Verify that cwd is backed by jj and return its canonical repository root. */
  async verifyRepository(cwd = this.#configuredRepositoryRoot): Promise<JjRepositoryCapability> {
    if (!cwd) throw new JjWorkspaceError("repository_required", "A jj repository directory is required.");
    const requested = path.resolve(cwd);
    const result = await this.#run(["root"], requested);
    this.#requireSuccess(result, ["root"], requested);
    const outputRoot = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!outputRoot) throw new JjWorkspaceError("jj_root_missing", "jj root returned no repository root.");
    const repositoryRoot = path.resolve(requested, outputRoot);
    if (this.#configuredRepositoryRoot && !samePath(repositoryRoot, this.#configuredRepositoryRoot)) {
      throw new JjWorkspaceError("repository_mismatch", `jj repository root ${JSON.stringify(repositoryRoot)} does not match configured root ${JSON.stringify(this.#configuredRepositoryRoot)}.`);
    }
    return { repositoryRoot, executable: this.#executable };
  }

  /** Naming alias for callers that emphasize capability detection. */
  async verifyRepositoryCapability(cwd = this.#configuredRepositoryRoot): Promise<JjRepositoryCapability> {
    return this.verifyRepository(cwd);
  }

  /** Pin a literal commit/change identity without changing the working copy. */
  async pinBaseline(cwd = this.#configuredRepositoryRoot): Promise<JjPinnedBaseline> {
    const capability = await this.verifyRepository(cwd);
    const baseline = await this.#readRevision(capability.repositoryRoot, "@");
    return {
      repositoryRoot: capability.repositoryRoot,
      baseline,
      pinnedAt: this.#now(),
      operationId: await this.#latestOperationId(capability.repositoryRoot),
    };
  }

  /** Naming alias for callers that use immutable-baseline terminology. */
  async pinImmutableBaseline(cwd = this.#configuredRepositoryRoot): Promise<JjPinnedBaseline> {
    return this.pinBaseline(cwd);
  }

  /**
   * Create (or recover) one uniquely named lane workspace.
   *
   * The ownership manifest is outside the lane directory so it cannot become
   * an accidental lane change or be modified by a child agent.
   */
  async create(input: JjWorkspaceCreateInput): Promise<JjWorkspaceRecord> {
    validateOwner(ownerOf(input));
    return this.#withMutation(async () => {
      const capability = await this.verifyRepository(input.repositoryRoot ?? input.cwd ?? this.#configuredRepositoryRoot);
      const root = await this.#prepareWorkspaceRoot(input.workspaceRoot ?? this.#configuredWorkspaceRoot, capability.repositoryRoot);
      const owner = ownerOf(input);
      const workspaceName = workspaceNameFor(capability.repositoryRoot, owner);
      const workspacePath = path.join(root, workspaceName);
      const manifestPath = manifestPathFor(root, workspaceName);
      const requestedBaseline = input.baseline
        ?? (input.baselineCommitId ? input.baselineCommitId : undefined);

      // Check the durable identity before reading the current parent @. This
      // is what makes a repeated create idempotent after the parent advances.
      const existing = await this.#readManifestIfPresent(manifestPath);
      if (existing) {
        this.#validateManifestOwnership(existing, { owner, repositoryRoot: capability.repositoryRoot, workspaceRoot: root, workspacePath });
        if (requestedBaseline !== undefined && existing.baseline.commitId !== parseBaseline(requestedBaseline).commitId) {
          throw new JjWorkspaceError("baseline_mismatch", `Workspace ${JSON.stringify(workspaceName)} is already pinned to a different baseline.`);
        }
        await this.#assertSafeWorkspacePath(existing.workspacePath, root);
        return this.#record(existing, manifestPath);
      }

      const baseline = requestedBaseline === undefined
        ? await this.#readRevision(capability.repositoryRoot, "@")
        : await completeBaseline(capability.repositoryRoot, parseBaseline(requestedBaseline), (cwd, revset) => this.#readRevision(cwd, revset));

      await assertAbsentOrDirectory(workspacePath, "workspace destination");
      if (await exists(manifestPath)) throw new JjWorkspaceError("manifest_conflict", `Ownership manifest already exists at ${JSON.stringify(manifestPath)}.`);

      const addArgs = ["workspace", "add", "--name", workspaceName, "--revision", baseline.commitId, workspacePath];
      // Recent jj versions materialize and register the workspace, then
      // return a non-zero status because the parent WC is intentionally not
      // updated under --ignore-working-copy. Accept that precise outcome only
      // after proving both the lane directory and workspace registration
      // exist; never retry without --ignore-working-copy, since doing so can
      // snapshot/rewrite a dirty parent working copy.
      const addResult = await this.#run(addArgs, capability.repositoryRoot);
      if (addResult.exitCode !== 0) {
        const intentionalNoParentUpdate = /must be able to update the working copy|don't use --ignore-working-copy/i.test(addResult.stderr);
        const createdWithoutParentUpdate = await isDirectory(workspacePath) && await this.#isTracked(capability.repositoryRoot, workspaceName);
        if (!intentionalNoParentUpdate || !createdWithoutParentUpdate) this.#requireSuccess(addResult, addArgs, capability.repositoryRoot);
      }
      const operationId = addResult.operationId ?? await this.#latestOperationId(capability.repositoryRoot);
      try {
        const revision = await this.#readRevision(workspacePath, "@");
        const timestamp = this.#now();
        const manifest: JjWorkspaceManifest = {
          version: JJ_WORKSPACE_MANIFEST_VERSION,
          backend: "jj",
          owner,
          repositoryRoot: capability.repositoryRoot,
          workspaceRoot: root,
          workspacePath,
          workspaceName,
          baseline,
          revision,
          operationId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await writeJsonAtomically(manifestPath, manifest);
        return this.#record(manifest, manifestPath);
      } catch (error) {
        // The workspace was created but the ownership record was not. Try to
        // undo only the workspace we just named; never touch the parent files.
        await this.#forgetWorkspaceByName(capability.repositoryRoot, workspaceName).catch(() => undefined);
        await removeOwnedDirectory(workspacePath, root).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Naming alias for lifecycle callers that use createWorkspace terminology. */
  async createWorkspace(input: JjWorkspaceCreateInput): Promise<JjWorkspaceRecord> {
    return this.create(input);
  }

  /** Inspect only a workspace owned by this backend; foreign paths are rejected. */
  async inspect(reference: JjWorkspaceReference): Promise<JjWorkspaceInspection | undefined> {
    const root = this.#referenceRoot(reference);
    const target = await this.#resolveReference(reference);
    const manifestPath = manifestPathFor(root, path.basename(target));
    const manifest = await this.#readManifestIfPresent(manifestPath);
    if (!manifest) return undefined;
    await this.#assertSafeWorkspacePath(target, manifest.workspaceRoot);
    this.#validateManifestOwnership(manifest, {
      owner: manifest.owner,
      repositoryRoot: manifest.repositoryRoot,
      workspaceRoot: manifest.workspaceRoot,
      workspacePath: target,
    });
    const existsOnDisk = await isDirectory(target);
    const tracked = await this.#isTracked(manifest.repositoryRoot, manifest.workspaceName);
    const currentRevision = existsOnDisk ? await this.#readRevision(target, "@").catch(() => undefined) : undefined;
    return {
      ...this.#record(manifest, manifestPath),
      exists: existsOnDisk,
      tracked,
      ...(currentRevision ? { currentRevision } : {}),
    };
  }

  /** Naming alias for lifecycle callers that use inspectWorkspace terminology. */
  async inspectWorkspace(reference: JjWorkspaceReference): Promise<JjWorkspaceInspection | undefined> {
    return this.inspect(reference);
  }

  /** Stop jj tracking but deliberately leave the lane directory for diagnosis. */
  async forget(reference: JjWorkspaceReference): Promise<JjWorkspaceRecord> {
    return this.#withMutation(async () => {
      const loaded = await this.#loadOwnedReference(reference);
      if (loaded.state === "forgotten") return this.#record(loaded, manifestPathFor(loaded.workspaceRoot, loaded.workspaceName));
      const inspection = await this.#inspectLoaded(loaded);
      if (!inspection.tracked) {
        const updated: JjWorkspaceManifest = {
          ...loaded,
          ...(inspection.currentRevision ? { revision: inspection.currentRevision } : {}),
          state: "forgotten",
          forgottenAt: loaded.forgottenAt ?? this.#now(),
          updatedAt: this.#now(),
        };
        await writeJsonAtomically(inspection.manifestPath, updated);
        return this.#record(updated, inspection.manifestPath);
      }

      const args = ["workspace", "forget", loaded.workspaceName];
      const result = await this.#run(args, loaded.repositoryRoot);
      this.#requireSuccess(result, args, loaded.repositoryRoot);
      const operationId = result.operationId ?? await this.#latestOperationId(loaded.repositoryRoot);
      const updated: JjWorkspaceManifest = {
        ...loaded,
        ...(inspection.currentRevision ? { revision: inspection.currentRevision } : {}),
        state: "forgotten",
        forgottenAt: this.#now(),
        forgetOperationId: operationId,
        updatedAt: this.#now(),
      };
      await writeJsonAtomically(inspection.manifestPath, updated);
      return this.#record(updated, inspection.manifestPath);
    });
  }

  /** Naming alias for lifecycle callers that use forgetWorkspace terminology. */
  async forgetWorkspace(reference: JjWorkspaceReference): Promise<JjWorkspaceRecord> {
    return this.forget(reference);
  }

  /**
   * Forget and remove a lane, after proving that its manifest owns the exact
   * path. The parent repository and all other lane directories are untouched.
   */
  async remove(reference: JjWorkspaceReference, options: { forget?: boolean } = {}): Promise<JjWorkspaceRemovalResult> {
    const shouldForget = options.forget ?? true;
    const loaded = await this.#loadOwnedReference(reference);
    const inspection = loaded.state === "forgotten"
      ? { exists: await isDirectory(loaded.workspacePath), tracked: false, manifestPath: manifestPathFor(loaded.workspaceRoot, loaded.workspaceName) }
      : await this.#inspectLoaded(loaded);
    let record = this.#record(loaded, inspection.manifestPath);
    if (shouldForget && inspection.tracked) record = await this.forget(record);
    else if (inspection.tracked) throw new JjWorkspaceError("workspace_still_tracked", `Refusing to remove tracked workspace ${JSON.stringify(record.workspaceName)} without forgetting it.`);

    await this.#assertSafeWorkspacePath(record.workspacePath, record.workspaceRoot);
    await removeOwnedDirectory(record.workspacePath, record.workspaceRoot);
    await removeOwnedManifest(record.manifestPath, record.workspaceRoot);
    return {
      workspacePath: record.workspacePath,
      manifestPath: record.manifestPath,
      workspaceName: record.workspaceName,
      operationId: record.forgetOperationId ?? record.operationId,
      removed: true,
    };
  }

  /** Naming alias for lifecycle callers that use removeWorkspace terminology. */
  async removeWorkspace(reference: JjWorkspaceReference, options: { forget?: boolean } = {}): Promise<JjWorkspaceRemovalResult> {
    return this.remove(reference, options);
  }

  /** Explicit name for callers that want to emphasize ownership checks. */
  async removeOwnedDirectory(reference: JjWorkspaceReference, options: { forget?: boolean } = {}): Promise<JjWorkspaceRemovalResult> {
    return this.remove(reference, { forget: options.forget ?? false });
  }

  /** Alias used by lifecycle/finalization callers. */
  async cleanup(reference: JjWorkspaceReference): Promise<JjWorkspaceRemovalResult> {
    return this.remove(reference, { forget: true });
  }

  #referenceRoot(reference: JjWorkspaceReference): string {
    if (typeof reference !== "string") return path.resolve(reference.workspaceRoot ?? this.#configuredWorkspaceRoot);
    if (!path.isAbsolute(reference)) return this.#configuredWorkspaceRoot;
    const target = path.resolve(reference);
    return [...this.#knownWorkspaceRoots]
      .filter((root) => isWithin(root, target))
      .sort((left, right) => right.length - left.length)[0] ?? this.#configuredWorkspaceRoot;
  }

  async #resolveReference(reference: JjWorkspaceReference): Promise<string> {
    const root = this.#referenceRoot(reference);
    await assertSafeRoot(root);
    if (typeof reference === "string") {
      const target = path.isAbsolute(reference) ? path.resolve(reference) : path.resolve(root, reference);
      await this.#assertSafeWorkspacePath(target, root);
      return target;
    }
    const target = path.resolve(reference.workspacePath ?? reference.path ?? path.join(root, reference.workspaceName ?? ""));
    await this.#assertSafeWorkspacePath(target, root);
    return target;
  }

  async #loadOwnedReference(reference: JjWorkspaceReference): Promise<JjWorkspaceManifest> {
    const root = this.#referenceRoot(reference);
    const target = await this.#resolveReference(reference);
    const expectedManifestPath = manifestPathFor(root, path.basename(target));
    const manifest = await this.#readManifestIfPresent(expectedManifestPath);
    if (!manifest) throw new JjWorkspaceError("workspace_not_owned", `No jj workspace ownership manifest exists for ${JSON.stringify(target)}.`);
    await this.#assertSafeWorkspacePath(target, manifest.workspaceRoot);
    this.#validateManifestOwnership(manifest, {
      owner: manifest.owner,
      repositoryRoot: manifest.repositoryRoot,
      workspaceRoot: manifest.workspaceRoot,
      workspacePath: target,
    });
    return manifest;
  }

  async #inspectLoaded(manifest: JjWorkspaceManifest): Promise<JjWorkspaceInspection> {
    const manifestPath = manifestPathFor(manifest.workspaceRoot, manifest.workspaceName);
    await this.#assertSafeWorkspacePath(manifest.workspacePath, manifest.workspaceRoot);
    const existsOnDisk = await isDirectory(manifest.workspacePath);
    const tracked = await this.#isTracked(manifest.repositoryRoot, manifest.workspaceName);
    const currentRevision = existsOnDisk ? await this.#readRevision(manifest.workspacePath, "@").catch(() => undefined) : undefined;
    return {
      ...this.#record(manifest, manifestPath),
      exists: existsOnDisk,
      tracked,
      ...(currentRevision ? { currentRevision } : {}),
    };
  }

  async #prepareWorkspaceRoot(requestedRoot: string, repositoryRoot: string): Promise<string> {
    const root = path.resolve(requestedRoot);
    if (samePath(root, repositoryRoot) || isWithin(repositoryRoot, root) || isWithin(root, repositoryRoot)) {
      throw new JjWorkspaceError("workspace_root_not_external", `jj lane workspace root ${JSON.stringify(root)} must be external to repository ${JSON.stringify(repositoryRoot)}.`);
    }
    await assertNoSymlinkAncestors(root);
    await mkdir(root, { recursive: true });
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ${JSON.stringify(root)} must be a real directory.`);
    const rootManifestPath = path.join(root, JJ_WORKSPACE_ROOT_MANIFEST);
    const manifestsRoot = path.join(root, JJ_WORKSPACE_MANIFEST_DIRECTORY);
    await assertNoSymlinkAncestors(root);
    if (await exists(rootManifestPath)) {
      const rootManifestStat = await lstat(rootManifestPath);
      if (rootManifestStat.isSymbolicLink() || !rootManifestStat.isFile()) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ownership marker ${JSON.stringify(rootManifestPath)} is not a regular file.`);
      const raw = await readFile(rootManifestPath, "utf8");
      let marker: unknown;
      try { marker = JSON.parse(raw); } catch { throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ownership marker ${JSON.stringify(rootManifestPath)} is invalid.`); }
      if (!isRecord(marker) || marker.backend !== "jj" || marker.version !== JJ_WORKSPACE_MANIFEST_VERSION) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ${JSON.stringify(root)} is owned by an incompatible backend.`);
    } else {
      const existingEntries = await readdir(root);
      if (existingEntries.length > 0) throw new JjWorkspaceError("workspace_root_unowned", `Workspace root ${JSON.stringify(root)} is non-empty and has no ownership marker.`);
      await writeJsonAtomically(rootManifestPath, {
        version: JJ_WORKSPACE_MANIFEST_VERSION,
        backend: "jj",
        createdAt: this.#now(),
      });
    }
    await mkdir(manifestsRoot, { recursive: true });
    this.#knownWorkspaceRoots.add(root);
    const manifestsStat = await lstat(manifestsRoot);
    if (manifestsStat.isSymbolicLink() || !manifestsStat.isDirectory()) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace manifest directory ${JSON.stringify(manifestsRoot)} must be a real directory.`);
    return root;
  }

  async #readManifestIfPresent(file: string): Promise<JjWorkspaceManifest | undefined> {
    let raw: string;
    try {
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new JjWorkspaceError("manifest_unsafe", `Workspace ownership manifest ${JSON.stringify(file)} must be a regular file.`);
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new JjWorkspaceError("manifest_invalid", `Workspace ownership manifest ${JSON.stringify(file)} is invalid JSON.`); }
    return parseManifest(value, file);
  }

  #record(manifest: JjWorkspaceManifest, manifestPath: string): JjWorkspaceRecord {
    return {
      ...manifest,
      owner: { ...manifest.owner },
      baseline: { ...manifest.baseline },
      revision: { ...manifest.revision },
      cwd: manifest.workspacePath,
      path: manifest.workspacePath,
      manifestPath,
      baselineCommitId: manifest.baseline.commitId,
      revisionCommitId: manifest.revision.commitId,
    };
  }

  #validateManifestOwnership(manifest: JjWorkspaceManifest, expected: { owner: JjWorkspaceOwner; repositoryRoot: string; workspaceRoot: string; workspacePath: string }): void {
    if (manifest.backend !== "jj" || manifest.version !== JJ_WORKSPACE_MANIFEST_VERSION) throw new JjWorkspaceError("manifest_invalid", "Workspace ownership manifest is not a supported jj manifest.");
    if (!samePath(manifest.repositoryRoot, expected.repositoryRoot)) throw new JjWorkspaceError("workspace_repository_mismatch", "Workspace manifest belongs to a different repository.");
    if (!samePath(manifest.workspaceRoot, expected.workspaceRoot)) throw new JjWorkspaceError("workspace_root_mismatch", "Workspace manifest belongs to a different runtime workspace root.");
    if (!samePath(manifest.workspacePath, expected.workspacePath)) throw new JjWorkspaceError("workspace_path_mismatch", "Workspace manifest path does not match the requested owned directory.");
    if (manifest.owner.parentCastId !== expected.owner.parentCastId || manifest.owner.loopId !== expected.owner.loopId || manifest.owner.laneId !== expected.owner.laneId) {
      throw new JjWorkspaceError("workspace_owner_mismatch", "Workspace manifest owner does not match the requested lane.");
    }
  }

  async #assertSafeWorkspacePath(target: string, root: string): Promise<void> {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    if (!isWithin(resolvedRoot, resolvedTarget)) throw new JjWorkspaceError("workspace_path_escape", `Workspace path ${JSON.stringify(resolvedTarget)} is outside owned root ${JSON.stringify(resolvedRoot)}.`);
    if (samePath(resolvedRoot, resolvedTarget)) throw new JjWorkspaceError("workspace_path_escape", "The workspace root itself cannot be inspected or removed.");
    await assertNoSymlinkComponents(resolvedRoot, resolvedTarget);
  }

  async #readRevision(cwd: string, revset: string): Promise<JjRevisionIdentity> {
    const args = ["log", "-r", revset, "--no-graph", "-T", REVISION_TEMPLATE];
    const result = await this.#run(args, cwd);
    this.#requireSuccess(result, args, cwd);
    const line = result.stdout.trim().split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    const [commitId, changeId] = line?.split("\t") ?? [];
    if (!commitId || !changeId) throw new JjWorkspaceError("revision_missing", `jj did not return a revision identity for ${JSON.stringify(revset)}.`);
    return { commitId, changeId };
  }

  async #isTracked(repositoryRoot: string, workspaceName: string): Promise<boolean> {
    const args = ["workspace", "list"];
    const result = await this.#run(args, repositoryRoot);
    this.#requireSuccess(result, args, repositoryRoot);
    return result.stdout.split(/\r?\n/).some((line) => {
      const candidate = line.trim().split(/\s|:/, 1)[0];
      return candidate === workspaceName;
    });
  }

  async #latestOperationId(repositoryRoot: string): Promise<string> {
    const args = ["op", "log", "--no-graph", "-n", "1", "-T", OPERATION_TEMPLATE];
    const result = await this.#run(args, repositoryRoot);
    this.#requireSuccess(result, args, repositoryRoot);
    const operationId = result.operationId ?? result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!operationId) throw new JjWorkspaceError("operation_id_missing", "jj operation log returned no operation identity.");
    return operationId;
  }

  async #forgetWorkspaceByName(repositoryRoot: string, workspaceName: string): Promise<void> {
    const args = ["workspace", "forget", workspaceName];
    const result = await this.#run(args, repositoryRoot);
    if (result.exitCode !== 0) return;
  }

  async #run(args: readonly string[], cwd: string, ignoreWorkingCopy = true): Promise<JjCommandResult> {
    return this.#command({ executable: this.#executable, args: [...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []), ...args], cwd });
  }

  #requireSuccess(result: JjCommandResult, args: readonly string[], cwd: string, ignoreWorkingCopy = true): void {
    if (result.exitCode !== 0) {
      throw new JjWorkspaceCommandError({ executable: this.#executable, args: [...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []), ...args], cwd }, result);
    }
  }

  async #withMutation<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await task(); } finally { release(); }
  }
}

/** Factory kept alongside the adapter for dependency-injected infrastructure wiring. */
export function createJjWorkspaceBackend(options: JjWorkspaceBackendOptions = {}): JjWorkspaceBackend {
  return new JjWorkspaceBackend(options);
}

/** Alias for callers that use manager terminology for this lifecycle port. */
export const createJjWorkspaceManager = createJjWorkspaceBackend;
export const createJjWorkspaceLifecycle = createJjWorkspaceBackend;
export const JjWorkspaceManager = JjWorkspaceBackend;
export const JjWorkspaceLifecycle = JjWorkspaceBackend;
export type JjWorkspaceManager = JjWorkspaceBackend;
export type JjWorkspaceLifecycle = JjWorkspaceBackend;

