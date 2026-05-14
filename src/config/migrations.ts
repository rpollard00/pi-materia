import { makeDuplicateLoadoutName } from "../loadout/loadoutNames.js";
import type { MateriaConfigLayerScope, MateriaProfileConfig, PiMateriaConfig, PiMateriaSchemaMigrationAudit } from "../types.js";

export const LOADOUT_CONFIG_MIGRATIONS = [
  { id: "001-rename-non-default-loadout-collisions", migrate: renameNonDefaultLoadoutCollisions },
  { id: "002-stamp-stable-loadout-ids", migrate: stampStableLoadoutIds },
] as const satisfies readonly ConfigMigration[];

export type LoadoutConfigMigrationId = (typeof LOADOUT_CONFIG_MIGRATIONS)[number]["id"];
export const CURRENT_PI_MATERIA_SCHEMA_VERSION = LOADOUT_CONFIG_MIGRATIONS.length;

export interface ConfigMigration {
  id: `${number}-${string}`;
  migrate(context: ConfigMigrationContext): void;
}

export interface MigratableConfigLayer {
  scope: MateriaConfigLayerScope;
  path: string;
  loaded: boolean;
  config: Partial<PiMateriaConfig>;
  changed?: boolean;
}

export interface ConfigMigrationContext {
  layers: MigratableConfigLayer[];
  profile?: MateriaProfileConfig;
  profileChanged?: boolean;
  audit: Record<string, string[]>;
  profileAudit: string[];
}

export function assertValidMigrationRegistry(registry: readonly ConfigMigration[] = LOADOUT_CONFIG_MIGRATIONS): void {
  const ids = registry.map((migration) => migration.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate pi-materia migration id: ${id}`);
    seen.add(id);
    if (!/^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid pi-materia migration id: ${id}`);
  }
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  if (ids.some((id, index) => id !== sorted[index])) throw new Error("pi-materia migrations must remain sorted and append-only by id.");
}

export function migrateConfigLayers(layers: MigratableConfigLayer[], profile?: MateriaProfileConfig): ConfigMigrationContext {
  assertValidMigrationRegistry();
  const context: ConfigMigrationContext = { layers, profile, audit: {}, profileAudit: [] };
  for (const migration of LOADOUT_CONFIG_MIGRATIONS) migration.migrate(context);
  for (const layer of layers) {
    if (layer.loaded && shouldStampConfig(layer.config)) {
      stampConfig(layer.config, context.audit[layer.path] ?? []);
      layer.changed = true;
    }
  }
  if (profile && shouldStampConfig(profile)) {
    stampConfig(profile, context.profileAudit);
    context.profileChanged = true;
  }
  return context;
}

export function stampConfig(config: Partial<PiMateriaConfig> | MateriaProfileConfig, changes: string[] = [], now = new Date()): void {
  const appliedAt = now.toISOString();
  const existing = Array.isArray(config.piMateria?.migrations) ? config.piMateria.migrations : [];
  const existingIds = new Set(existing.map((migration) => migration.id));
  const migrations: PiMateriaSchemaMigrationAudit[] = [...existing];
  for (const migration of LOADOUT_CONFIG_MIGRATIONS) {
    if (!existingIds.has(migration.id)) migrations.push({ id: migration.id, appliedAt, ...(changes.length > 0 ? { changes: [...changes] } : {}) });
  }
  config.piMateria = { ...(config.piMateria ?? {}), schemaVersion: CURRENT_PI_MATERIA_SCHEMA_VERSION, migrations };
}

export function ensureCurrentSchemaMetadata<T extends Partial<PiMateriaConfig> | MateriaProfileConfig>(config: T): T {
  stampConfig(config);
  return config;
}

export function ensureStableLoadoutIds(config: Partial<PiMateriaConfig>, scope: MateriaConfigLayerScope): void {
  if (!isPlainObject(config.loadouts)) return;
  for (const [displayName, loadout] of Object.entries(config.loadouts as Record<string, unknown>)) {
    if (!isPlainObject(loadout)) continue;
    const id = typeof loadout.id === "string" ? loadout.id.trim() : "";
    if (!id) loadout.id = stableLoadoutId(scope, displayName);
  }
  const activeName = config.activeLoadout;
  if (typeof activeName === "string" && typeof config.activeLoadoutId !== "string") {
    const active = (config.loadouts as Record<string, unknown>)[activeName];
    if (isPlainObject(active) && typeof active.id === "string" && active.id.trim()) config.activeLoadoutId = active.id;
  }
}

export function validateNoDuplicateLoadoutOwnership(layers: Array<Pick<MigratableConfigLayer, "scope" | "config">>): void {
  const owners = new Map<string, MateriaConfigLayerScope>();
  for (const layer of layers) {
    if (!isPlainObject(layer.config.loadouts)) continue;
    for (const [name, loadout] of Object.entries(layer.config.loadouts as Record<string, unknown>)) {
      if (loadout === null) continue;
      if (!isPlainObject(loadout)) continue;
      const existing = owners.get(name);
      if (existing && existing !== layer.scope) throw new Error(`Materia loadout "${name}" is already owned by ${existing} scope; choose a unique name before saving to ${layer.scope}.`);
      owners.set(name, layer.scope);
    }
  }
}

function renameNonDefaultLoadoutCollisions(context: ConfigMigrationContext): void {
  const usedNames = new Set<string>();
  const renamedByOriginal = new Map<string, string[]>();
  const renamedByLayer = new Map<string, Map<string, string>>();
  const activeReferences: Array<{ layer: MigratableConfigLayer; activeLoadout: string }> = [];

  for (const layer of context.layers) {
    if (!layer.loaded || !isPlainObject(layer.config.loadouts)) continue;
    const originalLoadouts = layer.config.loadouts as Record<string, unknown>;
    const layerNames = new Set(Object.entries(originalLoadouts).filter(([, loadout]) => isPlainObject(loadout)).map(([name]) => name));
    const nextLoadouts: Record<string, unknown> = {};
    let changed = false;
    for (const [name, loadout] of Object.entries(originalLoadouts)) {
      if (loadout === null || !isPlainObject(loadout)) {
        nextLoadouts[name] = loadout;
        continue;
      }
      const shouldPreserveName = layer.scope === "default" || !usedNames.has(name);
      const reservedNames = new Set([...usedNames, ...layerNames]);
      const nextName = shouldPreserveName ? name : makeDuplicateLoadoutName(reservedNames, name);
      nextLoadouts[nextName] = loadout;
      usedNames.add(nextName);
      if (nextName !== name) {
        changed = true;
        const changes = context.audit[layer.path] ?? [];
        changes.push(`renamed loadout ${name} to ${nextName} to avoid ${layer.scope} ownership collision`);
        context.audit[layer.path] = changes;
        renamedByOriginal.set(name, [...(renamedByOriginal.get(name) ?? []), nextName]);
        const layerRenames = renamedByLayer.get(layer.path) ?? new Map<string, string>();
        layerRenames.set(name, nextName);
        renamedByLayer.set(layer.path, layerRenames);
      }
    }
    if (changed) {
      layer.config.loadouts = nextLoadouts as PiMateriaConfig["loadouts"];
      const active = layer.config.activeLoadout;
      if (typeof active === "string") activeReferences.push({ layer, activeLoadout: active });
      layer.changed = true;
    }
  }

  for (const reference of activeReferences) {
    const layerCandidate = renamedByLayer.get(reference.layer.path)?.get(reference.activeLoadout);
    const candidates = layerCandidate ? [layerCandidate] : (renamedByOriginal.get(reference.activeLoadout) ?? []);
    if (candidates.length === 1) {
      reference.layer.config.activeLoadout = candidates[0];
      context.audit[reference.layer.path]?.push(`repointed activeLoadout from ${reference.activeLoadout} to ${candidates[0]}`);
    }
  }

  const defaultLoadoutId = context.profile?.defaultLoadoutId;
  if (typeof defaultLoadoutId === "string") {
    const candidates = renamedByOriginal.get(defaultLoadoutId) ?? [];
    if (candidates.length === 1 && context.profile) {
      const candidate = findLoadoutByDisplayName(context.layers, candidates[0]);
      const candidateId = candidate ? loadoutStableId(candidate.scope, candidates[0], candidate.loadout) : undefined;
      if (candidateId) {
        context.profile.defaultLoadoutId = candidateId;
        context.profileChanged = true;
        context.profileAudit.push(`repointed defaultLoadoutId from ${defaultLoadoutId} to ${candidateId}`);
      }
    }
  }
}

function stampStableLoadoutIds(context: ConfigMigrationContext): void {
  for (const layer of context.layers) {
    if (!layer.loaded || !isPlainObject(layer.config.loadouts)) continue;
    for (const [displayName, loadout] of Object.entries(layer.config.loadouts as Record<string, unknown>)) {
      if (!isPlainObject(loadout)) continue;
      const id = typeof loadout.id === "string" ? loadout.id.trim() : "";
      if (id) continue;
      ensureStableLoadoutIds({ loadouts: { [displayName]: loadout } as unknown as PiMateriaConfig["loadouts"] }, layer.scope);
      layer.changed = true;
      const changes = context.audit[layer.path] ?? [];
      changes.push(`assigned stable loadout id ${loadout.id} to ${displayName}`);
      context.audit[layer.path] = changes;
    }
    const activeName = layer.config.activeLoadout;
    if (typeof activeName === "string" && typeof layer.config.activeLoadoutId !== "string") {
      const active = (layer.config.loadouts as Record<string, unknown>)[activeName];
      if (isPlainObject(active) && typeof active.id === "string" && active.id.trim()) {
        layer.config.activeLoadoutId = active.id;
        layer.changed = true;
        const changes = context.audit[layer.path] ?? [];
        changes.push(`repointed activeLoadoutId for ${activeName} to ${active.id}`);
        context.audit[layer.path] = changes;
      }
    }
  }

  const defaultLoadoutId = context.profile?.defaultLoadoutId;
  if (typeof defaultLoadoutId === "string" && context.profile) {
    const candidates = findLoadoutIdCandidates(context.layers, defaultLoadoutId);
    if (candidates.length === 1 && candidates[0] !== defaultLoadoutId) {
      context.profile.defaultLoadoutId = candidates[0];
      context.profileChanged = true;
      context.profileAudit.push(`repointed defaultLoadoutId from ${defaultLoadoutId} to ${candidates[0]}`);
    }
  }
}

function findLoadoutByDisplayName(layers: MigratableConfigLayer[], displayName: string): { scope: MateriaConfigLayerScope; loadout: Record<string, unknown> } | undefined {
  for (const layer of layers) {
    const loadout = isPlainObject(layer.config.loadouts) ? (layer.config.loadouts as Record<string, unknown>)[displayName] : undefined;
    if (isPlainObject(loadout)) return { scope: layer.scope, loadout };
  }
  return undefined;
}

function findLoadoutIdCandidates(layers: MigratableConfigLayer[], reference: string): string[] {
  const candidates = new Set<string>();
  for (const layer of layers) {
    if (!layer.loaded || !isPlainObject(layer.config.loadouts)) continue;
    for (const [displayName, loadout] of Object.entries(layer.config.loadouts as Record<string, unknown>)) {
      if (!isPlainObject(loadout)) continue;
      const id = loadoutStableId(layer.scope, displayName, loadout);
      if (reference === displayName || reference === id) candidates.add(id);
    }
  }
  return [...candidates];
}

function loadoutStableId(scope: MateriaConfigLayerScope, displayName: string, loadout: Record<string, unknown>): string {
  const id = typeof loadout.id === "string" ? loadout.id.trim() : "";
  return id || stableLoadoutId(scope, displayName);
}

function stableLoadoutId(scope: MateriaConfigLayerScope, displayName: string): string {
  const slug = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "loadout";
  return `${scope}:${slug}`;
}

function shouldStampConfig(config: Partial<PiMateriaConfig> | MateriaProfileConfig): boolean {
  if (config.piMateria?.schemaVersion !== CURRENT_PI_MATERIA_SCHEMA_VERSION || !Array.isArray(config.piMateria?.migrations)) return true;
  const applied = new Set(config.piMateria.migrations.map((migration) => migration.id));
  return LOADOUT_CONFIG_MIGRATIONS.some((migration) => !applied.has(migration.id));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
