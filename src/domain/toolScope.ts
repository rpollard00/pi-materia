export const TOOL_SCOPE_PRESETS = ["none", "readOnly", "coding"] as const;
export type ToolScopePreset = typeof TOOL_SCOPE_PRESETS[number];

export interface ToolScopePresetOption {
  readonly value: ToolScopePreset;
  readonly label: string;
}

export const TOOL_SCOPE_PRESET_OPTIONS: readonly ToolScopePresetOption[] = Object.freeze([
  Object.freeze({ value: "none", label: "none" }),
  Object.freeze({ value: "readOnly", label: "read only" }),
  Object.freeze({ value: "coding", label: "coding" }),
]);

export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export type ReadOnlyToolName = typeof READ_ONLY_TOOL_NAMES[number];

export interface CustomToolScopeSpec {
  type: "custom";
  tools: readonly string[];
}

export type ToolScopeSpec = ToolScopePreset | CustomToolScopeSpec;

export interface ResolvedToolScope {
  readonly spec: ToolScopeSpec;
  readonly source: "preset" | "custom";
  readonly tools: readonly string[];
}

export interface ToolScopeIssue {
  path: string;
  message: string;
}

export type ToolScopeResolution = { ok: true; value: ResolvedToolScope } | { ok: false; issues: ToolScopeIssue[] };

export function resolveToolScope(spec: ToolScopeSpec, availableToolNames: readonly string[], path = "tools"): ToolScopeResolution {
  const available = [...availableToolNames];
  const availableSet = new Set(available);

  if (isToolScopePreset(spec)) {
    const tools = spec === "none"
      ? []
      : spec === "readOnly"
        ? available.filter((name) => (READ_ONLY_TOOL_NAMES as readonly string[]).includes(name))
        : available;
    return { ok: true, value: freezeResolvedToolScope({ spec, source: "preset", tools }) };
  }

  const validation = validateCustomToolScopeSpec(spec, availableSet, path);
  if (!validation.ok) return validation;

  const requested = new Set(spec.tools);
  const tools = available.filter((name) => requested.has(name));
  return { ok: true, value: freezeResolvedToolScope({ spec: { type: "custom", tools: Object.freeze([...requested]) }, source: "custom", tools }) };
}

export type ToolScopeSpecShapeValidation = { ok: true; value: ToolScopeSpec } | { ok: false; issues: ToolScopeIssue[] };

export function validateToolScopeSpecShape(value: unknown, path = "tools"): ToolScopeSpecShapeValidation {
  if (isToolScopePreset(value)) return { ok: true, value };
  if (!isPlainObject(value)) {
    return { ok: false, issues: [{ path, message: `tool scope must be one of ${formatValidScopeShapes()}` }] };
  }
  if (value.type !== "custom") {
    return { ok: false, issues: [{ path: `${path}.type`, message: 'custom tool scope type must be "custom"' }] };
  }
  if (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string" && tool.trim().length > 0)) {
    return { ok: false, issues: [{ path: `${path}.tools`, message: "custom tool scope tools must be an array of non-empty tool names" }] };
  }
  return { ok: true, value: { type: "custom", tools: Object.freeze([...value.tools]) } };
}

export function isToolScopePreset(value: unknown): value is ToolScopePreset {
  return value === "none" || value === "readOnly" || value === "coding";
}

export function formatToolScopeSpec(spec: ToolScopeSpec): string {
  return typeof spec === "string" ? spec : `custom(${spec.tools.join(",")})`;
}

export function validToolScopeShapeDescription(): string {
  return formatValidScopeShapes();
}

function validateCustomToolScopeSpec(spec: CustomToolScopeSpec, availableSet: ReadonlySet<string>, path: string): { ok: true } | { ok: false; issues: ToolScopeIssue[] } {
  const shape = validateToolScopeSpecShape(spec, path);
  if (!shape.ok) return shape;
  const invalid = [...new Set(spec.tools)].filter((tool) => !availableSet.has(tool));
  if (invalid.length > 0) {
    const valid = [...availableSet].sort().join(", ") || "none";
    return { ok: false, issues: [{ path: `${path}.tools`, message: `unknown tool name(s): ${invalid.join(", ")}. Valid tools: ${valid}` }] };
  }
  return { ok: true };
}

function freezeResolvedToolScope(scope: { spec: ToolScopeSpec; source: ResolvedToolScope["source"]; tools: string[] }): ResolvedToolScope {
  const spec = typeof scope.spec === "string" ? scope.spec : Object.freeze({ type: "custom" as const, tools: Object.freeze([...scope.spec.tools]) });
  return Object.freeze({ spec, source: scope.source, tools: Object.freeze([...scope.tools]) });
}

function formatValidScopeShapes(): string {
  return '"none", "readOnly", "coding", or { type: "custom", tools: string[] }';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
