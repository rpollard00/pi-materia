import type { Loadout, LoadoutId, MateriaId, SocketId } from "../domain/loadout.js";

export const LINK_COMMAND_NAME = "/materia link" as const;
export const LINK_METADATA_VERSION = 1 as const;
export const LINK_CAST_STATE_KEY = "link" as const;
export const PREVIOUS_CAST_CONTEXT_STATE_KEY = "previousCastContext" as const;

export type LinkTargetKind = "materia" | "loadout";
export type LinkTargetPrefix = LinkTargetKind;

export interface LinkCommandInvocation {
  /** Persisted: exact command name, currently `/materia link`. */
  command: typeof LINK_COMMAND_NAME;
  /** Persisted: normalized command arguments after the `/materia link` prefix. */
  arguments: string;
  /** Persisted when available: original command text as typed by the user. */
  raw?: string;
}

export interface LinkTargetRef {
  /** Persisted in plans/lineage: zero-based target position supplied by the user. */
  order: number;
  /** Persisted: original target token, including any explicit prefix. */
  raw: string;
  /** Persisted: explicit namespace prefix when one was supplied, otherwise undefined. */
  prefix?: LinkTargetPrefix;
  /** Persisted: target name with any explicit prefix removed. */
  name: string;
}

export interface LinkCommandParseResult {
  /** Transient parser output; copied into LinkPlan when resolution succeeds. */
  invocation: LinkCommandInvocation;
  /** Transient parser output; order is explicit and stable. */
  targets: LinkTargetRef[];
  /** Transient parser output; persisted later on LinkPlan/LinkLineage. */
  prompt: string;
  /** Transient parser output; persisted later when present. */
  fromCastId?: string;
}

export interface ResolvedLinkTargetBase {
  /** Persisted: same zero-based target position as the corresponding LinkTargetRef. */
  order: number;
  /** Persisted: preserves requested target text and parsed name/prefix. */
  requested: LinkTargetRef;
  /** Persisted: resolved namespace. */
  kind: LinkTargetKind;
  /** Persisted: stable id used to resolve the target at execution time. */
  id: string;
  /** Persisted when available: user-facing target name or label. */
  displayName?: string;
}

export interface ResolvedMateriaLinkTarget extends ResolvedLinkTargetBase {
  kind: "materia";
  id: MateriaId;
}

export interface ResolvedLoadoutLinkTarget extends ResolvedLinkTargetBase {
  kind: "loadout";
  id: LoadoutId;
}

export type ResolvedLinkTarget = ResolvedMateriaLinkTarget | ResolvedLoadoutLinkTarget;

export interface LinkPlan {
  /** Persisted metadata schema version for link planning artifacts/state. */
  version: typeof LINK_METADATA_VERSION;
  /** Persisted: command invocation used to create the linked cast. */
  invocation: LinkCommandInvocation;
  /** Persisted: user prompt for the linked cast. */
  prompt: string;
  /** Persisted when present: previous cast lineage reference. */
  fromCastId?: string;
  /** Persisted: ordered resolved target sequence. */
  targets: ResolvedLinkTarget[];
  /** Persisted: created by the planner before compilation, augmented after compilation. */
  lineage: LinkLineage;
}

export interface LinkLineage {
  /** Persisted: previous cast id supplied with --from, if any. */
  fromCastId?: string;
  /** Persisted after cast creation when known: id of the linked cast. */
  castId?: string;
  /** Persisted: target ids/kinds in execution order. */
  targetSequence: ResolvedLinkTarget[];
  /** Persisted: command invocation used to create the linked run. */
  invocation: LinkCommandInvocation;
  /** Persisted after compilation: virtual loadout metadata, not a saved loadout config. */
  virtualLoadout?: VirtualLoadoutMetadata;
}

export interface VirtualLoadoutMetadata {
  /** Persisted: deterministic id for this ephemeral compiled loadout. */
  id: string;
  /** Persisted: display name for diagnostics/artifacts; not a saved loadout name. */
  name: string;
  /** Persisted: schema version for metadata, independent of loadout config schemas. */
  version: typeof LINK_METADATA_VERSION;
  /** Persisted: ordered targets used to produce the virtual loadout. */
  targets: ResolvedLinkTarget[];
  /** Persisted: node/socket remapping summary sufficient for inspection. */
  remappings: LinkTargetRemapping[];
  /** Persisted: deterministic stitching decisions between adjacent targets. */
  stitching: LinkStitchingDecision[];
}

export interface LinkTargetRemapping {
  /** Persisted: target order this remapping belongs to. */
  targetOrder: number;
  /** Persisted: original socket id from the source materia/loadout fragment. */
  fromSocketId: SocketId;
  /** Persisted: remapped socket id in the virtual loadout. */
  toSocketId: SocketId;
}

export interface LinkStitchingDecision {
  /** Persisted: source target order. */
  fromTargetOrder: number;
  /** Persisted: destination target order. */
  toTargetOrder: number;
  /** Persisted: terminal socket selected from the source fragment. */
  fromSocketId: SocketId;
  /** Persisted: entry socket selected from the destination fragment. */
  toSocketId: SocketId;
  /** Persisted: v1 only supports deterministic implicit stitching. */
  mode: "implicit-single-compatible";
}

export interface VirtualLoadoutSpec {
  /** Persisted in cast artifacts/state for inspection. */
  metadata: VirtualLoadoutMetadata;
  /** Transient runtime-only executable graph; not written as a named/default loadout. */
  loadout: Loadout;
}

export interface PreviousCastArtifactSummary {
  /** Transient bounded context: artifact path relative to the previous cast run dir. */
  path: string;
  /** Transient bounded context: artifact kind when known. */
  kind?: string;
  /** Transient bounded context: byte/character bound applied while loading. */
  maxBytes: number;
  /** Transient bounded context: true when content was shortened. */
  truncated: boolean;
  /** Transient bounded context: text preview or JSON stringification, never unbounded content. */
  content: string;
}

export interface PreviousCastContext {
  /** Transient runtime-only structured previous-cast state exposed to opt-in materia/loadouts. */
  castId: string;
  /** Transient runtime-only previous request when available. */
  request?: string;
  /** Transient runtime-only prior run directory, scoped to known artifact roots. */
  runDir?: string;
  /** Transient runtime-only previous agent handoff JSON when available; limited to the small handoff contract. */
  handoff?: PreviousCastHandoff;
  /** Transient runtime-only bounded artifact previews. */
  artifacts: PreviousCastArtifactSummary[];
  /** Transient runtime-only load timestamp for diagnostics. */
  loadedAt: number;
}

export interface PreviousCastHandoffWorkItem {
  title: string;
  context: string;
}

export interface PreviousCastHandoff {
  /** Previous agent handoff fields use the same small contract: generated work units. */
  workItems?: PreviousCastHandoffWorkItem[];
  /** Previous agent handoff fields use the same small contract: graph-control satisfaction. */
  satisfied?: boolean;
  /** Previous agent handoff fields use the same small contract: plain-text downstream context. */
  context?: string;
}

export interface LinkCastStateData {
  /** Persisted under cast state data[LINK_CAST_STATE_KEY]. */
  version: typeof LINK_METADATA_VERSION;
  /** Persisted: complete link plan metadata. */
  plan: LinkPlan;
  /** Persisted: virtual loadout metadata only, not the executable Loadout object. */
  virtualLoadout: VirtualLoadoutMetadata;
  /** Persisted: previous-cast lineage reference when supplied. */
  fromCastId?: string;
}

export interface LinkRuntimeState {
  /** Transient runtime-only expanded virtual loadout graph. */
  virtualLoadout: VirtualLoadoutSpec;
  /** Transient runtime-only bounded previous-cast context. */
  previousCastContext?: PreviousCastContext;
}
