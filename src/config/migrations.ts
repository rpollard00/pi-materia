import { makeDuplicateLoadoutName } from "../loadout/loadoutNames.js";
import type { LoadoutSource, LoadoutUserLockState, MateriaConfigLayerScope, MateriaProfileConfig, PiMateriaConfig } from "../types.js";

interface PiMateriaSchemaMigrationAudit {
  id: string;
  appliedAt: string;
  changes?: string[];
}

interface MigrationMetadataContainer {
  piMateria?: {
    schemaVersion?: number;
    migrations?: PiMateriaSchemaMigrationAudit[];
  };
}


export const LOADOUT_CONFIG_MIGRATIONS = [
  { id: "001-rename-non-default-loadout-collisions", migrate: renameNonDefaultLoadoutCollisions },
  { id: "002-stamp-stable-loadout-ids", migrate: stampStableLoadoutIds },
  { id: "003-stamp-loadout-ownership-and-locks", migrate: stampLoadoutOwnershipAndLocks },
  { id: "004-canonicalize-utility-sockets", migrate: canonicalizeUtilitySockets },
  { id: "005-stamp-explicit-materia-types", migrate: stampExplicitMateriaTypes },
  { id: "006-repoint-legacy-default-materia-aliases", migrate: repointLegacyDefaultMateriaAliases },
  { id: "007-repoint-legacy-utility-materia-identities", migrate: repointLegacyUtilityMateriaIdentities },
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
  const target = config as MigrationMetadataContainer;
  const appliedAt = now.toISOString();
  const existing = Array.isArray(target.piMateria?.migrations) ? target.piMateria.migrations : [];
  const existingIds = new Set(existing.map((migration) => migration.id));
  const migrations: PiMateriaSchemaMigrationAudit[] = [...existing];
  for (const migration of LOADOUT_CONFIG_MIGRATIONS) {
    if (!existingIds.has(migration.id)) migrations.push({ id: migration.id, appliedAt, ...(changes.length > 0 ? { changes: [...changes] } : {}) });
  }
  target.piMateria = { ...(target.piMateria ?? {}), schemaVersion: CURRENT_PI_MATERIA_SCHEMA_VERSION, migrations };
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

export function ensureLoadoutOwnershipAndLocks(config: Partial<PiMateriaConfig>, scope: MateriaConfigLayerScope): void {
  if (!isPlainObject(config.loadouts)) return;
  for (const loadout of Object.values(config.loadouts as Record<string, unknown>)) {
    if (!isPlainObject(loadout)) continue;
    loadout.source = scope;
    if (scope === "default") delete loadout.lockState;
    else if (!isLoadoutLockState(loadout.lockState)) loadout.lockState = "unlocked";
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
  // This is the load-time identity boundary for legacy configs: after this
  // migration, current-format code should treat loadout.id as canonical and
  // avoid falling back to display names or object keys for active/default state.
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

function stampLoadoutOwnershipAndLocks(context: ConfigMigrationContext): void {
  for (const layer of context.layers) {
    if (!layer.loaded || !isPlainObject(layer.config.loadouts)) continue;
    for (const [displayName, loadout] of Object.entries(layer.config.loadouts as Record<string, unknown>)) {
      if (!isPlainObject(loadout)) continue;
      const changes: string[] = [];
      if (!isLoadoutSource(loadout.source)) {
        loadout.source = layer.scope;
        changes.push(`assigned ${layer.scope} ownership to ${displayName}`);
      }
      if (layer.scope !== "default" && !isLoadoutLockState(loadout.lockState)) {
        loadout.lockState = "unlocked";
        changes.push(`initialized ${displayName} lockState to unlocked`);
      }
      if (layer.scope === "default" && loadout.lockState !== undefined) {
        delete loadout.lockState;
        changes.push(`removed persisted lockState from readonly default ${displayName}`);
      }
      if (changes.length > 0) {
        layer.changed = true;
        context.audit[layer.path] = [...(context.audit[layer.path] ?? []), ...changes];
      }
    }
  }
}

function canonicalizeUtilitySockets(context: ConfigMigrationContext): void {
  for (const layer of context.layers) {
    if (!layer.loaded || !isPlainObject(layer.config.loadouts)) continue;
    const existingMateria = isPlainObject(layer.config.materia) ? layer.config.materia as Record<string, unknown> : {};
    const signatureToId = new Map<string, string>();
    for (const [id, definition] of Object.entries(existingMateria)) {
      if (isUtilityMateriaDefinition(definition)) signatureToId.set(utilitySignature(definition), id);
    }

    for (const [loadoutName, loadout] of Object.entries(layer.config.loadouts as Record<string, unknown>)) {
      if (!isPlainObject(loadout) || !isPlainObject(loadout.sockets)) continue;
      for (const [socketId, rawSocket] of Object.entries(loadout.sockets)) {
        if (!isPlainObject(rawSocket) || rawSocket.type !== "utility") continue;
        const legacySignature = utilitySocketSignature(rawSocket);
        const canonicalMateria = typeof rawSocket.materia === "string" && rawSocket.materia.trim() ? rawSocket.materia : undefined;
        const materia = isPlainObject(layer.config.materia) ? layer.config.materia as Record<string, unknown> : ensureMateriaObject(layer.config);
        const mappedId = canonicalMateria ?? findCanonicalUtilityMateriaId(legacySignature, materia, signatureToId);
        const materiaId = mappedId ?? hoistLegacyUtilityMateria(materia, signatureToId, legacySignature);
        const materiaChanged = rawSocket.materia !== materiaId;
        const stripped = stripInlineUtilityFields(rawSocket);
        const changed = materiaChanged || stripped;
        rawSocket.materia = materiaId;
        if (changed) {
          layer.changed = true;
          const changes = context.audit[layer.path] ?? [];
          changes.push(`canonicalized utility socket ${loadoutName}.${socketId} to materia ${materiaId}`);
          context.audit[layer.path] = changes;
        }
      }
    }
  }
}

interface UtilitySignature {
  utility?: string;
  command?: string[];
  script?: unknown;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  parse?: string;
  assign?: Record<string, string>;
}

function ensureMateriaObject(config: Partial<PiMateriaConfig>): Record<string, unknown> {
  if (!isPlainObject(config.materia)) config.materia = {} as PiMateriaConfig["materia"];
  return config.materia as Record<string, unknown>;
}

function isUtilityMateriaDefinition(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && value.type === "utility";
}

function utilitySocketSignature(socket: Record<string, unknown>): UtilitySignature {
  return cleanSignature({
    ...(typeof socket.utility === "string" ? { utility: socket.utility } : {}),
    ...(Array.isArray(socket.command) && socket.command.every((part) => typeof part === "string") ? { command: [...socket.command] as string[] } : {}),
    ...(typeof socket.script === "string" || isPlainObject(socket.script) ? { script: clonePlain(socket.script) } : {}),
    ...(isPlainObject(socket.params) ? { params: clonePlain(socket.params) } : {}),
    ...(typeof socket.timeoutMs === "number" ? { timeoutMs: socket.timeoutMs } : {}),
    ...(typeof socket.parse === "string" ? { parse: socket.parse } : {}),
    ...(isStringRecord(socket.assign) ? { assign: { ...socket.assign } } : {}),
  });
}

function utilitySignature(definition: Record<string, unknown>): string {
  return stableStringify(cleanSignature({
    ...(typeof definition.utility === "string" ? { utility: definition.utility } : {}),
    ...(Array.isArray(definition.command) && definition.command.every((part) => typeof part === "string") ? { command: [...definition.command] as string[] } : {}),
    ...(typeof definition.script === "string" || isPlainObject(definition.script) ? { script: clonePlain(definition.script) } : {}),
    ...(isPlainObject(definition.params) ? { params: clonePlain(definition.params) } : {}),
    ...(typeof definition.timeoutMs === "number" ? { timeoutMs: definition.timeoutMs } : {}),
    ...(typeof definition.parse === "string" ? { parse: definition.parse } : {}),
    ...(isStringRecord(definition.assign) ? { assign: { ...definition.assign } } : {}),
  }));
}

function findCanonicalUtilityMateriaId(signature: UtilitySignature, materia: Record<string, unknown>, signatureToId: Map<string, string>): string | undefined {
  const signatureKey = stableStringify(signature);
  const knownAliasId = knownDefaultUtilityMateriaId(signature);
  if (knownAliasId) {
    const localDefinition = materia[knownAliasId];
    if (localDefinition === undefined) return knownAliasId;
    if (isUtilityMateriaDefinition(localDefinition) && utilitySignature(localDefinition) === signatureKey) return knownAliasId;
  }
  return signatureToId.get(signatureKey);
}

function knownDefaultUtilityMateriaId(signature: UtilitySignature): string | undefined {
  const signatureKey = stableStringify(signature);
  if (signature.utility === "project.ensureIgnored" && signatureKey === stableStringify(defaultEnsureIgnoredSignature())) return "ensureArtifactsIgnored";
  if (signature.utility === "vcs.detect" && signatureKey === stableStringify(defaultDetectVcsSignature())) return "detectVcs";
  return undefined;
}

function defaultEnsureIgnoredSignature(): UtilitySignature {
  return { utility: "project.ensureIgnored", params: { patterns: [".pi/pi-materia/"] }, parse: "json", assign: { artifactIgnore: "$" } };
}

function defaultDetectVcsSignature(): UtilitySignature {
  return { utility: "vcs.detect", parse: "json", assign: { vcs: "$" } };
}

function stampExplicitMateriaTypes(context: ConfigMigrationContext): void {
  for (const layer of context.layers) {
    if (!layer.loaded || !isPlainObject(layer.config.materia)) continue;
    for (const [id, definition] of Object.entries(layer.config.materia as Record<string, unknown>)) {
      if (!isPlainObject(definition) || definition.type !== undefined) continue;
      definition.type = "agent";
      layer.changed = true;
      const changes = context.audit[layer.path] ?? [];
      changes.push(`stamped explicit agent type on materia ${id}`);
      context.audit[layer.path] = changes;
    }
  }
}

function repointLegacyDefaultMateriaAliases(context: ConfigMigrationContext): void {
  const aliases: Record<string, string> = { planner: "Auto-Plan", interactivePlan: "Interactive-Plan" };
  for (const layer of context.layers) {
    if (!layer.loaded || !isPlainObject(layer.config.loadouts)) continue;
    for (const [loadoutName, loadout] of Object.entries(layer.config.loadouts as Record<string, unknown>)) {
      if (!isPlainObject(loadout) || !isPlainObject(loadout.sockets)) continue;
      for (const [socketId, socket] of Object.entries(loadout.sockets)) {
        if (!isPlainObject(socket) || typeof socket.materia !== "string") continue;
        const next = aliases[socket.materia];
        if (!next) continue;
        socket.materia = next;
        layer.changed = true;
        const changes = context.audit[layer.path] ?? [];
        changes.push(`repointed legacy materia alias ${loadoutName}.${socketId} from ${Object.entries(aliases).find(([, value]) => value === next)?.[0] ?? "legacy"} to ${next}`);
        context.audit[layer.path] = changes;
      }
    }
  }
}

function repointLegacyUtilityMateriaIdentities(context: ConfigMigrationContext): void {
  const legacyToCanonical = new Map<string, string>();

  for (const layer of context.layers) {
    if (!layer.loaded) continue;
    const materia = isPlainObject(layer.config.materia) ? layer.config.materia as Record<string, unknown> : undefined;
    const safeRenames = materia ? canonicalizeLegacyUtilityMateriaDefinitions(layer, context, materia) : defaultLegacyUtilityRenames();
    for (const [from, to] of safeRenames) legacyToCanonical.set(from, to);
    canonicalizeLegacyUtilityReferences(layer, context, safeRenames);
  }

  if (context.profile) {
    const changed = rewriteMateriaReferenceValues(context.profile as unknown as Record<string, unknown>, legacyToCanonical);
    if (changed) {
      context.profileChanged = true;
      context.profileAudit.push("repointed legacy utility materia ids in profile metadata");
    }
  }
}

function defaultLegacyUtilityRenames(): Map<string, string> {
  return new Map(SHIPPED_UTILITY_MIGRATIONS.flatMap((shipped) => shipped.legacyIds.map((legacyId) => [legacyId, shipped.canonicalId] as const)));
}

function canonicalizeLegacyUtilityMateriaDefinitions(layer: MigratableConfigLayer, context: ConfigMigrationContext, materia: Record<string, unknown>): Map<string, string> {
  const renames = new Map<string, string>();
  for (const shipped of SHIPPED_UTILITY_MIGRATIONS) {
    const canonicalDefinition = materia[shipped.canonicalId];
    const canonicalAbsent = canonicalDefinition === undefined;
    const canonicalMatches = canonicalAbsent || isShippedUtilityDefinition(canonicalDefinition, shipped);
    if (!canonicalMatches) {
      const aliasesPresent = shipped.legacyIds.some((id) => materia[id] !== undefined) || hasLegacyUtilityReference(layer.config, shipped.legacyIds) || Object.entries(materia).some(([id, definition]) => id !== shipped.canonicalId && isShippedUtilityDefinition(definition, shipped));
      if (aliasesPresent) {
        preserveConflictingShippedUtilityAliases(layer, context, materia, shipped);
        auditChange(context, layer, `conflict: canonical utility materia ${shipped.canonicalId} differs from shipped ${shipped.label} behavior; legacy aliases were preserved and not repointed to it`);
      }
      continue;
    }

    for (const [id, definition] of Object.entries(materia)) {
      if (id === shipped.canonicalId || !isShippedUtilityDefinition(definition, shipped)) continue;
      if (canonicalAbsent && materia[shipped.canonicalId] === undefined) {
        materia[shipped.canonicalId] = definition;
        auditChange(context, layer, `renamed shipped utility materia ${id} to ${shipped.canonicalId}`);
      } else {
        auditChange(context, layer, `deduplicated shipped utility materia ${id} into ${shipped.canonicalId}`);
      }
      delete materia[id];
      renames.set(id, shipped.canonicalId);
      layer.changed = true;
    }

    for (const legacyId of shipped.legacyIds) {
      if (legacyId !== shipped.canonicalId && materia[legacyId] === undefined) renames.set(legacyId, shipped.canonicalId);
    }
  }
  return renames;
}

function canonicalizeLegacyUtilityReferences(layer: MigratableConfigLayer, context: ConfigMigrationContext, safeRenames: Map<string, string>): void {
  if (safeRenames.size === 0 || !isPlainObject(layer.config.loadouts)) return;
  for (const [loadoutName, loadout] of Object.entries(layer.config.loadouts as Record<string, unknown>)) {
    if (!isPlainObject(loadout)) continue;
    const changedMetadata = rewriteMateriaReferenceValues(loadout, safeRenames);
    if (changedMetadata) {
      layer.changed = true;
      auditChange(context, layer, `repointed legacy utility materia references in loadout ${loadoutName}`);
    }
  }
}

function rewriteMateriaReferenceValues(value: unknown, renames: Map<string, string>): boolean {
  if (Array.isArray(value)) return value.map((entry) => rewriteMateriaReferenceValues(entry, renames)).some(Boolean);
  if (!isPlainObject(value)) return false;
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "materia" || key === "materiaId" || key === "selectedMateriaId") && typeof child === "string") {
      const next = renames.get(child);
      if (next) {
        value[key] = next;
        changed = true;
      }
      continue;
    }
    if (rewriteMateriaReferenceValues(child, renames)) changed = true;
  }
  return changed;
}

function hasLegacyUtilityReference(value: unknown, legacyIds: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasLegacyUtilityReference(entry, legacyIds));
  if (!isPlainObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "materia" || key === "materiaId" || key === "selectedMateriaId") && typeof child === "string" && legacyIds.includes(child)) return true;
    if (hasLegacyUtilityReference(child, legacyIds)) return true;
  }
  return false;
}

interface ShippedUtilityMigration {
  canonicalId: "Detect-VCS" | "Ignore-Artifacts";
  label: string;
  legacyIds: string[];
  signatures: UtilitySignature[];
}

const SHIPPED_UTILITY_MIGRATIONS: readonly ShippedUtilityMigration[] = [
  {
    canonicalId: "Detect-VCS",
    label: "VCS detector",
    legacyIds: ["detectVcs"],
    signatures: [defaultDetectVcsSignature(), { command: ["node", "./utilities/detect-vcs.mjs"], parse: "json", assign: { vcs: "$" } }, { script: "./utilities/detect-vcs.mjs", parse: "json", assign: { vcs: "$" } }, { script: { kind: "shippedUtility", name: "detect-vcs.mjs", runtime: "node" }, parse: "json", assign: { vcs: "$" } }],
  },
  {
    canonicalId: "Ignore-Artifacts",
    label: "artifact ignore utility",
    legacyIds: ["ensureArtifactsIgnored"],
    signatures: [defaultEnsureIgnoredSignature(), { command: ["node", "./utilities/ensure-ignored.mjs"], params: { patterns: [".pi/pi-materia/"] }, parse: "json", assign: { artifactIgnore: "$" } }, { script: "./utilities/ensure-ignored.mjs", params: { patterns: [".pi/pi-materia/"] }, parse: "json", assign: { artifactIgnore: "$" } }, { script: { kind: "shippedUtility", name: "ensure-ignored.mjs", runtime: "node" }, params: { patterns: [".pi/pi-materia/"] }, parse: "json", assign: { artifactIgnore: "$" } }],
  },
];

function preserveConflictingShippedUtilityAliases(layer: MigratableConfigLayer, context: ConfigMigrationContext, materia: Record<string, unknown>, shipped: ShippedUtilityMigration): void {
  for (const legacyId of shipped.legacyIds) {
    if (!hasLegacyUtilityReference(layer.config, [legacyId]) || materia[legacyId] !== undefined) continue;
    materia[legacyId] = {
      type: "utility",
      label: shipped.canonicalId,
      group: "Utility",
      ...clonePlain(shipped.signatures[0]),
    };
    layer.changed = true;
    auditChange(context, layer, `preserved shipped utility behavior as ${legacyId} because ${shipped.canonicalId} is custom`);
  }
}

function isShippedUtilityDefinition(value: unknown, shipped: ShippedUtilityMigration): boolean {
  if (!isUtilityMateriaDefinition(value)) return false;
  const signature = normalizedUtilityBehavior(value);
  return shipped.signatures.some((candidate) => normalizedUtilityBehavior(candidate as Record<string, unknown>) === signature);
}

function normalizedUtilityBehavior(definition: Record<string, unknown>): string {
  const signature = cleanSignature({
    ...(typeof definition.utility === "string" ? { utility: definition.utility } : {}),
    ...(Array.isArray(definition.command) && definition.command.every((part) => typeof part === "string") ? { command: [...definition.command] as string[] } : {}),
    ...(typeof definition.script === "string" || isPlainObject(definition.script) ? { script: clonePlain(definition.script) } : {}),
    ...(isPlainObject(definition.params) && Object.keys(definition.params).length > 0 ? { params: clonePlain(definition.params) } : {}),
    ...(typeof definition.timeoutMs === "number" ? { timeoutMs: definition.timeoutMs } : {}),
    ...(typeof definition.parse === "string" ? { parse: definition.parse } : {}),
    ...(isStringRecord(definition.assign) ? { assign: { ...definition.assign } } : {}),
  });
  return stableStringify(signature);
}

function auditChange(context: ConfigMigrationContext, layer: MigratableConfigLayer, change: string): void {
  context.audit[layer.path] = [...(context.audit[layer.path] ?? []), change];
}

function hoistLegacyUtilityMateria(materia: Record<string, unknown>, signatureToId: Map<string, string>, signature: UtilitySignature): string {
  const existing = signatureToId.get(stableStringify(signature));
  if (existing) return existing;
  const scriptLabel = typeof signature.script === "string" ? signature.script : isPlainObject(signature.script) && typeof signature.script.name === "string" ? signature.script.name : undefined;
  const base = `legacyUtility${pascalCase(signature.utility ?? scriptLabel ?? signature.command?.[0] ?? "command")}`;
  const suffix = shortHash(stableStringify(signature));
  let id = `${base}${suffix}`;
  let counter = 2;
  while (Object.prototype.hasOwnProperty.call(materia, id)) id = `${base}${suffix}${counter++}`;
  materia[id] = {
    type: "utility",
    label: humanizeLegacyUtilityLabel(signature.utility ?? signature.command?.[0] ?? "Legacy utility"),
    ...signature,
  };
  signatureToId.set(stableStringify(signature), id);
  return id;
}

function stripInlineUtilityFields(socket: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of ["utility", "command", "script", "params", "timeoutMs", "parse", "assign"]) {
    if (key in socket) {
      delete socket[key];
      changed = true;
    }
  }
  return changed;
}

function cleanSignature(signature: UtilitySignature): UtilitySignature {
  return Object.fromEntries(Object.entries(signature).filter(([, value]) => value !== undefined)) as UtilitySignature;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36).slice(0, 6);
}

function pascalCase(value: string): string {
  return value.split(/[^a-z0-9]+/i).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("") || "Command";
}

function humanizeLegacyUtilityLabel(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, " ").trim() || "Legacy utility";
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
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

function isLoadoutSource(value: unknown): value is LoadoutSource {
  return value === "default" || value === "user" || value === "project" || value === "explicit";
}

function isLoadoutLockState(value: unknown): value is LoadoutUserLockState {
  return value === "locked" || value === "unlocked";
}

function stableLoadoutId(scope: MateriaConfigLayerScope, displayName: string): string {
  const slug = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "loadout";
  return `${scope}:${slug}`;
}

function shouldStampConfig(config: Partial<PiMateriaConfig> | MateriaProfileConfig): boolean {
  const target = config as MigrationMetadataContainer;
  if (target.piMateria?.schemaVersion !== CURRENT_PI_MATERIA_SCHEMA_VERSION || !Array.isArray(target.piMateria?.migrations)) return true;
  const applied = new Set(target.piMateria.migrations.map((migration) => migration.id));
  return LOADOUT_CONFIG_MIGRATIONS.some((migration) => !applied.has(migration.id));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
