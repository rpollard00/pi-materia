import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringifyDeterministicHandoffOutput } from "../handoff/handoffContract.js";
import { createExecutionScope, type ExecutionScope } from "../domain/executionScope.js";
import { spawnJjWorkspaceScope } from "../infrastructure/spawnJjWorkspace.js";
import { integrateJjWorkspaceExports } from "../infrastructure/integrateJjWorkspaces.js";
import { finalizeJjWorkspace } from "../infrastructure/finalizeJjWorkspace.js";

export type BuiltInUtilityInput = {
  cwd: string;
  runDir: string;
  request: string;
  castId: string;
  socketId: string;
  executionScope: ExecutionScope;
  baseScope?: ExecutionScope;
  params: Record<string, unknown>;
  state: unknown;
  item: unknown;
  itemKey: unknown;
  itemLabel: unknown;
  cursor?: unknown;
  cursors?: unknown;
};

type BuiltInUtility = (input: BuiltInUtilityInput) => Promise<string> | string;

const registry: Record<string, BuiltInUtility> = {
  noop: async () => "",
  echo: async ({ params }) => {
    if (Object.prototype.hasOwnProperty.call(params, "output")) {
      const value = params.output;
      return typeof value === "string" ? value : stringifyDeterministicHandoffOutput(value);
    }
    const value = params.text ?? params.message ?? "";
    return typeof value === "string" ? value : stringifyDeterministicHandoffOutput(value);
  },
  "project.ensureIgnored": ensureIgnored,
  "vcs.detect": detectVcs,
  "vcs.spawnJjWorkspace": spawnJjWorkspace,
  "vcs.integrateJjWorkspaces": integrateJjWorkspaces,
  "vcs.finalizeJjWorkspace": finalizeIntegratedJjWorkspace,
};

export function hasBuiltInUtility(alias: string | undefined): alias is keyof typeof registry {
  return typeof alias === "string" && Object.prototype.hasOwnProperty.call(registry, alias);
}

export async function executeBuiltInUtility(alias: string, input: BuiltInUtilityInput): Promise<string> {
  const utility = registry[alias];
  if (!utility) throw new Error(`Unknown utility alias "${alias}".`);
  return await utility(input);
}

async function ensureIgnored(input: BuiltInUtilityInput): Promise<string> {
  const params = input.params;
  const rawPatterns = params.patterns;
  const patterns = Array.isArray(rawPatterns) ? rawPatterns.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()) : [];
  if (patterns.length === 0) throw new Error('project.ensureIgnored requires params.patterns to be a non-empty string array.');

  const root = (typeof params.root === "string" && params.root.length > 0) ? resolveInsideCwd(input.cwd, params.root) : findProjectRoot(input.cwd) ?? input.cwd;
  const ignoreFile = (typeof params.file === "string" && params.file.length > 0) ? resolveInsideCwd(root, params.file) : path.join(root, ".gitignore");

  let existing = "";
  try {
    existing = await readFile(ignoreFile, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const existingEntries = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#")));
  const added = patterns.filter((pattern) => !existingEntries.has(pattern));
  if (added.length > 0) {
    await mkdir(path.dirname(ignoreFile), { recursive: true });
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(ignoreFile, `${existing}${prefix}${added.join("\n")}\n`);
  }

  return stringifyDeterministicHandoffOutput({ ok: true, root, file: ignoreFile, patterns, added, unchanged: patterns.filter((pattern) => !added.includes(pattern)) });
}

async function spawnJjWorkspace(input: BuiltInUtilityInput): Promise<string> {
  const executionScope = createExecutionScope(input.executionScope);
  const workspaceRoot = input.params.workspaceRoot;
  if (workspaceRoot !== undefined && (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0)) {
    throw new Error("vcs.spawnJjWorkspace params.workspaceRoot must be a non-empty string when provided.");
  }
  const spawned = await spawnJjWorkspaceScope({
    cwd: input.cwd,
    castId: input.castId,
    socketId: input.socketId,
    executionScope,
    ...(typeof workspaceRoot === "string" ? { workspaceRoot } : {}),
  });
  return stringifyDeterministicHandoffOutput({
    satisfied: true,
    context: `Spawn-JJ-Workspace: created owned bookmarkless checkpoint workspace ${spawned.workspace.workspaceName}.`,
    scopeTransition: { kind: "replace", scope: spawned.scope },
  });
}

async function integrateJjWorkspaces(input: BuiltInUtilityInput): Promise<string> {
  const integrated = await integrateJjWorkspaceExports({
    cwd: input.cwd,
    castId: input.castId,
    socketId: input.socketId,
    executionScope: createExecutionScope(input.executionScope),
    state: input.state,
  });
  const revision = integrated.integration.finalTip;
  const outcome = integrated.integration.outcome;
  return stringifyDeterministicHandoffOutput({
    satisfied: true,
    context: outcome === "conflict"
      ? `Integrate-JJ-Workspaces: materialized ${integrated.sourceCount} ordered workstream(s) at conflicted final linear tip ${revision.commitId}.`
      : `Integrate-JJ-Workspaces: cleanly materialized ${integrated.sourceCount} ordered workstream(s) at final linear tip ${revision.commitId}.`,
    state: { jjWorkspaceIntegration: integrated.scope.state.jjWorkspaceIntegration },
    scopeTransition: { kind: "replace", scope: integrated.scope },
  });
}

async function finalizeIntegratedJjWorkspace(input: BuiltInUtilityInput): Promise<string> {
  const state = isRecord(input.state) ? input.state : {};
  const bootstrap = isRecord(state.blackbeltBootstrap) ? state.blackbeltBootstrap : undefined;
  const bookmarkName = bootstrap?.bookmarkName;
  if (typeof bookmarkName !== "string" || bookmarkName.trim().length === 0) {
    throw new Error("Finalize-JJ-Workspace requires state.blackbeltBootstrap.bookmarkName.");
  }
  const description = input.params.description;
  if (description !== undefined && (typeof description !== "string" || description.trim().length === 0)) {
    throw new Error("vcs.finalizeJjWorkspace params.description must be a non-empty string when provided.");
  }
  if (!input.baseScope) throw new Error("Finalize-JJ-Workspace requires the cast base execution scope.");
  const finalized = await finalizeJjWorkspace({
    cwd: input.cwd,
    executionScope: createExecutionScope(input.executionScope),
    baseScope: createExecutionScope(input.baseScope),
    state: input.state,
    bookmarkName,
    ...(typeof description === "string" ? { description } : {}),
  });
  const summary = {
    version: 1,
    status: "completed",
    conflictFree: true,
    integrationRevision: finalized.integrationRevision,
    baseWorkingRevision: finalized.baseWorkingRevision,
    bookmarkName: finalized.bookmarkName,
    cleanedWorkspaceNames: finalized.cleanedWorkspaceNames,
    reviewCorrection: finalized.reviewCorrection,
    orderedChangeIds: finalized.orderedChangeIds,
    ...(finalized.description ? { description: finalized.description } : {}),
  };
  return stringifyDeterministicHandoffOutput({
    satisfied: true,
    context: `Finalize-JJ-Workspace: published conflict-free meaningful tip ${finalized.integrationRevision.commitId} through the original bookmark ${finalized.bookmarkName}${finalized.reviewCorrection ? " with one integration-fix commit" : " without an extra integration commit"}, created an empty base working commit outside published history, and cleaned ${finalized.cleanedWorkspaceNames.length} owned workspace(s).`,
    state: { jjWorkspaceFinalization: summary },
    scopeTransition: { kind: "replace", scope: finalized.scope },
  });
}

async function detectVcs(input: BuiltInUtilityInput): Promise<string> {
  const [jj, git] = await Promise.all([isCommandAvailable("jj"), isCommandAvailable("git")]);
  const markerJjRoot = findUp(input.cwd, ".jj");
  const markerGitRoot = findUp(input.cwd, ".git");
  const commandJjRoot = jj ? await commandRoot("jj", ["root"], input.cwd) : null;
  const commandGitRoot = git ? await commandRoot("git", ["rev-parse", "--show-toplevel"], input.cwd) : null;
  const jjRoot = markerJjRoot ?? commandJjRoot;
  const gitRoot = markerGitRoot ?? commandGitRoot;
  const kind = jjRoot ? "jj" : gitRoot ? "git" : "none";
  const root = jjRoot ?? gitRoot ?? null;
  return stringifyDeterministicHandoffOutput({ kind, root, available: { jj, git } });
}

function findProjectRoot(cwd: string): string | null {
  return findUp(cwd, ".jj") ?? findUp(cwd, ".git");
}

function findUp(start: string, marker: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (exists(path.join(current, marker))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function exists(file: string): boolean {
  try {
    accessSync(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        await access(path.join(dir, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        // try next candidate
      }
    }
  }
  return false;
}

async function commandRoot(command: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const stdout = await execFileText(command, args, cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function execFileText(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

function resolveInsideCwd(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
