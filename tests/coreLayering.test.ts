import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dir, "../src");
const CORE_LAYERS = ["domain", "application", "infrastructure", "schema"] as const;
const NODE_BUILTIN_PATTERN = /^(node:|fs$|path$|os$|child_process$|crypto$|process$|url$|stream$)/;
const IMPORT_PATTERN = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

type CoreLayer = (typeof CORE_LAYERS)[number];

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

function layerFor(file: string): CoreLayer | "plugin" | "core" {
  const rel = path.relative(SRC_ROOT, file).replaceAll(path.sep, "/");
  const first = rel.split("/")[0];
  return CORE_LAYERS.includes(first as CoreLayer) ? (first as CoreLayer) : rel === "index.ts" ? "plugin" : "core";
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
        if (targetLayer === "infrastructure" || targetRel.startsWith("webui/") || targetRel === "index.ts" || NODE_BUILTIN_PATTERN.test(specifier)) record(`application may depend on domain/core DTOs and ports only, got ${targetRel}`);
      } else if (layer === "infrastructure") {
        if (targetRel.startsWith("webui/") || targetRel === "index.ts") record(`infrastructure must not depend on WebUI or plugin composition, got ${targetRel}`);
      } else if (layer === "schema") {
        if (targetLayer === "application" || targetLayer === "infrastructure" || targetRel.startsWith("webui/") || targetRel === "index.ts") record(`schema compatibility must not depend on application, infrastructure, WebUI, or plugin composition, got ${targetRel}`);
      }
    }
  }
  return violations;
}

describe("core layering boundaries", () => {
  test("domain, application, infrastructure, and schema imports follow documented dependency direction", () => {
    expect(layeringViolations()).toEqual([]);
  });
});
