import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  MateriaParallelFanInHead,
  MateriaParallelFanInProvenance,
  MateriaParallelFinalizationProvenance,
} from "../domain/parallelRunTypes.js";
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
const FAN_IN_REVISION_TEMPLATE = 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ conflict ++ "\\t" ++ conflicted_files.map(|f| f.path()).join("|") ++ "\\n"';

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

export interface JjFanInLaneInput {
  laneId: string;
  streamIndex: number;
  queueIndex: number;
  workItemIndexes: readonly number[];
  status: "queued" | "running" | "accepted" | "failed" | "interrupted";
  acceptedHead?: JjRevisionIdentity;
  workspace?: JjWorkspaceReference;
}

export interface JjFanInInput {
  parentCastId: string;
  loopId: string;
  runId: string;
  cwd: string;
  repositoryRoot?: string;
  baseline: JjRevisionIdentity;
  /** Normalized stream order. Completion order is deliberately ignored. */
  queueOrder: readonly string[];
  lanes: readonly JjFanInLaneInput[];
  now?: number;
}

export interface JjFanInResult extends MateriaParallelFanInProvenance {
  /** True for a clean integration and false for a materialized conflict. */
  satisfied: boolean;
}

export interface JjParallelFinalizeInput {
  parentCastId: string;
  loopId: string;
  runId: string;
  cwd: string;
  repositoryRoot?: string;
  /** The durable fan-in record, including every owned lane workspace. */
  fanIn: MateriaParallelFanInProvenance;
  /** Acceptance from the post-integration evaluator/resolver route. */
  evaluationAccepted: boolean;
  /** Bootstrap-owned bookmark. Finalization never invents a replacement. */
  bookmarkName: string;
  /** Optional deterministic description override for the integration revision. */
  description?: string;
}

export interface JjParallelFinalizeResult extends MateriaParallelFinalizationProvenance {
  /** True only when the bookmark, fresh parent working commit, and cleanup all succeeded. */
  satisfied: boolean;
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
   * Materialize one deterministic parent merge from accepted lane heads.
   *
   * All verification happens before `jj new`. The command is deliberately run
   * with --ignore-working-copy: jj creates the integration revision in the
   * repository operation while leaving the parent working-copy commit and
   * filesystem untouched. The returned provenance proves both the pre-fan-in
   * parent revision and the exact ordered parents of the new revision.
   */
  async fanIn(input: JjFanInInput): Promise<JjFanInResult> {
    validateFanInInput(input);
    return this.#withMutation(async () => {
      const capability = await this.verifyRepository(input.repositoryRoot ?? input.cwd);
      const parentBefore = await this.#readRevision(capability.repositoryRoot, "@");
      if (!sameRevision(parentBefore, input.baseline)) {
        throw new JjWorkspaceError("fan_in_parent_drift", `Parent working-copy revision ${parentBefore.commitId} does not match pinned baseline ${input.baseline.commitId}.`);
      }
      const parentStatus = await this.#run(["status"], capability.repositoryRoot);
      this.#requireSuccess(parentStatus, ["status"], capability.repositoryRoot);
      if (!isCleanJjStatus(parentStatus.stdout)) {
        throw new JjWorkspaceError("fan_in_parent_dirty", "Parent working copy has changes; fan-in refuses to snapshot or rewrite it.");
      }

      const ordered = orderFanInLanes(input);
      const startedAt = this.#now();
      const orderedHeads: MateriaParallelFanInHead[] = [];
      for (const lane of ordered) {
        const workspaceReference = lane.workspace;
        if (!workspaceReference) throw new JjWorkspaceError("fan_in_workspace_missing", `Parallel lane ${JSON.stringify(lane.laneId)} has no workspace reference.`);
        const manifest = await this.#loadOwnedReference(workspaceReference);
        this.#validateManifestOwnership(manifest, {
          owner: { parentCastId: input.parentCastId, loopId: input.loopId, laneId: lane.laneId },
          repositoryRoot: capability.repositoryRoot,
          workspaceRoot: manifest.workspaceRoot,
          workspacePath: manifest.workspacePath,
        });
        if (!sameRevision(manifest.baseline, input.baseline)) {
          throw new JjWorkspaceError("fan_in_baseline_mismatch", `Lane ${JSON.stringify(lane.laneId)} workspace is pinned to a different baseline.`);
        }

        const inspection = await this.#inspectLoaded(manifest);
        if (!inspection.exists || !inspection.tracked || !inspection.currentRevision) {
          throw new JjWorkspaceError("fan_in_workspace_lost", `Lane ${JSON.stringify(lane.laneId)} workspace is missing or no longer tracked.`);
        }
        // A normal status command snapshots the lane filesystem, but only in
        // the lane workspace. A dirty result is rejected rather than silently
        // turning uncheckpointed work into an eligible head.
        const laneStatus = await this.#run(["status"], manifest.workspacePath, false);
        this.#requireSuccess(laneStatus, ["status"], manifest.workspacePath, false);
        if (!isCleanJjStatus(laneStatus.stdout)) {
          throw new JjWorkspaceError("fan_in_lane_dirty", `Lane ${JSON.stringify(lane.laneId)} workspace has uncheckpointed changes.`);
        }
        const acceptedHead = await this.#readRevision(manifest.workspacePath, lane.acceptedHead!.commitId);
        if (!sameRevision(acceptedHead, lane.acceptedHead!)) {
          throw new JjWorkspaceError("fan_in_head_drift", `Lane ${JSON.stringify(lane.laneId)} accepted head identity changed before fan-in.`);
        }
        if (!(await this.#isAncestor(manifest.workspacePath, acceptedHead.commitId, inspection.currentRevision.commitId))) {
          throw new JjWorkspaceError("fan_in_head_drift", `Lane ${JSON.stringify(lane.laneId)} workspace no longer descends from its accepted head.`);
        }
        orderedHeads.push({
          laneId: lane.laneId,
          streamIndex: lane.streamIndex,
          queueIndex: lane.queueIndex,
          workItemIndexes: [...lane.workItemIndexes],
          head: acceptedHead,
          workspace: workspaceOwnershipFromManifest(manifest),
          workspaceRevision: inspection.currentRevision,
        });
      }

      // jj models parents as a set: when multiple no-op lanes retain the same
      // baseline head, passing that commit more than once still creates only
      // one parent. Keep every lane in orderedHeads for provenance, but use
      // jj's canonical unique parent list for creation and verification.
      const parentIds = uniqueParentIds(orderedHeads.map((entry) => entry.head.commitId));
      const createArgs = ["new", "--no-edit", ...parentIds];
      const created = await this.#run(createArgs, capability.repositoryRoot);
      this.#requireSuccess(created, createArgs, capability.repositoryRoot);
      const integration = await this.#findIntegrationRevision(capability.repositoryRoot, parentIds, created);
      const parentAfter = await this.#readRevision(capability.repositoryRoot, "@");
      if (!sameRevision(parentBefore, parentAfter)) {
        throw new JjWorkspaceError("fan_in_parent_changed", "jj fan-in changed the parent working-copy revision unexpectedly.");
      }
      const completedAt = this.#now();
      const operationId = created.operationId ?? await this.#latestOperationId(capability.repositoryRoot);
      const conflictDetails = integration.conflictedPaths.map((pathValue) => ({
        path: boundedFanInText(pathValue, 512),
        message: boundedFanInText(`jj reported a merge conflict for ${pathValue}`, 1_000),
      }));
      const outcome = integration.conflict ? "conflict" : "clean";
      return {
        version: 1,
        parentCastId: input.parentCastId,
        loopId: input.loopId,
        runId: input.runId,
        baseline: { ...input.baseline },
        parentRevisionBefore: parentBefore,
        parentRevisionAfter: parentAfter,
        orderedHeads,
        integrationRevision: integration.revision,
        outcome,
        conflictedPaths: integration.conflictedPaths,
        conflictDetails,
        operationId,
        startedAt,
        completedAt,
        satisfied: outcome === "clean",
      };
    });
  }

  /** Alias for callers that name the operation createIntegrationRevision. */
  async createIntegrationRevision(input: JjFanInInput): Promise<JjFanInResult> {
    return this.fanIn(input);
  }

  /**
   * Finalize an accepted clean/resolved integration.
   *
   * This is intentionally a separate boundary from fan-in. Evaluation failure
   * returns a preserved result without touching the bookmark, parent working
   * copy, or lane workspaces. Once accepted, the method verifies that jj no
   * longer reports conflicts, describes the integration revision, advances the
   * bootstrap-owned bookmark, moves the parent WC to a fresh empty child of the
   * integration, and only then removes owned lane workspaces.
   */
  async finalize(input: JjParallelFinalizeInput): Promise<JjParallelFinalizeResult> {
    validateParallelFinalizeInput(input);
    const fanIn = input.fanIn;
    const integration = fanIn.integrationRevision;
    const now = this.#now();
    const baseResult = {
      version: 1 as const,
      parentCastId: input.parentCastId,
      loopId: input.loopId,
      runId: input.runId,
      evaluationAccepted: input.evaluationAccepted,
      conflictFree: false,
      ...(integration ? { integrationRevision: { ...integration } } : {}),
      cleanedLaneIds: [] as string[],
      finalizedAt: now,
    };

    if (!input.evaluationAccepted) {
      return {
        ...baseResult,
        status: "preserved",
        reason: "post-integration evaluation was not accepted",
        satisfied: false,
      };
    }

    if (!integration) {
      throw new JjWorkspaceError("finalize_integration_missing", "Cannot finalize parallel work without an integration revision.");
    }
    if (!Array.isArray(fanIn.orderedHeads) || fanIn.orderedHeads.length === 0) {
      throw new JjWorkspaceError("finalize_lanes_missing", "Parallel finalization requires at least one ordered lane head.");
    }

    return this.#withMutation(async () => {
      const capability = await this.verifyRepository(input.repositoryRoot ?? input.cwd);
      const parentBefore = await this.#readRevision(capability.repositoryRoot, "@");
      const parentAtBaseline = sameRevision(parentBefore, fanIn.parentRevisionBefore) && sameRevision(parentBefore, fanIn.parentRevisionAfter);
      const parentAtResolvedIntegration = fanIn.outcome === "conflict" && sameRevision(parentBefore, integration);
      if (!parentAtBaseline && !parentAtResolvedIntegration) {
        throw new JjWorkspaceError("finalize_parent_drift", "Parent working-copy revision drifted after fan-in; integration state was preserved.");
      }
      const parentStatus = await this.#run(["status"], capability.repositoryRoot);
      this.#requireSuccess(parentStatus, ["status"], capability.repositoryRoot);
      if (!isCleanJjStatus(parentStatus.stdout)) {
        throw new JjWorkspaceError("finalize_parent_dirty", "Parent working copy is dirty; finalization refuses to rewrite it.");
      }

      // Validate every manifest before the first shared-repository mutation so
      // a missing or foreign lane cannot lead to partial cleanup.
      const manifests = new Map<string, JjWorkspaceManifest>();
      for (const head of fanIn.orderedHeads) {
        if (!head || typeof head.laneId !== "string" || !head.workspace || typeof head.workspace.workspacePath !== "string") {
          throw new JjWorkspaceError("finalize_workspace_missing", "Parallel finalization lane provenance is missing an owned workspace.");
        }
        const workspace = head.workspace;
        const key = path.resolve(workspace.workspacePath);
        if (manifests.has(key)) continue;
        const manifest = await this.#loadOwnedReference(workspace);
        this.#validateManifestOwnership(manifest, {
          owner: { parentCastId: input.parentCastId, loopId: input.loopId, laneId: head.laneId },
          repositoryRoot: capability.repositoryRoot,
          workspaceRoot: manifest.workspaceRoot,
          workspacePath: manifest.workspacePath,
        });
        if (!sameRevision(manifest.baseline, fanIn.baseline)) {
          throw new JjWorkspaceError("finalize_baseline_mismatch", `Lane ${JSON.stringify(head.laneId)} workspace is pinned to a different baseline.`);
        }
        manifests.set(key, manifest);
      }

      const details = await this.#readRevisionDetails(capability.repositoryRoot, integration.commitId);
      if (!sameRevision(details, integration)) {
        throw new JjWorkspaceError("finalize_integration_drift", "Integration revision identity changed before finalization.");
      }
      if (details.conflict) {
        throw new JjWorkspaceError("finalize_conflicts_remaining", "Post-integration evaluation was accepted, but jj still reports conflicts on the integration revision.");
      }

      const description = input.description?.trim() || `parallel: integrate ${input.loopId} (${input.runId})`;
      const describeArgs = ["describe", "-r", integration.commitId, "-m", description];
      const described = await this.#run(describeArgs, capability.repositoryRoot);
      this.#requireSuccess(described, describeArgs, capability.repositoryRoot);
      // A jj description rewrite keeps the change id but produces a new commit
      // id. Resolve through the stable change id after `describe`; the old
      // commit id remains addressable as an abandoned predecessor and would
      // otherwise send the bookmark and fresh parent to stale integration.
      const describedRevision = await this.#readRevision(capability.repositoryRoot, integration.changeId);
      if (describedRevision.changeId !== integration.changeId) {
        throw new JjWorkspaceError("finalize_integration_drift", "Described integration revision could not be re-verified through its stable change id.");
      }

      await this.#setBookmark(input.bookmarkName, describedRevision.commitId, capability.repositoryRoot);
      const bookmarked = await this.#readRevision(capability.repositoryRoot, input.bookmarkName);
      if (!sameRevision(bookmarked, describedRevision)) {
        throw new JjWorkspaceError("finalize_bookmark_mismatch", `Bootstrap-owned bookmark ${JSON.stringify(input.bookmarkName)} does not point at the described integration revision.`);
      }

      const newArgs = ["new", describedRevision.commitId];
      const created = await this.#run(newArgs, capability.repositoryRoot, false);
      this.#requireSuccess(created, newArgs, capability.repositoryRoot, false);
      const parentWorkingRevision = await this.#readRevision(capability.repositoryRoot, "@");
      const empty = await this.#run(["log", "-r", "@", "--no-graph", "-T", "empty"], capability.repositoryRoot, false);
      this.#requireSuccess(empty, ["log", "-r", "@", "--no-graph", "-T", "empty"], capability.repositoryRoot, false);
      if (empty.stdout.trim().toLowerCase() !== "true") {
        throw new JjWorkspaceError("finalize_parent_not_empty", "jj new did not produce a verifiably empty parent working commit.");
      }
      const parentOfWorking = await this.#readRevision(capability.repositoryRoot, "@-", false);
      if (!sameRevision(parentOfWorking, describedRevision)) {
        throw new JjWorkspaceError("finalize_parent_wrong", "Fresh parent working commit does not descend directly from the described integration revision.");
      }

      const cleanedLaneIds: string[] = [];
      for (const head of fanIn.orderedHeads) {
        const key = path.resolve(head.workspace.workspacePath);
        if (!manifests.has(key)) continue;
        await this.#cleanupOwnedWorkspace(manifests.get(key)!);
        cleanedLaneIds.push(head.laneId);
        manifests.delete(key);
      }
      return {
        ...baseResult,
        conflictFree: true,
        integrationRevision: describedRevision,
        bookmarkName: input.bookmarkName,
        parentWorkingRevision,
        cleanedLaneIds,
        status: "completed",
        description,
        finalizedAt: this.#now(),
        satisfied: true,
      };
    });
  }

  /** Naming aliases for callers that use integration/coordinator terminology. */
  async finalizeParallelRun(input: JjParallelFinalizeInput): Promise<JjParallelFinalizeResult> {
    return this.finalize(input);
  }

  async finalizeIntegration(input: JjParallelFinalizeInput): Promise<JjParallelFinalizeResult> {
    return this.finalize(input);
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

      const parentBeforeCreate = await this.#readRevision(capability.repositoryRoot, "@");
      const addArgs = ["workspace", "add", "--name", workspaceName, "--revision", baseline.commitId, workspacePath];
      // Recent jj versions may register the workspace, then return a
      // non-zero status because the parent WC cannot be updated under
      // --ignore-working-copy. Accept that precise outcome only after proving
      // both the lane directory and workspace registration exist. If the lane
      // was left stale, the guarded recovery below retries only after a
      // no-snapshot parent cleanliness check.
      let addResult = await this.#run(addArgs, capability.repositoryRoot);
      if (addResult.exitCode !== 0) {
        const intentionalNoParentUpdate = /must be able to update the working copy|don't use --ignore-working-copy/i.test(addResult.stderr);
        const createdWithoutParentUpdate = await isDirectory(workspacePath) && await this.#isTracked(capability.repositoryRoot, workspaceName);
        if (!intentionalNoParentUpdate || !createdWithoutParentUpdate) this.#requireSuccess(addResult, addArgs, capability.repositoryRoot);

        // Some jj versions register a workspace under --ignore-working-copy
        // but cannot materialize it at the requested revision. Recover by
        // forgetting only that just-created workspace, prove the parent is
        // clean without snapshotting it, and retry the add in the lane
        // workspace mode. The normal retry updates only the new lane WC; the
        // parent revision is checked again after creation.
        const parentStatus = await this.#run(["status"], capability.repositoryRoot);
        if (parentStatus.exitCode !== 0) {
          await this.#forgetWorkspaceByName(capability.repositoryRoot, workspaceName).catch(() => undefined);
          await removeOwnedDirectory(workspacePath, root).catch(() => undefined);
          this.#requireSuccess(parentStatus, ["status"], capability.repositoryRoot);
        }
        if (!isCleanJjStatus(parentStatus.stdout)) {
          await this.#forgetWorkspaceByName(capability.repositoryRoot, workspaceName).catch(() => undefined);
          await removeOwnedDirectory(workspacePath, root).catch(() => undefined);
          throw new JjWorkspaceError("parent_dirty", "Parent working copy has changes; refusing a workspace retry that could snapshot it.");
        }
        await this.#forgetWorkspaceByName(capability.repositoryRoot, workspaceName);
        await removeOwnedDirectory(workspacePath, root);
        addResult = await this.#run(addArgs, capability.repositoryRoot, false);
        this.#requireSuccess(addResult, addArgs, capability.repositoryRoot, false);
      }
      const operationId = addResult.operationId ?? await this.#latestOperationId(capability.repositoryRoot);
      try {
        const revision = await this.#readRevision(workspacePath, "@");
        const parentAfterCreate = await this.#readRevision(capability.repositoryRoot, "@");
        if (!sameRevision(parentBeforeCreate, parentAfterCreate)) throw new JjWorkspaceError("parent_changed", "Lane workspace creation changed the parent working-copy revision.");
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

  /** Cleanup implementation used by finalize while its mutation lock is held. */
  async #cleanupOwnedWorkspace(manifest: JjWorkspaceManifest): Promise<void> {
    const manifestPath = manifestPathFor(manifest.workspaceRoot, manifest.workspaceName);
    let current = manifest;
    const inspection = current.state === "forgotten"
      ? { tracked: false }
      : await this.#inspectLoaded(current);
    if (inspection.tracked) {
      const forgetArgs = ["workspace", "forget", current.workspaceName];
      const forgotten = await this.#run(forgetArgs, current.repositoryRoot);
      this.#requireSuccess(forgotten, forgetArgs, current.repositoryRoot);
      current = {
        ...current,
        state: "forgotten",
        forgottenAt: current.forgottenAt ?? this.#now(),
        forgetOperationId: forgotten.operationId ?? await this.#latestOperationId(current.repositoryRoot),
        updatedAt: this.#now(),
      };
      await writeJsonAtomically(manifestPath, current);
    }
    await this.#assertSafeWorkspacePath(current.workspacePath, current.workspaceRoot);
    await removeOwnedDirectory(current.workspacePath, current.workspaceRoot);
    await removeOwnedManifest(manifestPath, current.workspaceRoot);
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
    if (!(await exists(rootManifestPath))) {
      const existingEntries = await readdir(root);
      // A concurrent process may publish ownership between the first lookup
      // and this listing. Recheck the marker before classifying the now
      // non-empty directory as foreign.
      if (existingEntries.length > 0 && !(await exists(rootManifestPath))) throw new JjWorkspaceError("workspace_root_unowned", `Workspace root ${JSON.stringify(root)} is non-empty and has no ownership marker.`);
      if (existingEntries.length === 0) await publishWorkspaceRootMarker(rootManifestPath, {
        version: JJ_WORKSPACE_MANIFEST_VERSION,
        backend: "jj",
        createdAt: this.#now(),
      });
    }
    await validateWorkspaceRootMarker(root, rootManifestPath);
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

  async #isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    const args = ["log", "-r", `${ancestor}::${descendant}`, "--no-graph", "-T", 'commit_id ++ "\\n"'];
    const result = await this.#run(args, cwd);
    if (result.exitCode !== 0) return false;
    // A successful non-empty range means the accepted head is reachable from
    // the observed workspace revision. Do not depend on template whitespace
    // or abbreviated-id rendering when deciding ancestry.
    return result.stdout.trim().length > 0;
  }

  async #findIntegrationRevision(repositoryRoot: string, expectedParents: readonly string[], created: JjCommandResult): Promise<{ revision: JjRevisionIdentity; conflict: boolean; conflictedPaths: string[] }> {
    // Be defensive for callers that supply lane heads directly: jj silently
    // deduplicates repeated parents, so verification must compare the same
    // canonical parent list that jj records.
    const canonicalExpectedParents = uniqueParentIds(expectedParents);
    const candidates: string[] = [];
    const createdText = `${created.stdout}\n${created.stderr}`;
    const createdMatch = /created new commit\s+\S+\s+([0-9a-f]{8,64})/i.exec(createdText);
    if (createdMatch?.[1]) candidates.push(createdMatch[1]);

    const inspectCandidate = async (candidate: string): Promise<{ revision: JjRevisionIdentity; conflict: boolean; conflictedPaths: string[] } | undefined> => {
      const details = await this.#readRevisionDetails(repositoryRoot, candidate).catch(() => undefined);
      if (!details || !sameStringArray(details.parents, canonicalExpectedParents)) return undefined;
      return { revision: { commitId: details.commitId, changeId: details.changeId }, conflict: details.conflict, conflictedPaths: details.conflictedPaths };
    };
    for (const candidate of candidates) {
      const found = await inspectCandidate(candidate);
      if (found) return found;
    }

    const args = ["log", "-r", "heads(all())", "--no-graph", "-T", FAN_IN_REVISION_TEMPLATE];
    const listed = await this.#run(args, repositoryRoot);
    this.#requireSuccess(listed, args, repositoryRoot);
    for (const line of listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const details = parseRevisionDetails(line);
      if (!details || !sameStringArray(details.parents, canonicalExpectedParents)) continue;
      return { revision: { commitId: details.commitId, changeId: details.changeId }, conflict: details.conflict, conflictedPaths: details.conflictedPaths };
    }
    throw new JjWorkspaceError("fan_in_revision_missing", "jj created no verifiable integration revision with the ordered lane heads as parents.");
  }

  async #readRevisionDetails(cwd: string, revset: string): Promise<RevisionDetails> {
    const args = ["log", "-r", revset, "--no-graph", "-T", FAN_IN_REVISION_TEMPLATE];
    const result = await this.#run(args, cwd);
    this.#requireSuccess(result, args, cwd);
    const line = result.stdout.trim().split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    const details = line ? parseRevisionDetails(line) : undefined;
    if (!details) throw new JjWorkspaceError("revision_missing", `jj did not return integration metadata for ${JSON.stringify(revset)}.`);
    return details;
  }

  async #readRevision(cwd: string, revset: string, ignoreWorkingCopy = true): Promise<JjRevisionIdentity> {
    const args = ["log", "-r", revset, "--no-graph", "-T", REVISION_TEMPLATE];
    const result = await this.#run(args, cwd, ignoreWorkingCopy);
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

  async #setBookmark(bookmarkName: string, revision: string, repositoryRoot: string): Promise<void> {
    const setArgs = ["bookmark", "set", bookmarkName, "--revision", revision];
    const set = await this.#run(setArgs, repositoryRoot);
    if (set.exitCode === 0) return;
    const createArgs = ["bookmark", "create", bookmarkName, "--revision", revision];
    const created = await this.#run(createArgs, repositoryRoot);
    if (created.exitCode === 0) return;
    const moveArgs = ["bookmark", "move", bookmarkName, "--to", revision];
    const moved = await this.#run(moveArgs, repositoryRoot);
    this.#requireSuccess(moved, moveArgs, repositoryRoot);
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

async function publishWorkspaceRootMarker(markerPath: string, marker: object): Promise<void> {
  // Publish a fully-written marker with one atomic hard-link operation. The
  // candidate lives beside the root, so concurrent initializers still observe
  // an empty unowned root and race on the same exclusive destination instead
  // of mistaking another process's temporary file for foreign contents.
  const root = path.dirname(markerPath);
  const candidate = path.join(path.dirname(root), `.${path.basename(root)}.ownership-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(candidate, markerPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      // Another process won. Its hard-linked candidate was also completely
      // written and synced before publication; validation happens below.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(candidate).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function validateWorkspaceRootMarker(root: string, markerPath: string): Promise<void> {
  const stat = await lstat(markerPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ownership marker ${JSON.stringify(markerPath)} is not a regular file.`);
  const raw = await readFile(markerPath, "utf8");
  let marker: unknown;
  try { marker = JSON.parse(raw); } catch { throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ownership marker ${JSON.stringify(markerPath)} is invalid.`); }
  if (!isRecord(marker) || marker.backend !== "jj" || marker.version !== JJ_WORKSPACE_MANIFEST_VERSION) throw new JjWorkspaceError("workspace_root_unsafe", `Workspace root ${JSON.stringify(root)} is owned by an incompatible backend.`);
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

interface RevisionDetails {
  commitId: string;
  changeId: string;
  parents: string[];
  conflict: boolean;
  conflictedPaths: string[];
}

function validateParallelFinalizeInput(input: JjParallelFinalizeInput): void {
  for (const [key, value] of Object.entries(input)) {
    if (["fanIn", "evaluationAccepted", "description"].includes(key) || value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new JjWorkspaceError("finalize_input_invalid", `Parallel finalization ${key} must be a non-empty string.`);
    }
  }
  if (!input.fanIn || typeof input.fanIn !== "object") throw new JjWorkspaceError("finalize_fan_in_invalid", "Parallel finalization requires durable fan-in provenance.");
  if (typeof input.evaluationAccepted !== "boolean") throw new JjWorkspaceError("finalize_evaluation_invalid", "Parallel finalization evaluationAccepted must be boolean.");
  if (!input.bookmarkName || input.bookmarkName.trim() !== input.bookmarkName || input.bookmarkName.includes("..") || input.bookmarkName.includes("@{") || [...input.bookmarkName].some((character) => character.trim().length === 0 || "~^:?*[]\\\\".includes(character))) {
    throw new JjWorkspaceError("finalize_bookmark_invalid", "Parallel finalization bookmarkName is not a valid jj bookmark name.");
  }
  if (input.fanIn.parentCastId !== input.parentCastId || input.fanIn.loopId !== input.loopId || input.fanIn.runId !== input.runId) {
    throw new JjWorkspaceError("finalize_identity_mismatch", "Parallel finalization identity does not match fan-in provenance.");
  }
  if (input.fanIn.version !== 1 || (input.fanIn.outcome !== "clean" && input.fanIn.outcome !== "conflict")) {
    throw new JjWorkspaceError("finalize_fan_in_invalid", "Parallel finalization fan-in provenance has an unsupported version or outcome.");
  }
  if (!isRevision(input.fanIn.baseline) || !isRevision(input.fanIn.parentRevisionBefore) || !isRevision(input.fanIn.parentRevisionAfter) || (input.fanIn.integrationRevision !== undefined && !isRevision(input.fanIn.integrationRevision))) {
    throw new JjWorkspaceError("finalize_fan_in_invalid", "Parallel finalization fan-in provenance has invalid parent or baseline revisions.");
  }
}

function validateFanInInput(input: JjFanInInput): void {
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || ["baseline", "queueOrder", "lanes", "now"].includes(key)) continue;
    if (typeof value !== "string" || value.trim().length === 0) throw new JjWorkspaceError("fan_in_input_invalid", `Fan-in ${key} must be a non-empty string.`);
  }
  if (!input.baseline || typeof input.baseline.commitId !== "string" || input.baseline.commitId.trim().length === 0 || typeof input.baseline.changeId !== "string" || input.baseline.changeId.trim().length === 0) {
    throw new JjWorkspaceError("fan_in_baseline_invalid", "Fan-in baseline must contain commitId and changeId.");
  }
  if (!Array.isArray(input.queueOrder) || input.queueOrder.length === 0) throw new JjWorkspaceError("fan_in_order_invalid", "Fan-in queueOrder must be non-empty.");
  if (!Array.isArray(input.lanes)) throw new JjWorkspaceError("fan_in_lanes_invalid", "Fan-in lanes must be an array.");
}

function orderFanInLanes(input: JjFanInInput): JjFanInLaneInput[] {
  const byId = new Map<string, JjFanInLaneInput>();
  for (const lane of input.lanes) {
    if (!lane || typeof lane.laneId !== "string" || lane.laneId.trim().length === 0 || byId.has(lane.laneId)) {
      throw new JjWorkspaceError("fan_in_order_invalid", "Fan-in lanes contain a missing or duplicate lane identity.");
    }
    byId.set(lane.laneId, lane);
  }
  const ordered: JjFanInLaneInput[] = [];
  const seen = new Set<string>();
  const streamIndexes = new Set<number>();
  for (const laneId of input.queueOrder) {
    if (typeof laneId !== "string" || laneId.trim().length === 0 || seen.has(laneId)) throw new JjWorkspaceError("fan_in_order_invalid", "Fan-in queueOrder contains a missing or duplicate lane identity.");
    const lane = byId.get(laneId);
    if (!lane) throw new JjWorkspaceError("fan_in_order_incomplete", `Fan-in queueOrder is missing lane ${JSON.stringify(laneId)}.`);
    seen.add(laneId);
    if (!Number.isSafeInteger(lane.streamIndex) || lane.streamIndex < 0 || streamIndexes.has(lane.streamIndex)) throw new JjWorkspaceError("fan_in_order_invalid", `Fan-in lane ${JSON.stringify(laneId)} has an invalid or duplicate stream index.`);
    streamIndexes.add(lane.streamIndex);
    if (lane.status !== "accepted") throw new JjWorkspaceError("fan_in_lane_not_accepted", `Fan-in lane ${JSON.stringify(laneId)} is ${JSON.stringify(lane.status)}; all lanes must be accepted.`);
    if (!lane.acceptedHead || !isRevision(lane.acceptedHead)) throw new JjWorkspaceError("fan_in_head_missing", `Fan-in lane ${JSON.stringify(laneId)} has no accepted head.`);
    if (!lane.workspace) throw new JjWorkspaceError("fan_in_workspace_missing", `Fan-in lane ${JSON.stringify(laneId)} has no workspace reference.`);
    ordered.push(lane);
  }
  if (seen.size !== byId.size) throw new JjWorkspaceError("fan_in_order_incomplete", "Fan-in queueOrder does not cover every lane.");
  return ordered;
}

function parseRevisionDetails(line: string): RevisionDetails | undefined {
  const [commitId, changeId, parentText = "", conflictText = "false", pathsText = ""] = line.split("\t");
  if (!commitId || !changeId) return undefined;
  return {
    commitId,
    changeId,
    parents: parentText ? parentText.split(",").filter(Boolean) : [],
    conflict: conflictText.trim().toLowerCase() === "true",
    conflictedPaths: pathsText ? pathsText.split("|").filter(Boolean).slice(0, 64).map((value) => boundedFanInText(value, 512)) : [],
  };
}

function boundedFanInText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** jj removes duplicate parents while preserving their first-seen order. */
function uniqueParentIds(parentIds: readonly string[]): string[] {
  const seen = new Set<string>();
  return parentIds.filter((parentId) => {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  });
}

function isRevision(value: unknown): value is JjRevisionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.commitId === "string" && record.commitId.trim().length > 0
    && typeof record.changeId === "string" && record.changeId.trim().length > 0;
}

function sameRevision(left: JjRevisionIdentity, right: JjRevisionIdentity): boolean {
  return left.commitId === right.commitId && left.changeId === right.changeId;
}

function isCleanJjStatus(stdout: string): boolean {
  const text = stdout.trim();
  if (text.length === 0 || /working copy (?:has no changes|is clean)/i.test(text) || /no changes/i.test(text)) return true;
  return !/working copy changes\s*:/i.test(text) && !/^\s*[madrcu!?]\s+\S+/im.test(text);
}

function workspaceOwnershipFromManifest(manifest: JjWorkspaceManifest): {
  backend: "jj";
  parentCastId: string;
  loopId: string;
  laneId: string;
  repositoryRoot: string;
  workspaceRoot: string;
  workspacePath: string;
  workspaceName: string;
  baseline: JjRevisionIdentity;
  revision: JjRevisionIdentity;
  operationId: string;
  manifestPath?: string;
  state: JjWorkspaceLifecycleState;
} {
  return {
    backend: "jj",
    ...manifest.owner,
    repositoryRoot: manifest.repositoryRoot,
    workspaceRoot: manifest.workspaceRoot,
    workspacePath: manifest.workspacePath,
    workspaceName: manifest.workspaceName,
    baseline: { ...manifest.baseline },
    revision: { ...manifest.revision },
    operationId: manifest.operationId,
    manifestPath: manifestPathFor(manifest.workspaceRoot, manifest.workspaceName),
    state: manifest.state,
  };
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

