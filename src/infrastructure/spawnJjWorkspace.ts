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
}

/**
 * Materialize exactly one owned jj workspace and describe it as an opaque
 * replacement execution scope. Repository integration remains a utility
 * concern; core execution only transports the two producer-owned exports.
 */
export async function spawnJjWorkspaceScope(
  input: SpawnJjWorkspaceInput,
  deps: SpawnJjWorkspaceDeps = {},
): Promise<{ scope: ExecutionScope; workspace: JjWorkspaceRecord }> {
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
          newWorkingCommit: true,
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

function assertInput(input: SpawnJjWorkspaceInput): void {
  for (const [name, value] of [["cwd", input.cwd], ["castId", input.castId], ["socketId", input.socketId], ["executionScope.id", input.executionScope?.id], ["executionScope.cwd", input.executionScope?.cwd]] as const) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Spawn-JJ-Workspace ${name} must be a non-empty string.`);
  }
  if (input.workspaceRoot !== undefined && (typeof input.workspaceRoot !== "string" || input.workspaceRoot.trim().length === 0)) {
    throw new Error("Spawn-JJ-Workspace workspaceRoot must be a non-empty string when provided.");
  }
}
