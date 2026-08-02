import { execFile } from "node:child_process";
import path from "node:path";
import { createExecutionScope, type ExecutionScope, type ExecutionScopeExport } from "../domain/executionScope.js";
import { createJjWorkspaceBackend, type JjRevisionIdentity, type JjWorkspaceBackend, type JjWorkspaceOwner } from "./jjWorkspaceBackend.js";
import { INTEGRATE_JJ_WORKSPACES_PRODUCER } from "./integrateJjWorkspaces.js";
import { JJ_WORKSPACE_CLEANUP_EXPORT, JJ_WORKSPACE_INTEGRATION_EXPORT } from "./spawnJjWorkspace.js";

export const FINALIZE_JJ_WORKSPACE_PRODUCER = "Finalize-JJ-Workspace";

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
  description: string;
}

/** Finalize only an agent-accepted integration scope and then return to base. */
export async function finalizeJjWorkspace(
  input: FinalizeJjWorkspaceInput,
  deps: FinalizeJjWorkspaceDeps = {},
): Promise<FinalizeJjWorkspaceResult> {
  assertInput(input);
  if (!agentAccepted(input.state)) {
    throw new Error("Finalize-JJ-Workspace requires explicit agent acceptance in state.envelope.satisfied.");
  }

  const integration = parseIntegration(input.executionScope.exports[JJ_WORKSPACE_INTEGRATION_EXPORT]);
  const cleanup = parseCleanup(input.executionScope.exports[JJ_WORKSPACE_CLEANUP_EXPORT]);
  if (path.resolve(input.cwd) !== path.resolve(integration.workspacePath)) {
    throw new Error("Finalize-JJ-Workspace active scope does not match the owned integration workspace.");
  }
  if (path.resolve(input.baseScope.cwd) !== path.resolve(integration.repositoryRoot)) {
    throw new Error("Finalize-JJ-Workspace base scope does not match the integration repository.");
  }

  const backend = (deps.createBackend ?? ((workspaceRoot, repositoryRoot) => createJjWorkspaceBackend({ workspaceRoot, repositoryRoot })))(integration.workspaceRoot, integration.repositoryRoot);
  const owned = [cleanup.integration, ...cleanup.sources];
  const seen = new Set<string>();
  const verified: OwnedWorkspaceExport[] = [];
  for (const workspace of owned) {
    const key = path.resolve(workspace.workspacePath);
    if (seen.has(key)) continue;
    seen.add(key);
    const inspected = await backend.inspect(workspace);
    if (!inspected || !inspected.exists || !inspected.tracked
      || inspected.owner.parentCastId !== workspace.owner.parentCastId
      || inspected.owner.loopId !== workspace.owner.loopId
      || inspected.owner.laneId !== workspace.owner.laneId
      || path.resolve(inspected.repositoryRoot) !== path.resolve(integration.repositoryRoot)
      || path.resolve(inspected.workspaceRoot) !== path.resolve(workspace.workspaceRoot)
      || path.resolve(inspected.workspacePath) !== key
      || inspected.workspaceName !== workspace.workspaceName
      || inspected.manifestPath !== workspace.manifestPath) {
      throw new Error(`Finalize-JJ-Workspace ownership verification failed for ${JSON.stringify(workspace.workspaceName)}.`);
    }
    verified.push(workspace);
  }

  const runJj = deps.runJj ?? runJjCommand;
  // Do not inspect `@` through --ignore-working-copy here. The integration
  // agent may have edited files or resolved conflicts since the workspace was
  // materialized; a normal jj command snapshots those accepted filesystem
  // changes before we select the revision that will be published and cleaned.
  const accepted = parseRevision(await runJj(["log", "-r", "@", "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ conflict ++ "\\n"'], input.cwd, false));
  if (accepted.conflict) throw new Error("Finalize-JJ-Workspace cannot publish an integration with unresolved conflicts.");
  const exportedIntegration = revisionIdentity(parseRevision(await runJj(["log", "-r", integration.integrationRevision.commitId, "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id ++ "\\n"'], integration.repositoryRoot)));
  if (!sameRevision(exportedIntegration, integration.integrationRevision)) throw new Error("Finalize-JJ-Workspace integration revision drifted before acceptance.");
  const ancestry = await runJj(["log", "-r", `${integration.integrationRevision.commitId}::${accepted.commitId}`, "--no-graph", "-T", 'commit_id ++ "\\n"'], integration.repositoryRoot);
  if (!ancestry.split(/\s+/).includes(accepted.commitId)) throw new Error("Finalize-JJ-Workspace accepted revision does not descend from the exported integration.");
  const baseStatus = await runJj(["status"], input.baseScope.cwd, false);
  if (!isCleanStatus(baseStatus)) throw new Error("Finalize-JJ-Workspace base working copy is dirty; all workspaces were preserved.");

  const description = input.description?.trim() || "materia: finalize accepted workspace integration";
  await runJj(["describe", "-r", accepted.commitId, "-m", description], integration.repositoryRoot);
  const describedResult = parseRevision(await runJj(["log", "-r", accepted.changeId, "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id ++ "\\n"'], integration.repositoryRoot));
  const described = revisionIdentity(describedResult);
  if (described.changeId !== accepted.changeId) throw new Error("Finalize-JJ-Workspace could not verify the described accepted revision.");

  await setBookmark(runJj, input.bookmarkName, described.commitId, integration.repositoryRoot);
  const published = revisionIdentity(parseRevision(await runJj(["log", "-r", input.bookmarkName, "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id ++ "\\n"'], integration.repositoryRoot)));
  if (!sameRevision(published, described)) throw new Error("Finalize-JJ-Workspace bookmark publication could not be verified.");

  await runJj(["new", described.commitId], input.baseScope.cwd, false);
  const baseWorkingRevision = revisionIdentity(parseRevision(await runJj(["log", "-r", "@", "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id ++ "\\n"'], input.baseScope.cwd, false)));
  const empty = (await runJj(["log", "-r", "@", "--no-graph", "-T", "empty"], input.baseScope.cwd, false)).trim().toLowerCase();
  const parent = revisionIdentity(parseRevision(await runJj(["log", "-r", "@-", "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id ++ "\\n"'], input.baseScope.cwd, false)));
  if (empty !== "true" || !sameRevision(parent, described)) {
    throw new Error("Finalize-JJ-Workspace did not create a verified empty base working commit.");
  }

  for (const workspace of verified) await backend.cleanup(workspace);
  return {
    scope: createExecutionScope(input.baseScope),
    integrationRevision: described,
    baseWorkingRevision,
    bookmarkName: input.bookmarkName,
    cleanedWorkspaceNames: verified.map(({ workspaceName }) => workspaceName),
    description,
  };
}

async function setBookmark(run: NonNullable<FinalizeJjWorkspaceDeps["runJj"]>, name: string, revision: string, cwd: string): Promise<void> {
  for (const args of [["bookmark", "set", name, "--revision", revision], ["bookmark", "create", name, "--revision", revision], ["bookmark", "move", name, "--to", revision]] as const) {
    try { await run(args, cwd); return; } catch { /* try the next supported jj spelling */ }
  }
  throw new Error(`Finalize-JJ-Workspace could not publish bookmark ${JSON.stringify(name)}.`);
}

function parseIntegration(value: ExecutionScopeExport | undefined): IntegrationExport {
  if (!value || value.producer !== INTEGRATE_JJ_WORKSPACES_PRODUCER || !isRecord(value.value)) throw new Error("Finalize-JJ-Workspace requires a trusted integration export.");
  const workspace = parseOwned(value.value, "integration");
  if (typeof value.value.repositoryRoot !== "string" || !isRevision(value.value.integrationRevision)) throw new Error("Finalize-JJ-Workspace integration export is malformed.");
  return { ...workspace, repositoryRoot: value.value.repositoryRoot, integrationRevision: { ...value.value.integrationRevision } };
}

function parseCleanup(value: ExecutionScopeExport | undefined): { integration: OwnedWorkspaceExport; sources: OwnedWorkspaceExport[] } {
  if (!value || value.producer !== INTEGRATE_JJ_WORKSPACES_PRODUCER || !isRecord(value.value) || !isRecord(value.value.integration) || !Array.isArray(value.value.sources)) {
    throw new Error("Finalize-JJ-Workspace requires a trusted cleanup export.");
  }
  return { integration: parseOwned(value.value.integration, "integration cleanup"), sources: value.value.sources.map((entry, index) => parseOwned(entry, `source cleanup ${index}`)) };
}

function parseOwned(value: unknown, label: string): OwnedWorkspaceExport {
  if (!isRecord(value) || !isOwner(value.owner)) throw new Error(`Finalize-JJ-Workspace ${label} ownership is malformed.`);
  for (const key of ["workspaceRoot", "workspacePath", "workspaceName", "manifestPath"] as const) if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Finalize-JJ-Workspace ${label} is incomplete.`);
  return { owner: { ...value.owner }, workspaceRoot: value.workspaceRoot, workspacePath: value.workspacePath, workspaceName: value.workspaceName, manifestPath: value.manifestPath };
}

function agentAccepted(state: unknown): boolean { return isRecord(state) && isRecord(state.envelope) && state.envelope.satisfied === true; }
function isOwner(value: unknown): value is JjWorkspaceOwner { return isRecord(value) && [value.parentCastId, value.loopId, value.laneId].every((part) => typeof part === "string" && part.trim()); }
function isRevision(value: unknown): value is JjRevisionIdentity { return isRecord(value) && typeof value.commitId === "string" && /^[A-Za-z0-9]+$/.test(value.commitId) && typeof value.changeId === "string" && /^[A-Za-z0-9]+$/.test(value.changeId); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function revisionIdentity(value: JjRevisionIdentity): JjRevisionIdentity { return { commitId: value.commitId, changeId: value.changeId }; }
function sameRevision(a: JjRevisionIdentity, b: JjRevisionIdentity): boolean { return a.commitId === b.commitId && a.changeId === b.changeId; }
function isCleanStatus(value: string): boolean { const text = value.trim(); return !text || /working copy (?:has no changes|is clean)/i.test(text); }

function parseRevision(output: string): JjRevisionIdentity & { conflict: boolean } {
  const [commitId, changeId, conflict = "false"] = output.trim().split(/\s+/);
  if (!commitId || !changeId) throw new Error("Finalize-JJ-Workspace could not read a jj revision identity.");
  return { commitId, changeId, conflict: conflict.toLowerCase() === "true" };
}

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
