#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

try {
  const input = await readStdinJson();
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();

  const jjAvailable = await isCommandAvailable("jj");
  if (!jjAvailable) {
    throw new UtilityError("Blackbelt-Bootstrap: jj is required but was not found on PATH.", {
      available: { jj: false },
      initialized: false,
      newWorkingCommit: false,
      root: null,
      emptyHead: false,
    });
  }

  let root = await jjRoot(cwd);
  let initialized = false;
  if (root === null) {
    await execFileText("jj", ["git", "init"], cwd);
    initialized = true;
    root = await jjRoot(cwd);
    if (root === null) {
      throw new Error("jj git init completed but jj root could not be resolved.");
    }
  }

  const hadEmptyHead = await isCurrentCommitEmpty(cwd);
  let newWorkingCommit = false;
  if (!hadEmptyHead) {
    await execFileText("jj", ["new"], cwd);
    newWorkingCommit = true;
  }

  writeStdoutJson({
    state: {
      blackbeltBootstrap: {
        ok: true,
        root,
        available: { jj: true },
        initialized,
        newWorkingCommit,
        emptyHead: true,
      },
    },
  });
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.startsWith("Blackbelt-Bootstrap:") ? rawMessage : `Blackbelt-Bootstrap: ${rawMessage}`;
  const details = error instanceof UtilityError ? error.details : {};
  console.error(message);
  writeStdoutJson({
    state: {
      blackbeltBootstrap: {
        ok: false,
        error: message,
        ...details,
      },
    },
  });
  process.exitCode = 1;
}

class UtilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
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

async function isCommandAvailable(command) {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        await access(path.join(dir, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        // Try next candidate.
      }
    }
  }
  return false;
}

async function jjRoot(cwd) {
  try {
    const stdout = await execFileText("jj", ["root"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isCurrentCommitEmpty(cwd) {
  const diffSummary = await execFileText("jj", ["diff", "--summary"], cwd);
  return diffSummary.trim().length === 0;
}

function execFileText(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve(stdout);
    });
  });
}
