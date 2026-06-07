import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SHIPPED_UTILITY_SCRIPT_KIND = "shippedUtility";
export const SHIPPED_UTILITY_MANIFEST = ".pi-materia-shipped-utilities.json";

export interface ShippedUtilityScriptRef {
  kind: typeof SHIPPED_UTILITY_SCRIPT_KIND;
  name: string;
  runtime?: "node";
}

interface ManifestEntry {
  sourceHash: string;
  profileFile: string;
  conflict?: string;
}

interface ShippedUtilityManifest {
  version: 1;
  utilities: Record<string, ManifestEntry>;
}

export interface ShippedUtilitySyncResult {
  utilitiesDir: string;
  manifestPath: string;
  copied: string[];
  unchanged: string[];
  conflicts: string[];
}

export function isShippedUtilityScriptRef(value: unknown): value is ShippedUtilityScriptRef {
  return typeof value === "object" && value !== null
    && (value as { kind?: unknown }).kind === SHIPPED_UTILITY_SCRIPT_KIND
    && typeof (value as { name?: unknown }).name === "string";
}

export function getUserUtilitiesDir(profileDir: string): string {
  return path.join(profileDir, "utilities");
}

export function resolveShippedUtilityScriptPath(profileDir: string, ref: ShippedUtilityScriptRef): string {
  const name = normalizeShippedUtilityName(ref.name);
  const utilitiesDir = getUserUtilitiesDir(profileDir);
  const manifest = readManifestSync(path.join(utilitiesDir, SHIPPED_UTILITY_MANIFEST));
  const profileFile = manifest.utilities[name]?.profileFile ?? name;
  const resolved = path.resolve(utilitiesDir, profileFile);
  const root = path.resolve(utilitiesDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Shipped utility script "${name}" resolves outside the profile utilities directory.`);
  }
  return resolved;
}

export async function syncShippedUtilityScripts(profileDir: string): Promise<ShippedUtilitySyncResult> {
  const utilitiesDir = getUserUtilitiesDir(profileDir);
  const manifestPath = path.join(utilitiesDir, SHIPPED_UTILITY_MANIFEST);
  await mkdir(utilitiesDir, { recursive: true });
  const manifest = await readManifest(manifestPath);
  const result: ShippedUtilitySyncResult = { utilitiesDir, manifestPath, copied: [], unchanged: [], conflicts: [] };

  for (const sourcePath of bundledUtilityScriptPaths()) {
    const name = normalizeShippedUtilityName(path.basename(sourcePath));
    const sourceHash = await sha256File(sourcePath);
    const existingEntry = manifest.utilities[name];
    const targetFile = existingEntry?.profileFile ?? name;
    const targetPath = path.join(utilitiesDir, targetFile);

    if (!existsSync(targetPath)) {
      await copyFile(sourcePath, targetPath);
      manifest.utilities[name] = { sourceHash, profileFile: targetFile };
      result.copied.push(targetFile);
      continue;
    }

    const targetHash = await sha256File(targetPath);
    if (targetHash === sourceHash) {
      manifest.utilities[name] = { sourceHash, profileFile: targetFile };
      result.unchanged.push(targetFile);
      continue;
    }

    if (existingEntry && targetHash === existingEntry.sourceHash) {
      await copyFile(sourcePath, targetPath);
      manifest.utilities[name] = { sourceHash, profileFile: targetFile };
      result.copied.push(targetFile);
      continue;
    }

    const versionedFile = versionedUtilityFileName(name, sourceHash);
    await copyFile(sourcePath, path.join(utilitiesDir, versionedFile));
    manifest.utilities[name] = { sourceHash, profileFile: versionedFile, conflict: targetFile };
    result.conflicts.push(`${targetFile} preserved; using ${versionedFile}`);
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return result;
}

function bundledUtilityScriptPaths(): string[] {
  const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "utilities");
  return [
    path.join(configDir, "blackbelt-bootstrap.mjs"),
    path.join(configDir, "blackbelt-maintain.mjs"),
    path.join(configDir, "mime-bootstrap.mjs"),
    path.join(configDir, "blackbelt-pr.mjs"),
    path.join(configDir, "commit-sigil.mjs"),
    path.join(configDir, "detect-vcs.mjs"),
    path.join(configDir, "ensure-ignored.mjs"),
  ];
}

function normalizeShippedUtilityName(name: string): string {
  if (!name || name !== path.basename(name) || name.includes("/") || name.includes("\\") || !/^[A-Za-z0-9._-]+\.mjs$/.test(name)) {
    throw new Error(`Invalid shipped utility script name "${name}".`);
  }
  return name;
}

function versionedUtilityFileName(name: string, hash: string): string {
  const parsed = path.parse(name);
  return `${parsed.name}.${hash.slice(0, 12)}${parsed.ext}`;
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function readManifest(file: string): Promise<ShippedUtilityManifest> {
  if (!existsSync(file)) return { version: 1, utilities: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return normalizeManifest(parsed);
  } catch {
    return { version: 1, utilities: {} };
  }
}

function readManifestSync(file: string): ShippedUtilityManifest {
  if (!existsSync(file)) return { version: 1, utilities: {} };
  try {
    return normalizeManifest(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { version: 1, utilities: {} };
  }
}

function normalizeManifest(value: unknown): ShippedUtilityManifest {
  const manifest: ShippedUtilityManifest = { version: 1, utilities: {} };
  if (typeof value !== "object" || value === null || typeof (value as { utilities?: unknown }).utilities !== "object" || (value as { utilities?: unknown }).utilities === null) return manifest;
  for (const [name, entry] of Object.entries((value as { utilities: Record<string, unknown> }).utilities)) {
    if (typeof entry !== "object" || entry === null) continue;
    const sourceHash = (entry as { sourceHash?: unknown }).sourceHash;
    const profileFile = (entry as { profileFile?: unknown }).profileFile;
    const conflict = (entry as { conflict?: unknown }).conflict;
    if (typeof sourceHash !== "string" || typeof profileFile !== "string") continue;
    try {
      manifest.utilities[normalizeShippedUtilityName(name)] = { sourceHash, profileFile: normalizeShippedUtilityName(profileFile), ...(typeof conflict === "string" ? { conflict } : {}) };
    } catch {
      continue;
    }
  }
  return manifest;
}
