#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

class UtilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — handles large repos with many tracked files

const BOOKMARK_NOUNS = [
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

const BOOKMARK_VERBS = ["guards", "casts", "charges", "weaves", "strikes", "heals", "jumps", "tracks", "forges", "levels", "quests", "marches"];

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
    // Before initializing jj, ensure common build artifact directories
    // are in .gitignore so jj doesn't try to track them.  Untracked
    // build artifacts cause jj diff --summary to balloon output and
    // exceed maxBuffer, which breaks downstream blackbelt-maintain.
    await ensureBuildArtifactsGitignored(cwd);
    await execFileText("jj", ["git", "init"], cwd);
    initialized = true;
    root = await jjRoot(cwd);
    if (root === null) {
      throw new Error("jj git init completed but jj root could not be resolved.");
    }
  }

  // Generate bookmark name early so we can use it in the description for
  // dirty revisions (preventing unnamed commits from being stranded when
  // jj new advances @ away from undescribed work).
  const bookmarkName = generateBookmarkName(input, cwd);

  const hadEmptyHead = await isCurrentCommitEmpty(cwd);
  let newWorkingCommit = false;
  if (!hadEmptyHead) {
    // Describe the dirty working revision BEFORE creating a new empty commit.
    // This prevents an unnamed, undescribed commit from being left behind
    // when jj new advances @.  The description is deterministic (derived from
    // the bookmark name) so repeated bootstrap calls on the same cast produce
    // the same description.
    await execFileText("jj", ["describe", "-m", `bootstrap: ${bookmarkName}`], cwd);
    // Place the bookmark on the now-described revision so the bookmark always
    // tracks a pushable, described commit — never an empty or unnamed one.
    await setBookmark(bookmarkName, cwd);
    // Now create a new empty working commit on top.
    await execFileText("jj", ["new"], cwd);
    newWorkingCommit = true;
  } else {
    // Clean working copy — no describe/new needed. Just place the bookmark on @.
    await setBookmark(bookmarkName, cwd);
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
        bookmarkName,
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
  try {
    const diffSummary = await execFileText("jj", ["diff", "--summary"], cwd);
    return diffSummary.trim().length === 0;
  } catch (error) {
    // If jj diff --summary fails (e.g. maxBuffer exceeded due to build
    // artifacts not being gitignored), assume the working copy is NOT
    // empty.  Treating it as dirty triggers a describe+bookmark+new
    // sequence which is harmless even if the working copy were truly
    // clean — much better than crashing bootstrap.
    console.error(`[blackbelt-bootstrap] jj diff --summary failed (assuming dirty): ${formatError(error)}`);
    return false;
  }
}

/**
 * Idempotently set/create/move a bookmark to point at @.
 * Tries `jj bookmark set` (jj >= 0.20), falls back to `jj bookmark create`
 * for older jj where the bookmark may not exist yet, then `jj bookmark move`.
 */
async function setBookmark(bookmarkName, cwd) {
  try {
    await execFileText("jj", ["bookmark", "set", bookmarkName, "--revision", "@"], cwd);
  } catch (setErr) {
    console.error(`[blackbelt-bootstrap] bookmark set failed, trying bookmark create: ${formatError(setErr)}`);
    try {
      await execFileText("jj", ["bookmark", "create", bookmarkName, "--revision", "@"], cwd);
    } catch (createErr) {
      console.error(`[blackbelt-bootstrap] bookmark create failed, trying bookmark move: ${formatError(createErr)}`);
      await execFileText("jj", ["bookmark", "move", bookmarkName, "--to", "@"], cwd);
    }
  }
}

function execFileText(command, args, cwd, maxBuffer = MAX_BUFFER) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30000, maxBuffer }, (error, stdout, stderr) => {
      // Log stderr diagnostics to console.error so they are visible but do not
      // pollute stdout JSON output consumed by pi-materia.
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

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim().length > 0) {
    return `${message} (stderr: ${error.stderr.trim()})`;
  }
  return message;
}

/**
 * Generate a deterministic, git-ref-safe bookmark name under the blackbelt/ prefix.
 * Priority: explicit params.bookmarkName override, otherwise hash castId (with
 * runDir/cwd only as last-resort seeds) into blackbelt/<noun>-<verb>-<hash>.
 */
function generateBookmarkName(input, cwd) {
  const params = input.params != null && typeof input.params === "object" ? input.params : {};

  if (typeof params.bookmarkName === "string" && params.bookmarkName.trim().length > 0) {
    return sanitizeRefName(`blackbelt/${params.bookmarkName.trim()}`);
  }

  const seed = bookmarkSeed(input, cwd);
  const hash = createHash("sha256").update(seed).digest("hex");
  const nounIndex = Number.parseInt(hash.slice(0, 8), 16) % BOOKMARK_NOUNS.length;
  const verbIndex = Number.parseInt(hash.slice(8, 16), 16) % BOOKMARK_VERBS.length;
  const suffix = hash.slice(0, 10);

  return sanitizeRefName(`blackbelt/${BOOKMARK_NOUNS[nounIndex]}-${BOOKMARK_VERBS[verbIndex]}-${suffix}`);
}

function bookmarkSeed(input, cwd) {
  if (typeof input.castId === "string" && input.castId.trim().length > 0) {
    return input.castId.trim();
  }
  if (typeof input.runDir === "string" && input.runDir.trim().length > 0) {
    return input.runDir.trim();
  }
  return cwd;
}

/**
 * Ensure common build artifact directories are in .gitignore before jj
 * initialization.  Large untracked build outputs cause jj diff --summary
 * to produce enormous stdout, blowing past the execFile maxBuffer and
 * breaking blackbelt-maintain.
 *
 * Adds patterns for directories that are detected on disk (e.g. target/
 * for Rust projects) and common patterns that are safe to always ignore.
 */
async function ensureBuildArtifactsGitignored(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");

  // Existing .gitignore entries (empty set if file doesn't exist yet).
  let existing = new Set();
  try {
    const content = await readFile(gitignorePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) existing.add(trimmed);
    }
  } catch {
    // File doesn't exist — that's fine, we'll create it.
  }

  // Patterns to add when the corresponding directory exists on disk.
  const diskPatterns = {
    "target/": "target",       // Rust / cargo
    "node_modules/": "node_modules", // Node.js
    "dist/": "dist",           // JS / Python / general build output
    "build/": "build",         // C++, Python, general build output
    ".venv/": ".venv",         // Python virtualenv
    "venv/": "venv",           // Python virtualenv
    "__pycache__/": "__pycache__", // Python bytecode
    "*.egg-info/": null,       // Python egg-info — always safe to ignore
    ".tox/": ".tox",           // Python tox
    ".pytest_cache/": ".pytest_cache", // Python pytest cache
  };

  const addPatterns = [];
  for (const [pattern, checkDir] of Object.entries(diskPatterns)) {
    if (existing.has(pattern)) continue;
    if (checkDir === null) {
      // Always-safe patterns (no disk check needed).
      addPatterns.push(pattern);
    } else if (existsSync(path.join(cwd, checkDir))) {
      addPatterns.push(pattern);
    }
  }

  if (addPatterns.length === 0) return;

  // Append to .gitignore (create if it doesn't exist).
  const newBlock = [
    "",
    "# Added by Blackbelt-Bootstrap: build artifacts",
    ...addPatterns,
    "",
  ].join("\n");

  await appendFile(gitignorePath, newBlock, "utf8");
  console.error(`[blackbelt-bootstrap] Added ${addPatterns.length} build-artifact pattern(s) to .gitignore: ${addPatterns.join(", ")}`);
}

/**
 * Sanitize a string for use as a Git/JJ ref (bookmark) name.
 * Rules: lowercase; replace invalid chars with -; collapse repeats;
 * avoid empty segments, .., @{, .lock; no leading/trailing slash or dot.
 * Empty or fully-sanitized segments are replaced with "x" so that the
 * blackbelt/ prefix always produces at least a two-segment ref name.
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
  // Run before splitting so it catches .lock at segment boundaries.
  s = s.replace(/\.lock(?=\/|$)/gi, "-lock");

  // Split into segments and clean each one individually.
  // Do NOT strip trailing delimiters before splitting — let the per-segment
  // cleaner replace empty trailing segments with "x" so we always preserve
  // a non-empty suffix (e.g. "blackbelt/" becomes "blackbelt/x").
  const segments = s.split("/").map((seg) => {
    let cleaned = seg.replace(/^[-.]+/, "").replace(/[-.]+$/, "");
    if (cleaned.length === 0) cleaned = "x";
    // Guard against .lock surviving per-segment trimming (e.g. foo.lock. → foo.lock).
    // Git rejects any ref component ending in .lock, so replace the trailing suffix.
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
