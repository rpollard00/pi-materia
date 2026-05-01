import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type BuiltInUtilityInput = {
  cwd: string;
  runDir: string;
  request: string;
  castId: string;
  nodeId: string;
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
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    const value = params.text ?? params.message ?? "";
    return typeof value === "string" ? value : JSON.stringify(value);
  },
  "project.ensureIgnored": ensureIgnored,
  "vcs.detect": detectVcs,
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

  return JSON.stringify({ ok: true, root, file: ignoreFile, patterns, added, unchanged: patterns.filter((pattern) => !added.includes(pattern)) });
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
  return JSON.stringify({ kind, root, available: { jj, git } });
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

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
