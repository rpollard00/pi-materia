import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import {
  createJjWorkspaceBackend,
  type JjWorkspaceBackend,
  type JjWorkspaceRecord,
} from "./jjWorkspaceBackend.js";
import type { ExecutionScope } from "../domain/executionScope.js";

export const SPAWN_JJ_WORKSPACE_PRODUCER = "Spawn-JJ-Workspace";
export const JJ_WORKSPACE_INTEGRATION_EXPORT = "jj.workspace.integration";
export const JJ_WORKSPACE_CLEANUP_EXPORT = "jj.workspace.cleanup";

export interface SpawnJjWorkspaceInput {
  cwd: string;
  castId: string;
  socketId: string;
  executionScope: ExecutionScope;
  workspaceRoot?: string;
}

export interface SpawnJjWorkspaceDeps {
  backend?: Pick<JjWorkspaceBackend, "createWorkspace">;
  setBookmark?: (bookmarkName: string, cwd: string) => Promise<void>;
}

/**
 * Materialize exactly one owned jj workspace and describe it as an opaque
 * replacement execution scope. Repository integration remains a utility
 * concern; core execution only transports the two producer-owned exports.
 */
export async function spawnJjWorkspaceScope(
  input: SpawnJjWorkspaceInput,
  deps: SpawnJjWorkspaceDeps = {},
): Promise<{ scope: ExecutionScope; workspace: JjWorkspaceRecord; bookmarkName: string }> {
  assertInput(input);
  if (path.resolve(input.cwd) !== path.resolve(input.executionScope.cwd)) {
    throw new Error("Spawn-JJ-Workspace cwd must match the active execution scope cwd.");
  }

  const backend = deps.backend ?? createJjWorkspaceBackend({
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  });
  const workspace = await backend.createWorkspace({
    cwd: input.executionScope.cwd,
    parentCastId: input.castId,
    loopId: input.socketId,
    laneId: input.executionScope.id,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  });
  const bookmarkName = branchBookmarkName(workspace);
  await (deps.setBookmark ?? setJjBookmark)(bookmarkName, workspace.cwd);

  const owner = { ...workspace.owner };
  const integration = {
    version: 1,
    backend: "jj",
    owner,
    repositoryRoot: workspace.repositoryRoot,
    workspaceRoot: workspace.workspaceRoot,
    workspacePath: workspace.workspacePath,
    workspaceName: workspace.workspaceName,
    manifestPath: workspace.manifestPath,
    baseline: { ...workspace.baseline },
    revision: { ...workspace.revision },
    operationId: workspace.operationId,
    bookmarkName,
  };
  const cleanup = {
    version: 1,
    backend: "jj",
    owner,
    workspaceRoot: workspace.workspaceRoot,
    workspacePath: workspace.workspacePath,
    workspaceName: workspace.workspaceName,
    manifestPath: workspace.manifestPath,
  };
  const scopeId = `${input.executionScope.id}:jj-workspace:${encodeURIComponent(workspace.workspaceName)}`;
  return {
    workspace,
    bookmarkName,
    scope: {
      id: scopeId,
      cwd: workspace.cwd,
      state: {
        ...structuredClone(input.executionScope.state),
        blackbeltBootstrap: {
          ok: true,
          root: workspace.repositoryRoot,
          available: { jj: true },
          initialized: false,
          newWorkingCommit: false,
          bookmarkName,
        },
      },
      exports: {
        ...structuredClone(input.executionScope.exports),
        [JJ_WORKSPACE_INTEGRATION_EXPORT]: { producer: SPAWN_JJ_WORKSPACE_PRODUCER, value: integration },
        [JJ_WORKSPACE_CLEANUP_EXPORT]: { producer: SPAWN_JJ_WORKSPACE_PRODUCER, value: cleanup },
      },
    },
  };
}

export function branchBookmarkName(workspace: Pick<JjWorkspaceRecord, "repositoryRoot" | "workspaceName" | "owner">): string {
  const digest = createHash("sha256")
    .update(`${workspace.repositoryRoot}\0${workspace.workspaceName}\0${workspace.owner.parentCastId}\0${workspace.owner.loopId}\0${workspace.owner.laneId}`)
    .digest("hex")
    .slice(0, 16);
  return `blackbelt/workspace-${digest}`;
}

async function setJjBookmark(bookmarkName: string, cwd: string): Promise<void> {
  const attempts = [
    ["bookmark", "set", bookmarkName, "--revision", "@"],
    ["bookmark", "create", bookmarkName, "--revision", "@"],
    ["bookmark", "move", bookmarkName, "--to", "@"],
  ];
  let lastError = "unknown jj error";
  for (const args of attempts) {
    const result = await runJj(args, cwd);
    if (result.code === 0) return;
    lastError = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  }
  throw new Error(`Spawn-JJ-Workspace could not provision ${bookmarkName}: ${lastError}`);
}

function runJj(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("jj", args, { cwd, shell: false, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === "number" ? error.code : error ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function assertInput(input: SpawnJjWorkspaceInput): void {
  for (const [name, value] of [["cwd", input.cwd], ["castId", input.castId], ["socketId", input.socketId], ["executionScope.id", input.executionScope?.id], ["executionScope.cwd", input.executionScope?.cwd]] as const) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Spawn-JJ-Workspace ${name} must be a non-empty string.`);
  }
  if (input.workspaceRoot !== undefined && (typeof input.workspaceRoot !== "string" || input.workspaceRoot.trim().length === 0)) {
    throw new Error("Spawn-JJ-Workspace workspaceRoot must be a non-empty string when provided.");
  }
}
