#!/usr/bin/env node
/**
 * Parallel-Finalize — the explicit post-integration VCS boundary.
 *
 * This utility is intentionally not child-safe. It runs only in the parent
 * repository after a clean fan-in or a resolver has repaired a conflicted
 * integration revision. A rejected evaluator is a successful no-op from the
 * utility protocol: it returns satisfied:false and preserves the integration,
 * bookmark, parent working copy, lane workspaces, and artifacts.
 *
 * Input is the normal materia utility envelope:
 *   state.envelope.satisfied       post-integration evaluator decision
 *   state.parallelFanIn            durable fan-in provenance
 *   state.blackbeltBootstrap.bookmarkName
 *   cwd                            parent repository working directory
 *
 * Shared repository mutation is deliberately ordered:
 *   verify → describe integration → advance bookmark → jj new integration
 *   → verify empty parent WC → forget/remove owned lane workspaces.
 */
import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";

const MAX_BUFFER = 10 * 1024 * 1024;
const MANIFEST_VERSION = 1;
const ROOT_MARKER = ".pi-materia-jj-workspace-root.json";
const MANIFEST_DIRECTORY = ".manifests";

const input = await readStdinJson();
const cwd = typeof input.cwd === "string" && input.cwd.trim() ? path.resolve(input.cwd) : process.cwd();

try {
  const state = isRecord(input.state) ? input.state : {};
  const fanIn = isRecord(state.parallelFanIn) ? state.parallelFanIn : undefined;
  const bookmarkName = readBookmarkName(state);
  const evaluationAccepted = readEvaluationAccepted(input, state);

  if (!evaluationAccepted) {
    returnOutput(false, "post-integration evaluation was not accepted; integration and lane workspaces were preserved", {
      phase: "preserved",
      status: "preserved",
      conflictFree: false,
      finalizedAt: Date.now(),
      evaluationAccepted: false,
      ...(fanIn ? { parentCastId: fanIn.parentCastId, loopId: fanIn.loopId, runId: fanIn.runId } : {}),
      ...(fanIn?.integrationRevision ? { integrationRevision: fanIn.integrationRevision } : {}),
    });
  } else if (!fanIn) {
    returnOutput(false, "missing state.parallelFanIn provenance; nothing was finalized", {
      phase: "preserved",
      status: "preserved",
      conflictFree: false,
      finalizedAt: Date.now(),
      evaluationAccepted: true,
      errorCode: "fan_in_missing",
    });
  } else if (!bookmarkName) {
    returnOutput(false, "missing state.blackbeltBootstrap.bookmarkName; run Blackbelt-Bootstrap before finalization", {
      phase: "preserved",
      evaluationAccepted: true,
      errorCode: "bookmark_missing",
    });
  } else {
    const result = await finalize({ cwd, input, state, fanIn, bookmarkName });
    returnOutput(result.satisfied, result.context, result.state);
  }
} catch (error) {
  const message = formatError(error);
  console.error(`[parallel-finalize] ${message}`);
  returnOutput(false, `Parallel-Finalize: ${message}; integration and remaining lane workspaces were preserved.`, {
    phase: "preserved",
    status: "preserved",
    conflictFree: false,
    finalizedAt: Date.now(),
    evaluationAccepted: true,
    error: bound(message),
  });
}

async function finalize({ cwd, input, state, fanIn, bookmarkName }) {
  let integration = revisionFrom(fanIn.integrationRevision);
  if (!integration) throw new FinalizeError("integration_missing", "fan-in provenance has no verifiable integrationRevision");
  if (fanIn.version !== 1) throw new FinalizeError("fan_in_version", "unsupported parallel fan-in provenance version");
  if (fanIn.outcome !== "clean" && fanIn.outcome !== "conflict") throw new FinalizeError("fan_in_outcome", "fan-in provenance has no valid outcome");
  if (!Array.isArray(fanIn.orderedHeads) || fanIn.orderedHeads.length === 0) throw new FinalizeError("lane_heads_missing", "fan-in provenance has no ordered lane heads");
  if (typeof fanIn.parentCastId !== "string" || typeof fanIn.loopId !== "string" || typeof fanIn.runId !== "string") {
    throw new FinalizeError("fan_in_identity", "fan-in provenance has incomplete identity");
  }

  const root = await jjRoot(cwd);
  if (!root) throw new FinalizeError("jj_unavailable", "jj is unavailable or cwd is not a jj repository");

  const parentBefore = await readRevision(cwd, "@");
  const parentAtBaseline = sameRevision(parentBefore, fanIn.parentRevisionBefore) && sameRevision(parentBefore, fanIn.parentRevisionAfter);
  const parentAtResolvedIntegration = fanIn.outcome === "conflict" && sameRevision(parentBefore, integration);
  if (!parentAtBaseline && !parentAtResolvedIntegration) throw new FinalizeError("parent_drift", "parent working-copy revision drifted after fan-in");
  if (!(await isCleanWorkingCopy(cwd))) throw new FinalizeError("parent_dirty", "parent working copy is dirty");

  // Validate all ownership records before describing or moving a shared ref.
  const laneRecords = await validateLaneRecords(fanIn, root, input);
  const detail = await readRevisionDetails(cwd, integration.commitId);
  if (!sameRevision(detail, integration)) throw new FinalizeError("integration_drift", "integration revision identity changed before finalization");
  if (detail.conflict) throw new FinalizeError("conflicts_remaining", "jj still reports conflicts on the integration revision");

  const description = `parallel: integrate ${fanIn.loopId} (${fanIn.runId})`;
  await runJj(["describe", "-r", integration.commitId, "-m", description], cwd);
  // jj rewrites a described commit: its commit id changes while its change id
  // remains stable. The old commit id still resolves to the abandoned
  // predecessor, so all post-description mutations must use this fresh
  // identity resolved through the stable change id.
  const described = await readRevision(cwd, integration.changeId);
  if (described.changeId !== integration.changeId) throw new FinalizeError("description_verify", "integration revision could not be re-verified through its stable change id");
  integration = described;

  await setBookmark(bookmarkName, integration.commitId, cwd);
  const bookmark = await readRevision(cwd, bookmarkName);
  if (!sameRevision(bookmark, integration)) throw new FinalizeError("bookmark_verify", `bookmark ${JSON.stringify(bookmarkName)} does not point at described integration revision`);

  await runJj(["new", integration.commitId], cwd, { ignoreWorkingCopy: false });
  const parentWorkingRevision = await readRevision(cwd, "@", { ignoreWorkingCopy: false });
  const empty = await runJj(["log", "-r", "@", "--no-graph", "-T", "empty"], cwd, { ignoreWorkingCopy: false });
  if (empty.stdout.trim().toLowerCase() !== "true") throw new FinalizeError("parent_not_empty", "jj new did not produce a verifiably empty parent working commit");
  const parentOfWorking = await readRevision(cwd, "@-", { ignoreWorkingCopy: false });
  if (!sameRevision(parentOfWorking, integration)) throw new FinalizeError("parent_verify", "fresh parent working commit does not descend from integration revision");

  const cleanedLaneIds = [];
  for (const record of laneRecords) {
    await forgetAndRemoveLane(record, cwd);
    cleanedLaneIds.push(record.laneId);
  }

  return {
    satisfied: true,
    context: `Parallel-Finalize: accepted integration ${integration.commitId}, advanced ${bookmarkName}, created empty parent ${parentWorkingRevision.commitId}, and removed ${cleanedLaneIds.length} owned lane workspace(s).`,
    state: {
      version: 1,
      parentCastId: fanIn.parentCastId,
      loopId: fanIn.loopId,
      runId: fanIn.runId,
      phase: "completed",
      status: "completed",
      evaluationAccepted: true,
      conflictFree: true,
      integrationRevision: integration,
      bookmarkName,
      parentWorkingRevision,
      cleanedLaneIds,
      description,
      finalizedAt: Date.now(),
    },
  };
}

async function validateLaneRecords(fanIn, repositoryRoot, input) {
  const records = [];
  const seenPaths = new Set();
  for (const head of fanIn.orderedHeads) {
    if (!isRecord(head) || typeof head.laneId !== "string" || !isRecord(head.workspace)) throw new FinalizeError("workspace_missing", "fan-in lane is missing ownership data");
    const workspace = head.workspace;
    if (workspace.backend !== "jj" || typeof workspace.workspaceRoot !== "string" || typeof workspace.workspacePath !== "string" || typeof workspace.workspaceName !== "string" || typeof workspace.manifestPath !== "string") {
      throw new FinalizeError("workspace_invalid", `lane ${JSON.stringify(head.laneId)} has incomplete jj ownership data`);
    }
    const root = path.resolve(workspace.workspaceRoot);
    const workspacePath = path.resolve(workspace.workspacePath);
    const manifestPath = path.resolve(workspace.manifestPath);
    if (samePath(root, workspacePath) || !isWithin(root, workspacePath) || !isWithin(path.join(root, MANIFEST_DIRECTORY), manifestPath)) {
      throw new FinalizeError("workspace_path_escape", `lane ${JSON.stringify(head.laneId)} workspace path escapes its owned root`);
    }
    if (!isSafeWorkspaceName(workspace.workspaceName) || path.basename(workspacePath) !== workspace.workspaceName) {
      throw new FinalizeError("workspace_name_invalid", `lane ${JSON.stringify(head.laneId)} has an invalid workspace name`);
    }
    await assertNoSymlinkComponents(root, workspacePath);
    await assertNoSymlinkComponents(path.join(root, MANIFEST_DIRECTORY), manifestPath);
    const marker = await readJson(path.join(root, ROOT_MARKER));
    if (!isRecord(marker) || marker.backend !== "jj" || marker.version !== MANIFEST_VERSION) throw new FinalizeError("workspace_root_unowned", `lane ${JSON.stringify(head.laneId)} root is not owned by the jj workspace backend`);
    const manifest = await readJson(manifestPath);
    if (!isRecord(manifest) || manifest.version !== MANIFEST_VERSION || manifest.backend !== "jj" || !isRecord(manifest.owner)) throw new FinalizeError("manifest_invalid", `lane ${JSON.stringify(head.laneId)} ownership manifest is invalid`);
    if (manifest.owner.parentCastId !== fanIn.parentCastId || manifest.owner.loopId !== fanIn.loopId || manifest.owner.laneId !== head.laneId) throw new FinalizeError("manifest_owner_mismatch", `lane ${JSON.stringify(head.laneId)} ownership manifest belongs to another run`);
    if (manifest.repositoryRoot !== repositoryRoot || path.resolve(manifest.workspaceRoot) !== root || path.resolve(manifest.workspacePath) !== workspacePath || manifest.workspaceName !== workspace.workspaceName) throw new FinalizeError("manifest_identity_mismatch", `lane ${JSON.stringify(head.laneId)} manifest identity does not match fan-in provenance`);
    const baseline = revisionFrom(manifest.baseline);
    if (!baseline || !sameRevision(baseline, fanIn.baseline)) throw new FinalizeError("baseline_mismatch", `lane ${JSON.stringify(head.laneId)} has a different baseline`);
    if (!seenPaths.has(workspacePath)) {
      records.push({ laneId: head.laneId, workspace, manifest, workspacePath, manifestPath });
      seenPaths.add(workspacePath);
    }
  }
  return records;
}

async function forgetAndRemoveLane(record, cwd) {
  if (record.manifest.state !== "forgotten") await runJj(["workspace", "forget", record.workspace.workspaceName], cwd);
  await assertNoSymlinkComponents(record.workspace.workspaceRoot, record.workspacePath);
  await rm(record.workspacePath, { recursive: true, force: false });
  await rm(record.manifestPath, { force: false });
}

async function setBookmark(name, revision, cwd) {
  try {
    await runJj(["bookmark", "set", name, "--revision", revision], cwd);
    return;
  } catch (setError) {
    console.error(`[parallel-finalize] bookmark set fallback: ${formatError(setError)}`);
  }
  try {
    await runJj(["bookmark", "create", name, "--revision", revision], cwd);
    return;
  } catch (createError) {
    console.error(`[parallel-finalize] bookmark create fallback: ${formatError(createError)}`);
    await runJj(["bookmark", "move", name, "--to", revision], cwd);
  }
}

async function jjRoot(cwd) {
  try {
    const result = await runJj(["root"], cwd);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readRevision(cwd, revset, options = {}) {
  const result = await runJj(["log", "-r", revset, "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id ++ "\\n"'], cwd, options);
  const [commitId, changeId] = result.stdout.trim().split(/\s+/);
  if (!commitId || !changeId) throw new FinalizeError("revision_missing", `jj returned no revision for ${JSON.stringify(revset)}`);
  return { commitId, changeId };
}

async function readRevisionDetails(cwd, revset) {
  const result = await runJj(["log", "-r", revset, "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ conflict ++ "\\n"'], cwd);
  const [commitId, changeId, conflict = "false"] = result.stdout.trim().split(/\s+/);
  if (!commitId || !changeId) throw new FinalizeError("integration_missing", `jj returned no integration revision for ${JSON.stringify(revset)}`);
  return { commitId, changeId, conflict: conflict.toLowerCase() === "true" };
}

async function isCleanWorkingCopy(cwd) {
  const result = await runJj(["status"], cwd);
  const text = result.stdout.trim();
  return text.length === 0 || /working copy (?:has no changes|is clean)/i.test(text) || !/(working copy changes\s*:|^\s*[madrcu!?]\s+\S+)/im.test(text);
}

async function runJj(args, cwd, { ignoreWorkingCopy = true } = {}) {
  return execFileText("jj", [...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []), ...args], cwd);
}

function execFileText(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30_000, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}

async function assertNoSymlinkComponents(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new FinalizeError("workspace_path_escape", "workspace path is outside its owned root");
  let current = path.resolve(root);
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new FinalizeError("workspace_symlink", `refusing to follow symlink ${JSON.stringify(current)}`);
    } catch (error) {
      if (error instanceof FinalizeError) throw error;
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new FinalizeError("ownership_read_failed", `could not read ownership record ${JSON.stringify(file)}: ${formatError(error)}`);
  }
}

function readBookmarkName(state) {
  const bootstrap = isRecord(state.blackbeltBootstrap) ? state.blackbeltBootstrap : {};
  return typeof bootstrap.bookmarkName === "string" && bootstrap.bookmarkName.trim() ? bootstrap.bookmarkName.trim() : null;
}

function readEvaluationAccepted(input, state) {
  const envelope = isRecord(state.envelope) ? state.envelope : {};
  if (typeof envelope.satisfied === "boolean") return envelope.satisfied;
  if (isRecord(state.parallelEvaluation) && typeof state.parallelEvaluation.satisfied === "boolean") return state.parallelEvaluation.satisfied;
  if (typeof state.satisfied === "boolean") return state.satisfied;
  return typeof input.satisfied === "boolean" ? input.satisfied : false;
}

function revisionFrom(value) {
  return isRecord(value) && typeof value.commitId === "string" && value.commitId.trim() && typeof value.changeId === "string" && value.changeId.trim()
    ? { commitId: value.commitId.trim(), changeId: value.changeId.trim() }
    : undefined;
}

function sameRevision(left, right) {
  return Boolean(left && right && left.commitId === right.commitId && left.changeId === right.changeId);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function isSafeWorkspaceName(value) {
  return value.length > 0 && value === path.basename(value) && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && typeof error.code === "string" ? `${error.code}: ` : "";
  const stderr = error && typeof error === "object" && typeof error.stderr === "string" ? error.stderr.trim() : "";
  return bound(stderr ? `${code}${message} (${stderr})` : `${code}${message}`);
}

function bound(value, max = 1_000) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function returnOutput(satisfied, context, finalization) {
  process.stdout.write(`${JSON.stringify({ satisfied, context: bound(context, 4_000), state: { parallelFinalization: { version: 1, ...finalization, ok: satisfied } } })}\n`);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

class FinalizeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
