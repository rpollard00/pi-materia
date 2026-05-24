#!/usr/bin/env node
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

try {
  const input = await readStdinJson();
  const params = isPlainObject(input.params) ? input.params : {};
  const rawPatterns = params.patterns;
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns.filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
    : [];
  if (patterns.length === 0) throw new Error("project.ensureIgnored requires params.patterns to be a non-empty string array.");

  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
  const root = typeof params.root === "string" && params.root.length > 0 ? resolvePath(cwd, params.root) : findProjectRoot(cwd) ?? cwd;
  const ignoreFile = typeof params.file === "string" && params.file.length > 0 ? resolvePath(root, params.file) : path.join(root, ".gitignore");

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

  writeStdoutJson({ state: { artifactIgnore: { ok: true, root, file: ignoreFile, patterns, added, unchanged: patterns.filter((pattern) => !added.includes(pattern)) } } });
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

function findProjectRoot(cwd) {
  return findUp(cwd, ".jj") ?? findUp(cwd, ".git");
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

function resolvePath(base, inputPath) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(base, inputPath);
}

function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
