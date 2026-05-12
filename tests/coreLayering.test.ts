import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dir, "../src");
const CORE_LAYERS = ["domain", "application", "infrastructure", "schema"] as const;
const FEATURE_DIRS = ["config", "graph", "handoff", "loadout", "presentation", "runtime", "telemetry", "utilities"] as const;
const NODE_BUILTIN_PATTERN = /^(node:|fs$|path$|os$|child_process$|crypto$|process$|url$|stream$)/;
const IMPORT_PATTERN = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

type CoreLayer = (typeof CORE_LAYERS)[number];
type FeatureDir = (typeof FEATURE_DIRS)[number];

interface ImportViolation {
  file: string;
  specifier: string;
  reason: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === "webui" || entry.endsWith(".d.ts")) return [];
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

function relativeFile(file: string): string {
  return path.relative(path.resolve(import.meta.dir, ".."), file).replaceAll(path.sep, "/");
}

function layerFor(file: string): CoreLayer | FeatureDir | "plugin" | "core" {
  const rel = path.relative(SRC_ROOT, file).replaceAll(path.sep, "/");
  const first = rel.split("/")[0];
  if (CORE_LAYERS.includes(first as CoreLayer)) return first as CoreLayer;
  if (FEATURE_DIRS.includes(first as FeatureDir)) return first as FeatureDir;
  return rel === "index.ts" ? "plugin" : "core";
}

function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return resolved;
}

function importedSpecifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return Array.from(text.matchAll(IMPORT_PATTERN), (match) => match[1]);
}

function rootSourceFiles(): string[] {
  return readdirSync(SRC_ROOT)
    .map((entry) => path.join(SRC_ROOT, entry))
    .filter((file) => statSync(file).isFile() && file.endsWith(".ts"));
}

function meaningfulLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
}

function isExportStarCompatibilityShim(file: string): boolean {
  const lines = meaningfulLines(file);
  return lines.length > 0 && lines.every((line) => /^export\s+\*\s+from\s+["'][.][^"']+["'];?$/.test(line));
}

function layeringViolations(): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const file of walk(SRC_ROOT)) {
    const layer = layerFor(file);
    if (layer === "plugin" || layer === "core") continue;

    for (const specifier of importedSpecifiers(file)) {
      const target = resolveRelativeImport(file, specifier);
      const targetRel = target ? path.relative(SRC_ROOT, target).replaceAll(path.sep, "/") : specifier;
      const targetLayer = target ? layerFor(target) : undefined;
      const record = (reason: string) => violations.push({ file: relativeFile(file), specifier, reason });

      if (layer === "domain") {
        if (!specifier.startsWith(".") || NODE_BUILTIN_PATTERN.test(specifier)) record("domain must stay pure: no package, node builtin, filesystem, process, network, plugin, or persistence imports");
        else if (targetLayer !== "domain") record(`domain may only import domain modules, got ${targetRel}`);
      } else if (layer === "application") {
        if (targetLayer === "infrastructure" || targetRel.startsWith("webui/") || targetRel === "index.ts" || targetRel === "native.ts" || targetRel === "castRuntime.ts" || NODE_BUILTIN_PATTERN.test(specifier)) record(`application may depend on domain/core DTOs and ports only, got ${targetRel}`);
      } else if (layer === "infrastructure") {
        if (targetRel.startsWith("webui/") || targetRel === "index.ts" || targetRel === "native.ts" || targetRel === "castRuntime.ts" || targetRel === "pluginAdapters.ts") record(`infrastructure must not depend on WebUI, runtime facades, or plugin composition, got ${targetRel}`);
      } else if (layer === "schema") {
        if (targetLayer === "application" || targetLayer === "infrastructure" || targetRel.startsWith("webui/") || targetRel === "index.ts") record(`schema compatibility must not depend on application, infrastructure, WebUI, or plugin composition, got ${targetRel}`);
      } else if (FEATURE_DIRS.includes(layer as FeatureDir)) {
        if (targetRel.startsWith("webui/") || targetRel === "index.ts" || targetRel === "native.ts") record(`feature directories must not depend on WebUI, removed compatibility shims, or plugin composition, got ${targetRel}`);
      }
    }
  }
  return violations;
}

describe("core layering boundaries", () => {
  test("domain, application, infrastructure, and schema imports follow documented dependency direction", () => {
    expect(layeringViolations()).toEqual([]);
  });

  test("removed root native compatibility shim stays deleted", () => {
    expect(existsSync(path.join(SRC_ROOT, "native.ts"))).toBe(false);
  });

  test("base src directory does not regain export-star compatibility shims", () => {
    const shims = rootSourceFiles()
      .filter(isExportStarCompatibilityShim)
      .map(relativeFile);

    expect(shims).toEqual([]);
  });
});
