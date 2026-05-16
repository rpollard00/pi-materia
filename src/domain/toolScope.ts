export const TOOL_SCOPE_PRESETS = ["none", "readOnly", "coding"] as const;
export type ToolScopePreset = typeof TOOL_SCOPE_PRESETS[number];

export interface ToolScopePresetOption {
  readonly value: ToolScopePreset;
  readonly label: string;
  readonly description: string;
}

export const TOOL_SCOPE_PRESET_OPTIONS: readonly ToolScopePresetOption[] = Object.freeze([
  Object.freeze({ value: "coding", label: "Build", description: "All available Pi tools for code-producing agent work." }),
  Object.freeze({ value: "readOnly", label: "Read-Only", description: "Read project files and search without direct edit/write tools." }),
  Object.freeze({ value: "none", label: "None", description: "No Pi tools are enabled." }),
]);

export interface ToolScopeToolOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly warning?: string;
}

export const TOOL_SCOPE_TOOL_OPTIONS: readonly ToolScopeToolOption[] = Object.freeze([
  Object.freeze({ value: "read", label: "Read file", description: "Read text files and supported images." }),
  Object.freeze({ value: "grep", label: "Search contents", description: "Search file contents for matching lines." }),
  Object.freeze({ value: "find", label: "Find files", description: "Find files by glob pattern." }),
  Object.freeze({ value: "ls", label: "List directory", description: "List directory contents." }),
  Object.freeze({ value: "bash", label: "Run command", description: "Run shell commands such as tests.", warning: "Command execution is powerful and can mutate files; it is not a strict sandbox." }),
  Object.freeze({ value: "edit", label: "Edit file", description: "Modify files with targeted replacements." }),
  Object.freeze({ value: "write", label: "Write file", description: "Create or overwrite files." }),
]);

export const TOOL_SCOPE_TOOL_NAMES = TOOL_SCOPE_TOOL_OPTIONS.map((option) => option.value);

export const TOOL_SCOPE_BASH_WARNING = "Command execution is powerful and can mutate files; it is not a strict sandbox.";

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
  /** Active tool names to pass to Pi at runtime. Kept for backward-compatible callers. */
  readonly tools: readonly string[];
  /** Tool names exactly configured by a custom scope; empty for presets. */
  readonly configuredTools: readonly string[];
  /** Deduped tool names currently available for activation. */
  readonly activeTools: readonly string[];
  /** Deduped configured custom names that are not currently available. */
  readonly unavailableTools: readonly string[];
  /** Soft availability warnings. Malformed scope errors are reported as issues instead. */
  readonly warnings: readonly string[];
}

export interface ToolScopeIssue {
  path: string;
  message: string;
}

export type ToolScopeResolution = { ok: true; value: ResolvedToolScope } | { ok: false; issues: ToolScopeIssue[] };

export function resolveToolScope(spec: unknown, availableToolNames?: readonly string[], path = "tools"): ToolScopeResolution {
  const shape = validateToolScopeSpecShape(spec, path);
  if (!shape.ok) return shape;

  const shapedSpec = shape.value;
  const hasAvailableRegistry = availableToolNames !== undefined;
  const available = [...(availableToolNames ?? [])];
  const availableSet = new Set(available);

  if (isToolScopePreset(shapedSpec)) {
    const tools = shapedSpec === "none"
      ? []
      : shapedSpec === "readOnly"
        ? available.filter((name) => (READ_ONLY_TOOL_NAMES as readonly string[]).includes(name))
        : available;
    return { ok: true, value: freezeResolvedToolScope({ spec: shapedSpec, source: "preset", tools, configuredTools: [], activeTools: tools, unavailableTools: [], warnings: [] }) };
  }

  const configuredTools = [...shapedSpec.tools];
  const activeTools = hasAvailableRegistry
    ? uniqueInOrder(configuredTools.filter((tool) => availableSet.has(tool)))
    : uniqueInOrder(configuredTools);
  const unavailableTools = hasAvailableRegistry
    ? uniqueInOrder(configuredTools.filter((tool) => !availableSet.has(tool)))
    : [];
  const warnings = unavailableTools.length > 0
    ? [`Unavailable custom tool name(s) will be skipped at runtime until registered: ${unavailableTools.join(", ")}`]
    : [];

  return {
    ok: true,
    value: freezeResolvedToolScope({
      spec: { type: "custom", tools: configuredTools },
      source: "custom",
      tools: activeTools,
      configuredTools,
      activeTools,
      unavailableTools,
      warnings,
    }),
  };
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

function uniqueInOrder(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  return unique;
}

function freezeResolvedToolScope(scope: {
  spec: ToolScopeSpec;
  source: ResolvedToolScope["source"];
  tools: string[];
  configuredTools: string[];
  activeTools: string[];
  unavailableTools: string[];
  warnings: string[];
}): ResolvedToolScope {
  const spec = typeof scope.spec === "string" ? scope.spec : Object.freeze({ type: "custom" as const, tools: Object.freeze([...scope.spec.tools]) });
  return Object.freeze({
    spec,
    source: scope.source,
    tools: Object.freeze([...scope.tools]),
    configuredTools: Object.freeze([...scope.configuredTools]),
    activeTools: Object.freeze([...scope.activeTools]),
    unavailableTools: Object.freeze([...scope.unavailableTools]),
    warnings: Object.freeze([...scope.warnings]),
  });
}

function formatValidScopeShapes(): string {
  return '"none", "readOnly", "coding", or { type: "custom", tools: string[] }';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
