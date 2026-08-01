#!/usr/bin/env node
/**
 * Parallel-Lane-Checkpoint — deterministic jj checkpointing for one child lane.
 *
 * A lane owns its working copy, not a bookmark.  This utility therefore only
 * runs working-copy-local jj operations in `cwd`:
 *
 *   status → describe → read @ → new → verify @ is empty
 *
 * Empty working copies are successful no-ops.  Meaningful work is described
 * with the current work-item title, the described revision is recorded as the
 * latest meaningful lane head, and `jj new` leaves a fresh empty working
 * commit ready for the next item in the stream.  No bookmark, parent working
 * copy, or other lane ref is ever read or changed.
 *
 * Output is JSONL-compatible and intentionally keeps checkpoint metadata under
 * state.parallelLaneCheckpoint so it cannot be mistaken for generic handoff
 * content.  Failures are represented as an infrastructure state result while
 * the process exits zero, matching the utility socket contract.
 */
import { execFile } from "node:child_process";

const CHECKPOINT_STATE_VERSION = 1;
const MAX_BUFFER = 10 * 1024 * 1024;
const MAX_ERROR_DETAIL = 1_000;
const COMMAND_TIMEOUT_MS = 30_000;

let input = {};
let cwd = process.cwd();
let lastObservedHead;
try {
  input = await readStdinJson();
  cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0
    ? input.cwd
    : process.cwd();
  const title = input.item != null && typeof input.item === "object"
    ? input.item.title
    : undefined;

  if (typeof title !== "string" || title.trim().length === 0) {
    finishFailure(input, cwd, "current work-item title is missing; cannot describe a lane checkpoint");
  } else {
    await checkpointLane(input, cwd, title.trim());
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  finishFailure(input, cwd, message, lastObservedHead ? { latestMeaningfulHead: lastObservedHead, meaningful: true } : {});
}

async function checkpointLane(input, cwd, title) {
  const previous = previousCheckpoint(input);
  const status = await runJj(["status"], cwd);
  if (status.exitCode !== 0) {
    throw new Error(`jj status failed: ${formatCommandResult(status)}`);
  }

  if (isCleanStatus(status.stdout)) {
    const checkpoint = buildCheckpointState(input, cwd, previous, {
      ok: true,
      checkpointCreated: false,
      meaningful: false,
      itemKey: input.itemKey,
      itemTitle: title,
      context: "empty working copy; no checkpoint created",
    });
    writeStdoutJson({
      satisfied: true,
      context: `Parallel-Lane-Checkpoint: skipped empty checkpoint for ${JSON.stringify(title)}; lane working copy is clean.`,
      state: { parallelLaneCheckpoint: checkpoint },
    });
    return;
  }

  const described = await runJj(["describe", "-m", title], cwd);
  if (described.exitCode !== 0) {
    throw new Error(`jj describe failed: ${formatCommandResult(described)}`);
  }

  const head = await readRevision(cwd);
  lastObservedHead = head;
  const created = await runJj(["new"], cwd);
  if (created.exitCode !== 0) {
    throw new Error(`jj new failed: ${formatCommandResult(created)}`);
  }

  const empty = await runJj(["log", "-r", "@", "--no-graph", "-T", "empty"], cwd);
  if (empty.exitCode !== 0 || empty.stdout.trim().toLowerCase() !== "true") {
    throw new Error(
      `jj new did not produce a verifiably empty working commit: ${formatCommandResult(empty)}`,
    );
  }

  const checkpoint = buildCheckpointState(input, cwd, previous, {
    ok: true,
    checkpointCreated: true,
    meaningful: true,
    itemKey: input.itemKey,
    itemTitle: title,
    latestMeaningfulHead: head,
    context: "meaningful lane work described and fresh empty working commit created",
  });
  writeStdoutJson({
    satisfied: true,
    context: `Parallel-Lane-Checkpoint: checkpointed ${JSON.stringify(title)} at lane head ${head.commitId}; fresh empty working commit is ready.`,
    state: { parallelLaneCheckpoint: checkpoint },
  });
}

function buildCheckpointState(input, cwd, previous, values) {
  const checkpoints = Array.isArray(previous?.checkpoints)
    ? previous.checkpoints.map(cloneCheckpoint)
    : [];
  if (values.checkpointCreated === true && values.latestMeaningfulHead) {
    checkpoints.push({
      ...(values.itemKey !== undefined ? { itemKey: values.itemKey } : {}),
      itemTitle: values.itemTitle,
      head: { ...values.latestMeaningfulHead },
    });
  }

  const laneId = resolveLaneId(input, previous);
  return {
    version: CHECKPOINT_STATE_VERSION,
    ok: values.ok,
    workspacePath: cwd,
    ...(laneId ? { laneId } : {}),
    ...(values.itemKey !== undefined ? { itemKey: values.itemKey } : {}),
    ...(values.itemTitle !== undefined ? { itemTitle: values.itemTitle } : {}),
    checkpointCreated: values.checkpointCreated,
    meaningful: values.meaningful,
    ...(values.latestMeaningfulHead
      ? { latestMeaningfulHead: { ...values.latestMeaningfulHead } }
      : previous?.latestMeaningfulHead
        ? { latestMeaningfulHead: { ...previous.latestMeaningfulHead } }
        : {}),
    checkpoints,
    ...(values.context ? { message: values.context } : {}),
  };
}

function finishFailure(input, cwd, reason, details = {}) {
  const previous = previousCheckpoint(input);
  const checkpoint = buildCheckpointState(input, cwd, previous, {
    ok: false,
    checkpointCreated: false,
    meaningful: false,
    ...details,
    context: reason,
  });
  writeStdoutJson({
    satisfied: false,
    context: `Parallel-Lane-Checkpoint: ${reason}`,
    state: { parallelLaneCheckpoint: { ...checkpoint, error: reason } },
  });
}

async function readRevision(cwd) {
  const result = await runJj([
    "log",
    "-r",
    "@",
    "--no-graph",
    "-T",
    'commit_id ++ "\\t" ++ change_id ++ "\\n"',
  ], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`jj log failed while reading the meaningful lane head: ${formatCommandResult(result)}`);
  }

  const line = result.stdout.trim().split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  const [commitId, changeId] = line?.split("\t") ?? [];
  if (!commitId || !changeId) {
    throw new Error("jj log returned no usable commit_id/change_id for the meaningful lane head");
  }
  return { commitId, changeId };
}

function previousCheckpoint(input) {
  const state = isPlainObject(input?.state) ? input.state : {};
  return isPlainObject(state.parallelLaneCheckpoint) ? state.parallelLaneCheckpoint : undefined;
}

function resolveLaneId(input, previous) {
  const params = isPlainObject(input?.params) ? input.params : {};
  const state = isPlainObject(input?.state) ? input.state : {};
  const lane = isPlainObject(state.parallelLane) ? state.parallelLane : {};
  const run = isPlainObject(state.parallelRun) ? state.parallelRun : {};
  const coordinator = isPlainObject(state.parallelCoordinator) ? state.parallelCoordinator : {};
  const candidates = [params.laneId, input?.laneId, state.parallelLaneId, lane.laneId, run.laneId, coordinator.laneId, previous?.laneId];
  return candidates.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function cloneCheckpoint(value) {
  return isPlainObject(value) ? structuredClone(value) : value;
}

function isCleanStatus(stdout) {
  const text = String(stdout ?? "").trim();
  if (text.length === 0 || /^(?:clean|empty)$/i.test(text)) return true;
  if (/working copy (?:has no changes|is clean)/i.test(text)) return true;
  if (/no changes/i.test(text) && !/working copy changes/i.test(text)) return true;
  if (/working copy changes\s*:/i.test(text)) return false;
  if (/^\s*[madrcu!?]\s+\S+/im.test(text)) return false;
  // A jj status implementation may omit the prose sentence but still expose
  // its canonical empty marker. Treat an otherwise unclassified status as
  // dirty so work is never silently skipped.
  return /\(empty\)/i.test(text) && !/\b(?:modified|added|deleted|renamed|conflict|working copy changes)\b/i.test(text)
    ? true
    : false;
}

async function runJj(args, cwd) {
  return await new Promise((resolve) => {
    execFile("jj", args, {
      cwd,
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode,
      });
    });
  });
}

function formatCommandResult(result) {
  const details = result.stderr.trim() || result.stdout.trim();
  if (!details) return `exit code ${result.exitCode}`;
  return details.length > MAX_ERROR_DETAIL
    ? `${details.slice(0, MAX_ERROR_DETAIL)}…`
    : details;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeStdoutJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
