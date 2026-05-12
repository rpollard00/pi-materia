import { type DomainIssue, type DomainResult, ok } from "../domain/result.js";
import type { Loadout, LoadoutId, MateriaId } from "../domain/loadout.js";
import type { MateriaDefinition } from "../domain/materia.js";
import type { MateriaConfig, MateriaPipelineConfig, PiMateriaConfig } from "../types.js";
import type { LinkTargetKind, LinkTargetRef, ResolvedLinkTarget } from "./types.js";

export interface LinkTargetResolutionInput {
  /** Ordered target refs from the parser. */
  targets: LinkTargetRef[];
}

export interface LinkTargetResolutionResult {
  /** Resolved targets in the same order as the requested refs. */
  targets: ResolvedLinkTarget[];
}

export interface LinkTargetRegistry {
  getMateria(name: string): LinkMateriaResolution | undefined;
  getLoadout(name: string): LinkLoadoutResolution | undefined;
}

export interface LinkMateriaResolution {
  id: MateriaId;
  displayName?: string;
  definition?: MateriaDefinition | MateriaConfig;
}

export interface LinkLoadoutResolution {
  id: LoadoutId;
  displayName?: string;
  loadout?: Loadout | MateriaPipelineConfig;
}

export interface LinkTargetResolverOptions {
  registry: LinkTargetRegistry;
}

/**
 * Resolver boundary for `/materia link`.
 *
 * Responsibility: map parsed target refs to materia/loadout identities without
 * mutating the active/default loadout or touching runtime cast state.
 */
export interface LinkTargetResolver {
  resolve(input: LinkTargetResolutionInput): Promise<DomainResult<LinkTargetResolutionResult>> | DomainResult<LinkTargetResolutionResult>;
}

export type ResolveLinkTargets = LinkTargetResolver["resolve"];

export function createLinkTargetResolver(options: LinkTargetResolverOptions): LinkTargetResolver {
  return { resolve: (input) => resolveLinkTargets(input, options.registry) };
}

export function createConfigLinkTargetRegistry(input: Pick<PiMateriaConfig, "materia" | "loadouts">): LinkTargetRegistry {
  const materia = input.materia ?? {};
  const loadouts = input.loadouts ?? {};
  return {
    getMateria: (name) => {
      const definition = materia[name];
      if (!definition) return undefined;
      const id = materiaDefinitionId(name, definition);
      return { id, displayName: materiaDisplayName(id, definition), definition };
    },
    getLoadout: (name) => {
      const loadout = loadouts[name];
      return loadout ? { id: loadoutId(name, loadout), displayName: name, loadout } : undefined;
    },
  };
}

export function resolveLinkTargets(input: LinkTargetResolutionInput, registry: LinkTargetRegistry): DomainResult<LinkTargetResolutionResult> {
  const issues: DomainIssue[] = [];
  const resolved: ResolvedLinkTarget[] = [];

  input.targets.forEach((target, index) => {
    const path = `link.targets.${index}`;
    if (target.order !== index) issues.push({ path: `${path}.order`, message: `target order must match target position ${index}` });

    const match = resolveTarget(target, registry, path, issues);
    if (!match) return;
    resolved.push({
      order: target.order,
      requested: target,
      kind: match.kind,
      id: match.id,
      ...(match.displayName ? { displayName: match.displayName } : {}),
    } as ResolvedLinkTarget);
  });

  return issues.length > 0 ? { ok: false, issues } : ok({ targets: resolved });
}

interface ResolvedMatch {
  kind: LinkTargetKind;
  id: string;
  displayName?: string;
}

function materiaDefinitionId(name: string, definition: MateriaDefinition | MateriaConfig): MateriaId {
  const candidate = (definition as { id?: unknown }).id;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : name;
}

function materiaDisplayName(id: string, definition: MateriaDefinition | MateriaConfig): string {
  const behaviorLabel = (definition as { behavior?: { label?: unknown } }).behavior?.label;
  const configLabel = (definition as { label?: unknown }).label;
  return (typeof behaviorLabel === "string" && behaviorLabel.trim().length > 0 ? behaviorLabel : undefined)
    ?? (typeof configLabel === "string" && configLabel.trim().length > 0 ? configLabel : undefined)
    ?? id;
}

function loadoutId(name: string, loadout: Loadout | MateriaPipelineConfig): LoadoutId {
  return "id" in loadout && typeof loadout.id === "string" && loadout.id.trim().length > 0 ? loadout.id : name;
}

function resolveTarget(target: LinkTargetRef, registry: LinkTargetRegistry, path: string, issues: DomainIssue[]): ResolvedMatch | undefined {
  if (target.prefix === "materia") {
    const materia = registry.getMateria(target.name);
    if (!materia) {
      issues.push({ path, message: `unknown materia target ${JSON.stringify(target.name)}; check the name or use loadout:${target.name} if this is a loadout` });
      return undefined;
    }
    return { kind: "materia", id: materia.id, ...(materia.displayName ? { displayName: materia.displayName } : {}) };
  }

  if (target.prefix === "loadout") {
    const loadout = registry.getLoadout(target.name);
    if (!loadout) {
      issues.push({ path, message: `unknown loadout target ${JSON.stringify(target.name)}; check the name or use materia:${target.name} if this is a materia` });
      return undefined;
    }
    return { kind: "loadout", id: loadout.id, ...(loadout.displayName ? { displayName: loadout.displayName } : {}) };
  }

  const materia = registry.getMateria(target.name);
  const loadout = registry.getLoadout(target.name);
  if (materia && loadout) {
    issues.push({ path, message: `ambiguous link target ${JSON.stringify(target.name)} matches both a materia and a loadout; use materia:${target.name} or loadout:${target.name}` });
    return undefined;
  }
  if (materia) return { kind: "materia", id: materia.id, ...(materia.displayName ? { displayName: materia.displayName } : {}) };
  if (loadout) return { kind: "loadout", id: loadout.id, ...(loadout.displayName ? { displayName: loadout.displayName } : {}) };

  issues.push({ path, message: `unknown link target ${JSON.stringify(target.name)}; use materia:<name> or loadout:<name> to disambiguate explicit targets` });
  return undefined;
}
