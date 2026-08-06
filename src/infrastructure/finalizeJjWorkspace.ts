import { execFile } from "node:child_process";
import path from "node:path";
import { createExecutionScope, type ExecutionScope, type ExecutionScopeExport } from "../domain/executionScope.js";
import {
  createJjWorkspaceBackend,
  type JjRemovableWorkflowBoundary,
  type JjRevisionIdentity,
  type JjWorkspaceBackend,
  type JjWorkspaceOwner,
} from "./jjWorkspaceBackend.js";
import { INTEGRATE_JJ_WORKSPACES_PRODUCER } from "./integrateJjWorkspaces.js";
import { JJ_WORKSPACE_CLEANUP_EXPORT, JJ_WORKSPACE_INTEGRATION_EXPORT } from "./spawnJjWorkspace.js";

export const FINALIZE_JJ_WORKSPACE_PRODUCER = "Finalize-JJ-Workspace";
const REVISION_TEMPLATE = 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ conflict ++ "\\t" ++ empty ++ "\\n"';

interface OwnedWorkspaceExport {
  owner: JjWorkspaceOwner;
  workspaceRoot: string;
  workspacePath: string;
  workspaceName: string;
  manifestPath: string;
}

interface IntegrationExport extends OwnedWorkspaceExport {
  repositoryRoot: string;
  integrationRevision: JjRevisionIdentity;
  effectiveBase: JjRevisionIdentity;
  finalTip: JjRevisionIdentity;
  orderedChangeIds: string[];
  provenanceTruncated: boolean;
  removableWorkflowBoundary?: JjRemovableWorkflowBoundary;
}

interface RevisionDetails extends JjRevisionIdentity {
  parents: string[];
  conflict: boolean;
  empty: boolean;
}

export interface FinalizeJjWorkspaceInput {
  cwd: string;
  executionScope: ExecutionScope;
  baseScope: ExecutionScope;
  state: unknown;
  bookmarkName: string;
  description?: string;
}

export interface FinalizeJjWorkspaceDeps {
  createBackend?: (workspaceRoot: string, repositoryRoot: string) => Pick<JjWorkspaceBackend, "inspect" | "cleanup">;
  runJj?: (args: readonly string[], cwd: string, ignoreWorkingCopy?: boolean) => Promise<string>;
}

export interface FinalizeJjWorkspaceResult {
  scope: ExecutionScope;
  integrationRevision: JjRevisionIdentity;
  baseWorkingRevision: JjRevisionIdentity;
  bookmarkName: string;
  cleanedWorkspaceNames: string[];
  description?: string;
  reviewCorrection: boolean;
  orderedChangeIds: string[];
}

/** Publish an agent-accepted review as one verified, meaningful linear history. */
export async function finalizeJjWorkspace(
  input: FinalizeJjWorkspaceInput,
  deps: FinalizeJjWorkspaceDeps = {},
): Promise<FinalizeJjWorkspaceResult> {
  assertInput(input);
  if (!agentAccepted(input.state)) throw new Error("Finalize-JJ-Workspace requires explicit agent acceptance in state.envelope.satisfied.");

  const integration = parseIntegration(input.executionScope.exports[JJ_WORKSPACE_INTEGRATION_EXPORT]);
  const cleanup = parseCleanup(input.executionScope.exports[JJ_WORKSPACE_CLEANUP_EXPORT]);
  if (integration.provenanceTruncated) throw new Error("Finalize-JJ-Workspace cannot verify truncated linearization provenance.");
  if (path.resolve(input.cwd) !== path.resolve(integration.workspacePath)) throw new Error("Finalize-JJ-Workspace active scope does not match the owned integration workspace.");
  if (path.resolve(input.baseScope.cwd) !== path.resolve(integration.repositoryRoot)) throw new Error("Finalize-JJ-Workspace base scope does not match the integration repository.");

  const backend = (deps.createBackend ?? ((workspaceRoot, repositoryRoot) => createJjWorkspaceBackend({ workspaceRoot, repositoryRoot })))(integration.workspaceRoot, integration.repositoryRoot);
  if (!sameOwnedWorkspace(integration, cleanup.integration)) {
    throw new Error("Finalize-JJ-Workspace integration cleanup ownership does not match the integration export.");
  }
  const owned = [cleanup.integration, ...cleanup.sources];
  const byPath = new Map<string, OwnedWorkspaceExport>();
  for (const workspace of owned) {
    const key = path.resolve(workspace.workspacePath);
    const duplicate = byPath.get(key);
    if (duplicate && !sameOwnedWorkspace(duplicate, workspace)) {
      throw new Error(`Finalize-JJ-Workspace duplicate cleanup ownership mismatches for ${JSON.stringify(workspace.workspaceName)}.`);
    }
    if (!duplicate) byPath.set(key, workspace);
  }
  const verified = [...byPath.values()];
  const pendingCleanup: OwnedWorkspaceExport[] = [];
  for (const workspace of verified) {
    const key = path.resolve(workspace.workspacePath);
    const inspected = await backend.inspect(workspace);
    // No manifest is acceptable only as a completed cleanup. The real backend
    // additionally proves that neither a jj registration nor path residue is
    // present before returning undefined.
    if (!inspected) continue;
    if (inspected.owner.parentCastId !== workspace.owner.parentCastId
      || inspected.owner.loopId !== workspace.owner.loopId
      || inspected.owner.laneId !== workspace.owner.laneId
      || path.resolve(inspected.repositoryRoot) !== path.resolve(integration.repositoryRoot)
      || path.resolve(inspected.workspaceRoot) !== path.resolve(workspace.workspaceRoot)
      || path.resolve(inspected.workspacePath) !== key
      || inspected.workspaceName !== workspace.workspaceName
      || inspected.manifestPath !== workspace.manifestPath) {
      throw new Error(`Finalize-JJ-Workspace ownership verification failed for ${JSON.stringify(workspace.workspaceName)}.`);
    }
    pendingCleanup.push(workspace);
  }

  const runJj = deps.runJj ?? runJjCommand;
  // A normal command snapshots review edits and conflict resolutions before
  // stable change ids are resolved to their current rewritten commits.
  const effectiveBase = await readRevision(runJj, integration.effectiveBase.changeId, integration.repositoryRoot);
  if (effectiveBase.changeId !== integration.effectiveBase.changeId) throw new Error("Finalize-JJ-Workspace effective base drifted before publication.");

  const expected: RevisionDetails[] = [];
  let previous = effectiveBase;
  for (const changeId of integration.orderedChangeIds) {
    const revision = await readRevision(runJj, changeId, integration.repositoryRoot);
    if (revision.changeId !== changeId || revision.parents.length !== 1 || revision.parents[0] !== previous.commitId || revision.empty) {
      throw new Error("Finalize-JJ-Workspace expected changes are no longer one meaningful linear chain in schedule order.");
    }
    expected.push(revision);
    previous = revision;
  }
  if (previous.changeId !== integration.finalTip.changeId || integration.integrationRevision.changeId !== integration.finalTip.changeId) {
    throw new Error("Finalize-JJ-Workspace final stable change no longer matches the exported linearization.");
  }
  if (effectiveBase.conflict || expected.some(({ conflict }) => conflict)) {
    throw new Error("Finalize-JJ-Workspace cannot publish an integration with unresolved conflicts in its linear ancestry.");
  }

  // An all-no-op fan-in retains the cast's empty workflow boundary as its
  // final tip. It is valid review provenance, but must never become published
  // history: publish its meaningful parent instead.
  let meaningfulTip = previous;
  if (integration.orderedChangeIds.length === 0 && meaningfulTip.empty) {
    if (meaningfulTip.parents.length !== 1) throw new Error("Finalize-JJ-Workspace all-no-op integration has no meaningful parent to publish.");
    meaningfulTip = await readRevision(runJj, meaningfulTip.parents[0]!, integration.repositoryRoot);
    if (meaningfulTip.empty || meaningfulTip.conflict) throw new Error("Finalize-JJ-Workspace all-no-op integration has no conflict-free meaningful parent to publish.");
  } else if (meaningfulTip.empty) {
    throw new Error("Finalize-JJ-Workspace cannot publish an empty integration tip.");
  }

  // Publication precedes cleanup. If an earlier attempt stopped during
  // cleanup, recognize its verified bookmark/base-working shape and resume
  // cleanup without snapshotting review state or creating another empty base.
  const recovered = await readPublishedRetry(runJj, input, meaningfulTip);
  if (recovered) {
    for (const workspace of pendingCleanup) await backend.cleanup(workspace);
    await retireWorkflowBoundary(runJj, integration.removableWorkflowBoundary, recovered.published, recovered.baseWorking, integration.repositoryRoot);
    return finalizeResult(input, integration, verified, recovered.published, recovered.baseWorking, recovered.reviewCorrection);
  }

  const reviewWorking = await readRevision(runJj, "@", input.cwd, false);
  // The review prompt asks the agent to return to the rewritten final tip
  // after resolving stable changes. `jj edit <final-change>` therefore leaves
  // the workspace at that tip, while an untouched review (or a correction)
  // normally leaves its empty/meaningful working child there. Accept both
  // valid shapes; rejecting the former strands a fully resolved integration
  // before publication.
  const reviewAtFinalTip = reviewWorking.changeId === meaningfulTip.changeId;
  const reviewDirectlyAfterTip = reviewWorking.parents.length === 1 && reviewWorking.parents[0] === previous.commitId;
  if (!reviewAtFinalTip && !reviewDirectlyAfterTip) {
    throw new Error("Finalize-JJ-Workspace review workspace is not positioned directly after the rewritten final tip.");
  }
  if (reviewWorking.conflict) {
    throw new Error("Finalize-JJ-Workspace cannot publish an integration with unresolved conflicts in its linear ancestry.");
  }
  // Reading `@` with the working copy enabled may snapshot a last reviewer
  // edit and rewrite the stable final change id's commit id. Publish that
  // current revision rather than the pre-snapshot commit identity.
  if (reviewAtFinalTip) meaningfulTip = { ...reviewWorking };

  const baseStatus = await runJj(["status"], input.baseScope.cwd, false);
  if (!isCleanStatus(baseStatus)) throw new Error("Finalize-JJ-Workspace base working copy is dirty; all workspaces were preserved.");

  const conflictedAncestry = await runJj(["log", "-r", `ancestors(${meaningfulTip.commitId}) & conflicts()`, "--no-graph", "-T", 'commit_id ++ "\\n"'], integration.repositoryRoot);
  if (conflictedAncestry.trim()) throw new Error("Finalize-JJ-Workspace cannot publish a revision with conflicted ancestors.");

  let published: JjRevisionIdentity = revisionIdentity(meaningfulTip);
  let description: string | undefined;
  const reviewCorrection = !reviewAtFinalTip && !reviewWorking.empty;
  if (reviewCorrection) {
    if (reviewWorking.parents[0] !== meaningfulTip.commitId) {
      await runJj(["rebase", "-r", reviewWorking.changeId, "-d", meaningfulTip.commitId], integration.repositoryRoot);
    }
    description = input.description?.trim() || "fix: reconcile integrated workstreams";
    await runJj(["describe", "-r", reviewWorking.changeId, "-m", description], integration.repositoryRoot);
    const described = await readRevision(runJj, reviewWorking.changeId, integration.repositoryRoot);
    if (described.changeId !== reviewWorking.changeId || described.parents.length !== 1 || described.parents[0] !== meaningfulTip.commitId || described.empty || described.conflict) {
      throw new Error("Finalize-JJ-Workspace could not verify the meaningful integration-fix commit.");
    }
    published = revisionIdentity(described);
  }

  await moveExistingBookmark(runJj, input.bookmarkName, published.commitId, integration.repositoryRoot);
  const bookmarked = revisionIdentity(await readRevision(runJj, input.bookmarkName, integration.repositoryRoot));
  if (!sameRevision(bookmarked, published)) throw new Error("Finalize-JJ-Workspace bookmark publication could not be verified.");

  await runJj(["new", published.commitId], input.baseScope.cwd, false);
  const baseWorking = await readRevision(runJj, "@", input.baseScope.cwd, false);
  if (!baseWorking.empty || baseWorking.conflict || baseWorking.parents.length !== 1 || baseWorking.parents[0] !== published.commitId) {
    throw new Error("Finalize-JJ-Workspace did not create a verified empty base working commit.");
  }

  for (const workspace of pendingCleanup) await backend.cleanup(workspace);
  await retireWorkflowBoundary(runJj, integration.removableWorkflowBoundary, published, baseWorking, integration.repositoryRoot);
  return finalizeResult(input, integration, verified, published, baseWorking, reviewCorrection, description);
}

async function retireWorkflowBoundary(
  run: NonNullable<FinalizeJjWorkspaceDeps["runJj"]>,
  boundary: JjRemovableWorkflowBoundary | undefined,
  published: JjRevisionIdentity,
  baseWorking: RevisionDetails,
  cwd: string,
): Promise<void> {
  if (!boundary) return;
  if (!baseWorking.empty || baseWorking.conflict || baseWorking.parents.length !== 1 || baseWorking.parents[0] !== published.commitId) {
    throw new Error("Finalize-JJ-Workspace cannot retire the workflow boundary without preserving the verified empty base working commit.");
  }

  // Re-read the recorded revision immediately before abandonment. The
  // revision identity and its single effective-base parent are the complete
  // authority for this narrow cleanup; never replace it with a broad revset.
  const candidate = await readRevision(run, boundary.commitId, cwd);
  if (!sameRevision(candidate, boundary)
    || !candidate.empty
    || candidate.conflict
    || candidate.parents.length !== 1
    || candidate.parents[0] !== boundary.expectedParent.commitId) {
    throw new Error("Finalize-JJ-Workspace recorded workflow boundary no longer matches the verified empty single-parent candidate.");
  }
  const candidateParent = await readRevision(run, candidate.parents[0], cwd);
  if (!sameRevision(candidateParent, boundary.expectedParent)) {
    throw new Error("Finalize-JJ-Workspace recorded workflow boundary parent drifted before retirement.");
  }

  await run(["abandon", boundary.commitId], cwd);
  const preservedBaseWorking = await readRevision(run, "@", cwd, false);
  if (!sameRevision(preservedBaseWorking, baseWorking)
    || preservedBaseWorking.empty !== baseWorking.empty
    || preservedBaseWorking.conflict !== baseWorking.conflict
    || preservedBaseWorking.parents.length !== 1
    || preservedBaseWorking.parents[0] !== published.commitId) {
    throw new Error("Finalize-JJ-Workspace workflow-boundary retirement did not preserve the empty base working commit.");
  }
}

async function readPublishedRetry(
  run: NonNullable<FinalizeJjWorkspaceDeps["runJj"]>,
  input: FinalizeJjWorkspaceInput,
  meaningfulTip: RevisionDetails,
): Promise<{ published: JjRevisionIdentity; baseWorking: RevisionDetails; reviewCorrection: boolean } | undefined> {
  try {
    const published = await readRevision(run, input.bookmarkName, input.baseScope.cwd);
    const baseWorking = await readRevision(run, "@", input.baseScope.cwd, false);
    if (published.empty || published.conflict || !baseWorking.empty || baseWorking.conflict
      || baseWorking.parents.length !== 1 || baseWorking.parents[0] !== published.commitId) return undefined;
    const unchanged = sameRevision(published, meaningfulTip);
    const corrected = published.parents.length === 1 && published.parents[0] === meaningfulTip.commitId;
    if (!unchanged && !corrected) return undefined;
    const conflicts = await run(["log", "-r", `ancestors(${published.commitId}) & conflicts()`, "--no-graph", "-T", 'commit_id ++ "\\n"'], input.baseScope.cwd);
    if (conflicts.trim()) return undefined;
    return { published: revisionIdentity(published), baseWorking, reviewCorrection: corrected };
  } catch {
    return undefined;
  }
}

function finalizeResult(
  input: FinalizeJjWorkspaceInput,
  integration: IntegrationExport,
  completeCleanupSet: readonly OwnedWorkspaceExport[],
  published: JjRevisionIdentity,
  baseWorking: RevisionDetails,
  reviewCorrection: boolean,
  description?: string,
): FinalizeJjWorkspaceResult {
  return {
    scope: createExecutionScope(input.baseScope),
    integrationRevision: revisionIdentity(published),
    baseWorkingRevision: revisionIdentity(baseWorking),
    bookmarkName: input.bookmarkName,
    cleanedWorkspaceNames: completeCleanupSet.map(({ workspaceName }) => workspaceName),
    ...(description ? { description } : {}),
    reviewCorrection,
    orderedChangeIds: [...integration.orderedChangeIds],
  };
}

async function moveExistingBookmark(run: NonNullable<FinalizeJjWorkspaceDeps["runJj"]>, name: string, revision: string, cwd: string): Promise<void> {
  await readRevision(run, name, cwd);
  try {
    // Linearization may deliberately remove the bookmark's empty workflow
    // boundary, making the meaningful tip a sibling rather than a descendant.
    await run(["bookmark", "move", "--allow-backwards", name, "--to", revision], cwd);
  } catch (error) {
    throw new Error(`Finalize-JJ-Workspace could not advance original bookmark ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseIntegration(value: ExecutionScopeExport | undefined): IntegrationExport {
  if (!value || value.producer !== INTEGRATE_JJ_WORKSPACES_PRODUCER || !isRecord(value.value)) throw new Error("Finalize-JJ-Workspace requires a trusted integration export.");
  const raw = value.value;
  const workspace = parseOwned(raw, "integration");
  if (typeof raw.repositoryRoot !== "string" || !isRevision(raw.integrationRevision) || !isRevision(raw.effectiveBase) || !isRevision(raw.finalTip)
    || !Array.isArray(raw.orderedChangeIds) || !raw.orderedChangeIds.every(isChangeId) || typeof raw.provenanceTruncated !== "boolean") {
    throw new Error("Finalize-JJ-Workspace integration export is malformed.");
  }
  if (new Set(raw.orderedChangeIds).size !== raw.orderedChangeIds.length) throw new Error("Finalize-JJ-Workspace integration change order contains duplicate stable identities.");
  const removableWorkflowBoundary = raw.removableWorkflowBoundary === undefined
    ? undefined
    : parseRemovableWorkflowBoundary(raw.removableWorkflowBoundary, raw.effectiveBase, raw.orderedChangeIds);
  return {
    ...workspace,
    repositoryRoot: raw.repositoryRoot,
    integrationRevision: { ...raw.integrationRevision },
    effectiveBase: { ...raw.effectiveBase },
    finalTip: { ...raw.finalTip },
    orderedChangeIds: [...raw.orderedChangeIds],
    provenanceTruncated: raw.provenanceTruncated,
    ...(removableWorkflowBoundary ? { removableWorkflowBoundary } : {}),
  };
}

function parseRemovableWorkflowBoundary(
  value: unknown,
  effectiveBase: unknown,
  orderedChangeIds: readonly string[],
): JjRemovableWorkflowBoundary {
  if (!isRemovableWorkflowBoundary(value)
    || orderedChangeIds.length === 0
    || !isBoundedRevision(effectiveBase)
    || !sameRevision(value.expectedParent, effectiveBase)
    || orderedChangeIds.includes(value.changeId)) {
    throw new Error("Finalize-JJ-Workspace integration export has malformed or inconsistent removable workflow-boundary provenance.");
  }
  return {
    commitId: value.commitId,
    changeId: value.changeId,
    expectedParent: { ...value.expectedParent },
  };
}

function parseCleanup(value: ExecutionScopeExport | undefined): { integration: OwnedWorkspaceExport; sources: OwnedWorkspaceExport[] } {
  if (!value || value.producer !== INTEGRATE_JJ_WORKSPACES_PRODUCER || !isRecord(value.value) || !isRecord(value.value.integration) || !Array.isArray(value.value.sources)) throw new Error("Finalize-JJ-Workspace requires a trusted cleanup export.");
  return { integration: parseOwned(value.value.integration, "integration cleanup"), sources: value.value.sources.map((entry, index) => parseOwned(entry, `source cleanup ${index}`)) };
}

function sameOwnedWorkspace(left: OwnedWorkspaceExport, right: OwnedWorkspaceExport): boolean {
  return left.owner.parentCastId === right.owner.parentCastId
    && left.owner.loopId === right.owner.loopId
    && left.owner.laneId === right.owner.laneId
    && path.resolve(left.workspaceRoot) === path.resolve(right.workspaceRoot)
    && path.resolve(left.workspacePath) === path.resolve(right.workspacePath)
    && left.workspaceName === right.workspaceName
    && path.resolve(left.manifestPath) === path.resolve(right.manifestPath);
}

function parseOwned(value: unknown, label: string): OwnedWorkspaceExport {
  if (!isRecord(value) || !isOwner(value.owner)) throw new Error(`Finalize-JJ-Workspace ${label} ownership is malformed.`);
  for (const key of ["workspaceRoot", "workspacePath", "workspaceName", "manifestPath"] as const) if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Finalize-JJ-Workspace ${label} is incomplete.`);
  return { owner: { ...value.owner }, workspaceRoot: value.workspaceRoot, workspacePath: value.workspacePath, workspaceName: value.workspaceName, manifestPath: value.manifestPath };
}

async function readRevision(run: NonNullable<FinalizeJjWorkspaceDeps["runJj"]>, revset: string, cwd: string, ignoreWorkingCopy = true): Promise<RevisionDetails> {
  const output = await run(["log", "-r", revset, "--no-graph", "-T", REVISION_TEMPLATE], cwd, ignoreWorkingCopy);
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`Finalize-JJ-Workspace could not resolve one current revision for ${JSON.stringify(revset)}.`);
  const [commitId, changeId, parents = "", conflict = "false", empty = "false"] = lines[0]!.split("\t");
  if (!commitId || !changeId) throw new Error("Finalize-JJ-Workspace could not read a jj revision identity.");
  return { commitId, changeId, parents: parents ? parents.split(",") : [], conflict: conflict.toLowerCase() === "true", empty: empty.toLowerCase() === "true" };
}

function agentAccepted(state: unknown): boolean { return isRecord(state) && isRecord(state.envelope) && state.envelope.satisfied === true; }
function isOwner(value: unknown): value is JjWorkspaceOwner { return isRecord(value) && [value.parentCastId, value.loopId, value.laneId].every((part) => typeof part === "string" && part.trim()); }
function isRevision(value: unknown): value is JjRevisionIdentity { return isRecord(value) && isChangeId(value.commitId) && isChangeId(value.changeId); }
function isBoundedRevision(value: unknown): value is JjRevisionIdentity { return isRevision(value) && value.commitId.length <= 512 && value.changeId.length <= 512; }
function isRemovableWorkflowBoundary(value: unknown): value is JjRemovableWorkflowBoundary {
  return isRecord(value)
    && isBoundedRevisionFields(value.commitId, value.changeId)
    && isBoundedRevision(value.expectedParent);
}
function isChangeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9]+$/.test(value); }
function isBoundedRevisionFields(commitId: unknown, changeId: unknown): boolean {
  return isChangeId(commitId) && commitId.length <= 512 && isChangeId(changeId) && changeId.length <= 512;
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function revisionIdentity(value: JjRevisionIdentity): JjRevisionIdentity { return { commitId: value.commitId, changeId: value.changeId }; }
function sameRevision(a: JjRevisionIdentity, b: JjRevisionIdentity): boolean { return a.commitId === b.commitId && a.changeId === b.changeId; }
function isCleanStatus(value: string): boolean { const text = value.trim(); return !text || /working copy (?:has no changes|is clean)/i.test(text); }

function assertInput(input: FinalizeJjWorkspaceInput): void {
  for (const [name, value] of [["cwd", input.cwd], ["bookmarkName", input.bookmarkName], ["executionScope.id", input.executionScope?.id], ["baseScope.id", input.baseScope?.id]] as const) if (typeof value !== "string" || !value.trim()) throw new Error(`Finalize-JJ-Workspace ${name} must be a non-empty string.`);
  if (input.bookmarkName.includes("..") || /[\s~^:?*\[\]\\]/.test(input.bookmarkName)) throw new Error("Finalize-JJ-Workspace bookmarkName is invalid.");
}

function runJjCommand(args: readonly string[], cwd: string, ignoreWorkingCopy = true): Promise<string> {
  const commandArgs = ignoreWorkingCopy ? ["--ignore-working-copy", ...args] : [...args];
  return new Promise((resolve, reject) => execFile("jj", commandArgs, { cwd, shell: false, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`jj ${args.join(" ")} failed: ${String(stderr || stdout).trim() || error.message}`));
    else resolve(String(stdout ?? ""));
  }));
}
