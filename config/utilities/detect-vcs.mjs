#!/usr/bin/env node
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

try {
  const input = await readStdinJson();
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
  const [jj, git] = await Promise.all([isCommandAvailable("jj"), isCommandAvailable("git")]);
  const markerJjRoot = findUp(cwd, ".jj");
  const markerGitRoot = findUp(cwd, ".git");
  const commandJjRoot = jj ? await commandRoot("jj", ["root"], cwd) : null;
  const commandGitRoot = git ? await commandRoot("git", ["rev-parse", "--show-toplevel"], cwd) : null;
  const jjRoot = markerJjRoot ?? commandJjRoot;
  const gitRoot = markerGitRoot ?? commandGitRoot;
  const kind = jjRoot ? "jj" : gitRoot ? "git" : "none";
  const root = jjRoot ?? gitRoot ?? null;
  writeStdoutJson({ kind, root, available: { jj, git } });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
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

function findUp(start, marker) {
  let current = path.resolve(start);
  while (true) {
    if (exists(path.join(current, marker))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function exists(file) {
  try {
    accessSync(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
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
        // try next candidate
      }
    }
  }
  return false;
}

async function commandRoot(command, args, cwd) {
  try {
    const stdout = await execFileText(command, args, cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function execFileText(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}
