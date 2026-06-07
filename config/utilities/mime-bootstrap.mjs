#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants } from "node:fs/promises";
import path from "node:path";

class UtilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

const BRANCH_NOUNS = [
  "crystal",
  "chocobo",
  "moogle",
  "airship",
  "cactuar",
  "tonberry",
  "gil",
  "behemoth",
  "spell",
  "dragoon",
  "mage",
  "knight",
  "thief",
  "monk",
  "paladin",
  "summoner",
  "alchemy",
  "aether",
  "limit",
  "tome",
  "ribbon",
  "potion",
  "ether",
  "elixir",
  "relic",
  "armlet",
  "lance",
  "blade",
  "grimoire",
  "caravan",
];

const BRANCH_VERBS = ["guards", "casts", "charges", "weaves", "strikes", "heals", "jumps", "tracks", "forges", "levels", "quests", "marches"];

try {
  const input = await readStdinJson();
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();

  const gitAvailable = await isCommandAvailable("git");
  if (!gitAvailable) {
    throw new UtilityError("Mime-Bootstrap: git is required but was not found on PATH.", {
      available: { git: false },
      initialized: false,
      root: null,
      cleanWorkingTree: false,
    });
  }

  const root = await gitRoot(cwd);
  if (root === null) {
    throw new UtilityError("Mime-Bootstrap: no git repository detected. Initialize a git repo first (`git init`).", {
      available: { git: true },
      hasGitRepo: false,
      root: null,
      cleanWorkingTree: false,
    });
  }

  const isClean = await isWorkingTreeClean(cwd);

  const branchName = generateBranchName(input, cwd);

  // Create and switch to the branch. If it already exists, just switch.
  const branchExists = await doesBranchExist(branchName, cwd);
  if (branchExists) {
    await execFileText("git", ["checkout", branchName], cwd);
  } else {
    await execFileText("git", ["checkout", "-b", branchName], cwd);
  }

  writeStdoutJson({
    state: {
      mimeBootstrap: {
        ok: true,
        root,
        available: { git: true },
        initialized: false,
        cleanWorkingTree: isClean,
        branchName,
      },
    },
  });
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.startsWith("Mime-Bootstrap:") ? rawMessage : `Mime-Bootstrap: ${rawMessage}`;
  const details = error instanceof UtilityError ? error.details : {};
  console.error(message);
  writeStdoutJson({
    state: {
      mimeBootstrap: {
        ok: false,
        error: message,
        ...details,
      },
    },
  });
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

async function gitRoot(cwd) {
  try {
    const stdout = await execFileText("git", ["rev-parse", "--show-toplevel"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isWorkingTreeClean(cwd) {
  try {
    const stdout = await execFileText("git", ["status", "--porcelain"], cwd);
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
}

async function doesBranchExist(branchName, cwd) {
  try {
    const stdout = await execFileText("git", ["branch", "--list", branchName], cwd);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function execFileText(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (stderr && stderr.trim().length > 0) {
        console.error(`[${command}] ${stderr.trim()}`);
      }
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

/**
 * Generate a deterministic, git-ref-safe branch name under the mime/ prefix.
 * Priority: explicit params.branchName override, otherwise hash castId (with
 * runDir/cwd only as last-resort seeds) into mime/<noun>-<verb>-<hash>.
 */
function generateBranchName(input, cwd) {
  const params = input.params != null && typeof input.params === "object" ? input.params : {};

  if (typeof params.branchName === "string" && params.branchName.trim().length > 0) {
    return sanitizeRefName(`mime/${params.branchName.trim()}`);
  }

  const seed = branchSeed(input, cwd);
  const hash = createHash("sha256").update(seed).digest("hex");
  const nounIndex = Number.parseInt(hash.slice(0, 8), 16) % BRANCH_NOUNS.length;
  const verbIndex = Number.parseInt(hash.slice(8, 16), 16) % BRANCH_VERBS.length;
  const suffix = hash.slice(0, 10);

  return sanitizeRefName(`mime/${BRANCH_NOUNS[nounIndex]}-${BRANCH_VERBS[verbIndex]}-${suffix}`);
}

function branchSeed(input, cwd) {
  if (typeof input.castId === "string" && input.castId.trim().length > 0) {
    return input.castId.trim();
  }
  if (typeof input.runDir === "string" && input.runDir.trim().length > 0) {
    return input.runDir.trim();
  }
  return cwd;
}

/**
 * Sanitize a string for use as a Git ref (branch) name.
 * Rules: lowercase; replace invalid chars with -; collapse repeats;
 * avoid empty segments, .., @{, .lock; no leading/trailing slash or dot.
 * Empty or fully-sanitized segments are replaced with "x" so that the
 * mime/ prefix always produces at least a two-segment ref name.
 */
function sanitizeRefName(raw) {
  let s = raw.toLowerCase();

  // Replace Git-ref-invalid characters with '-'
  // Invalid per git-check-ref-format: control chars, space, ~ ^ : ? * [ \
  s = s.replace(/[\x00-\x20\x7f~^:?*[\\]/g, "-");

  // Break @{ sequence (replace @ with - in that context)
  s = s.replace(/@\{/g, "-{");

  // Break .. (double dot)
  s = s.replace(/\.\./g, ".-");

  // Collapse consecutive hyphens
  s = s.replace(/-{2,}/g, "-");

  // Collapse multiple slashes
  s = s.replace(/\/{2,}/g, "/");

  // Remove leading / and . (before splitting so the first segment is never empty)
  s = s.replace(/^[\/.]+/, "");

  // Replace .lock in any path segment (Git rejects ref components ending in .lock).
  s = s.replace(/\.lock(?=\/|$)/gi, "-lock");

  // Split into segments and clean each one individually.
  const segments = s.split("/").map((seg) => {
    let cleaned = seg.replace(/^[-.]+/, "").replace(/[-.]+$/, "");
    if (cleaned.length === 0) cleaned = "x";
    if (cleaned.endsWith(".lock")) {
      cleaned = cleaned.slice(0, -5) + "-x";
    }
    return cleaned;
  });

  s = segments.join("/");

  // A lone '@' is invalid as a ref name; empty string too
  if (s === "@" || s.length === 0) s = "x";

  return s;
}
