#!/usr/bin/env node
import { execFile } from "node:child_process";

try {
  const input = await readStdinJson();
  const title = input.item != null && typeof input.item === "object" ? input.item.title : null;

  // Fail early if no title available
  if (typeof title !== "string" || title.trim().length === 0) {
    writeStdoutJson({
      satisfied: false,
      context: "Blackbelt-Maintain: no item title available for the VCS message.",
    });
    process.exit(0);
  }

  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();

  // Prefer jj: check command availability and jj root success
  const isJjRepo = await isJjAvailable(cwd);
  const isGitRepo = !isJjRepo ? await isGitAvailable(cwd) : false;

  if (isJjRepo) {
    await handleJj(cwd, title);
  } else if (isGitRepo) {
    await handleGit(cwd, title);
  } else {
    writeStdoutJson({
      satisfied: false,
      context: "Blackbelt-Maintain: no supported VCS (jj or git) detected in the working directory.",
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeStdoutJson({
    satisfied: false,
    context: `Blackbelt-Maintain: unexpected error: ${message}`,
  });
}

async function handleJj(cwd, title) {
  // Detect clean working commit with empty-diff check
  const diffSummary = await execFileText("jj", ["diff", "--summary"], cwd);
  const isClean = diffSummary.trim().length === 0;

  if (isClean) {
    writeStdoutJson({
      satisfied: true,
      context: "Blackbelt-Maintain: clean jj working commit — no-op, nothing to checkpoint.",
    });
    return;
  }

  // Dirty: describe the current change then create a new empty commit
  try {
    await execFileText("jj", ["describe", "-m", title], cwd);
    await execFileText("jj", ["new"], cwd);
    writeStdoutJson({
      satisfied: true,
      context: "Blackbelt-Maintain: jj checkpoint created and new working commit ready.",
    });
  } catch (error) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: jj command failed: ${formatExecError(error)}`,
    });
  }
}

async function handleGit(cwd, title) {
  // Detect clean status
  const status = await execFileText("git", ["status", "--porcelain"], cwd);
  const isClean = status.trim().length === 0;

  if (isClean) {
    writeStdoutJson({
      satisfied: true,
      context: "Blackbelt-Maintain: clean git working tree — no-op, nothing to commit.",
    });
    return;
  }

  // Dirty: stage all and commit
  try {
    await execFileText("git", ["add", "-A"], cwd);
    await execFileText("git", ["commit", "-m", title], cwd);
    writeStdoutJson({
      satisfied: true,
      context: "Blackbelt-Maintain: git commit created.",
    });
  } catch (error) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: git command failed: ${formatExecError(error)}`,
    });
  }
}

async function isJjAvailable(cwd) {
  try {
    const root = await execFileText("jj", ["root"], cwd);
    return root.trim().length > 0;
  } catch {
    return false;
  }
}

async function isGitAvailable(cwd) {
  try {
    const root = await execFileText("git", ["rev-parse", "--show-toplevel"], cwd);
    return root.trim().length > 0;
  } catch {
    return false;
  }
}

function execFileText(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

function formatExecError(error) {
  const message = typeof error === "object" && error !== null ? error.message ?? String(error) : String(error);
  let details = message;
  if (typeof error === "object" && error !== null && "stderr" in error && error.stderr) {
    details += ` (stderr: ${String(error.stderr).trim()})`;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    details += ` (exit: ${error.code})`;
  }
  return details;
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
