import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCompactionConfig } from "./compactionConfig.js";
import { isShippedUtilityScriptRef, resolveShippedUtilityScriptPath, syncShippedUtilityScripts } from "./shippedUtilities.js";
import { normalizeMateriaCatalog, validateLoadoutMateriaReferences } from "../domain/materia.js";
import { assertValidPipelineGraph, normalizePipelineGraph } from "../graph/graphValidation.js";
import { normalizeConfigLoadoutsForLoad, prepareConfigLoadoutsForSave, prepareLoadoutForSave } from "../loadout/loadoutNormalization.js";
import { loadoutSockets } from "../loadout/loadoutAccessors.js";
import { resolveDefaultLoadout, resolveLoadoutSelection, resolveQuestDefaultLoadout } from "../loadout/defaultLoadoutResolver.js";
import { normalizePersistedConfigForApplication, normalizePersistedLoadoutForApplication, serializeCurrentPersistedConfig, serializeCurrentProfileConfig } from "../schema/persistence.js";
import { validateToolScopeSpecShape, validToolScopeShapeDescription } from "../domain/toolScope.js";
import { isMateriaThinkingLevel, type MateriaThinkingLevel } from "../domain/thinking.js";
import type { EventingConfig, EventSinkConfig, LoadedConfig, MateriaConfigLayer, MateriaConfigLayerScope, MateriaProfileConfig, MateriaRoleGenerationProfileConfig, MateriaConfig, MateriaConfigPatch, MateriaSaveTarget, PiMateriaConfig, MateriaPipelineConfig, LoadoutUserLockState, MateriaUserLockState } from "../types.js";
import {
  CENTRAL_CATALOG_LAYER_LABEL,
  type CentralCatalogConfigSource,
  centralCatalogSourceToPartial,
  isCentralCatalogSourceEmpty,
} from "./centralCatalogSource.js";
import { resolveConfigCatalogDrift } from "./catalogDrift.js";
import { isValidCatalogOriginProvenance, type CatalogOriginProvenance } from "../domain/catalogProvenance.js";
import { readEventingEnvOverlay, type EventingEnvSource } from "../eventing/envOverlay.js";
import { detectControllerLaunch } from "../eventing/presets.js";

/**
 * Options for {@link loadConfig}.
 */
export interface LoadConfigOptions {
  /**
   * Optional central catalog definitions surfaced as the read-only `central`
   * layer between bundled defaults and user config
   * (docs/enterprise-control-plane.md §5). Omit it, or pass an empty source,
   * to keep precedence unchanged for purely local workflows.
   */
  centralSource?: CentralCatalogConfigSource;
}

export async function loadConfig(cwd: string, configuredPath?: string, options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  await ensureUserProfileConfig();
  await syncShippedUtilityScripts(getUserMateriaDir());
  const defaultPath = getBundledDefaultConfigPath();
  const userPath = getUserMateriaAssetPath();
  const projectPath = getProjectConfigPath(cwd);
  const explicitPath = configuredPath ? resolveFromCwd(cwd, configuredPath) : undefined;
  const layers: MateriaConfigLayer[] = [{ scope: "default", path: defaultPath, loaded: true }];
  const partials: Partial<PiMateriaConfig>[] = [await readConfigPartial(defaultPath)];

  // Central catalog layer: read-only provenance, consulted only when central
  // definitions are supplied. Sits above bundled defaults and below user config
  // so local definitions always win (docs/enterprise-control-plane.md §5, §10).
  if (!isCentralCatalogSourceEmpty(options.centralSource)) {
    layers.push({ scope: "central", loaded: true });
    partials.push(centralCatalogSourceToPartial(options.centralSource!));
  }

  if (existsSync(userPath)) {
    layers.push({ scope: "user", path: userPath, loaded: true });
    partials.push(await readConfigPartial(userPath));
  } else {
    layers.push({ scope: "user", path: userPath, loaded: false });
  }

  if (existsSync(projectPath)) {
    layers.push({ scope: "project", path: projectPath, loaded: true });
    partials.push(await readConfigPartial(projectPath));
  } else {
    layers.push({ scope: "project", path: projectPath, loaded: false });
  }

  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`pi-materia config file not found: ${explicitPath}`);
    layers.push({ scope: "explicit", path: explicitPath, loaded: true });
    partials.push(await readConfigPartial(explicitPath));
  }

  const loadedLayers = layers.filter((layer) => layer.loaded);
  const profile = await loadProfileConfig();
  // Apply the in-memory PI_MATERIA_EVENTING_* overlay AFTER all file-backed
  // layers are merged so launch-time values (set by agent_router) take
  // precedence over bundled/user/project/explicit config. The overlay is
  // never written back to config files (docs/runtime-eventing.md §8.4).
  const config = applyEventingEnvOverlay(await mergeConfigLayers(partials));
  const loadoutSources = buildLoadoutSources(partials, loadedLayers, new Set(Object.keys(partials[0]?.loadouts ?? {})));
  const materiaSources = buildMateriaSources(partials, loadedLayers);
  const defaultMateriaIds = Object.keys(partials[0]?.materia ?? {});
  const materiaCommandSources = buildMateriaCommandSources(partials, loadedLayers);
  resolveUtilityExecutionBindings(config, materiaCommandSources, loadedLayers);
  const defaultLoadout = resolveDefaultLoadout(profile.defaultLoadoutId, config.loadouts, loadoutSources);
  const questDefaultLoadout = resolveQuestDefaultLoadout(profile.questDefaultLoadoutId, config.loadouts, loadoutSources);
  // Catalog drift is informational and never mutates local files: it compares
  // recorded central origins against the current central summaries and surfaces
  // the result for loaded config/WebUI (docs/enterprise-control-plane.md §14).
  const catalogDrift = resolveConfigCatalogDrift({
    config,
    loadoutSources,
    materiaSources,
    centralSource: options.centralSource,
  });
  return {
    config,
    source: loadedLayers.map((layer) => layer.path ?? (layer.scope === "central" ? CENTRAL_CATALOG_LAYER_LABEL : layer.scope)).join(" < "),
    layers,
    loadoutSources,
    materiaSources,
    ...(catalogDrift ? { catalogDrift } : {}),
    defaultMateriaIds,
    defaultLoadoutId: defaultLoadout.loadoutId,
    ...(defaultLoadout.warning ? { defaultLoadoutWarning: defaultLoadout.warning } : {}),
    questDefaultLoadoutId: questDefaultLoadout.loadoutId,
    ...(questDefaultLoadout.warning ? { questDefaultLoadoutWarning: questDefaultLoadout.warning } : {}),
  };
}

export async function loadProfileConfig(): Promise<MateriaProfileConfig> {
  await ensureUserProfileConfig();
  const file = getUserProfileConfigPath();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!isPlainObject(parsed)) {
      warnInvalidProfileConfig(file, "Expected a JSON object; using profile defaults.");
      return defaultProfileConfig();
    }
    return normalizeProfileConfig(parsed, file);
  } catch (error) {
    warnInvalidProfileConfig(file, `Could not read profile config; using profile defaults: ${error instanceof Error ? error.message : String(error)}`);
    return defaultProfileConfig();
  }
}

export async function ensureUserProfileConfig(): Promise<string> {
  const dir = getUserMateriaDir();
  const file = getUserProfileConfigPath();
  await mkdir(dir, { recursive: true });
  if (!existsSync(file)) await writeJsonAtomic(file, serializeCurrentProfileConfig(defaultProfileConfig()));
  return file;
}

export async function saveDefaultLoadoutPreference(cwd: string, loadoutName: string | null, configuredPath?: string): Promise<string | null> {
  const loaded = await loadConfig(cwd, configuredPath);
  const requestedDefault = loadoutName?.trim() || null;
  const resolvedDefault = requestedDefault ? resolveDefaultLoadout(requestedDefault, loaded.config.loadouts, loaded.loadoutSources) : { loadoutId: null };
  const nextDefault = resolvedDefault.loadoutId;
  if (requestedDefault && !nextDefault) {
    const loadoutNames = Object.keys(loaded.config.loadouts ?? {});
    throw new Error(loadoutNames.length
      ? `Unknown Materia loadout "${requestedDefault}". Available loadouts: ${loadoutNames.join(", ")}.`
      : "Cannot set a default Materia loadout because this config does not define any loadouts.");
  }
  const profile = await loadProfileConfig();
  await writeProfileConfig({ ...profile, defaultLoadoutId: nextDefault });
  return nextDefault;
}

export async function clearStaleDefaultLoadoutPreference(cwd: string, configuredPath?: string): Promise<boolean> {
  const loaded = await loadConfig(cwd, configuredPath);
  const profile = await loadProfileConfig();
  if (!profile.defaultLoadoutId || loaded.defaultLoadoutId) return false;
  await writeProfileConfig({ ...profile, defaultLoadoutId: null });
  return true;
}

export async function saveQuestDefaultLoadoutPreference(cwd: string, loadoutName: string | null, configuredPath?: string): Promise<string | null> {
  const loaded = await loadConfig(cwd, configuredPath);
  const requestedDefault = loadoutName?.trim() || null;
  const resolvedDefault = requestedDefault ? resolveQuestDefaultLoadout(requestedDefault, loaded.config.loadouts, loaded.loadoutSources) : { loadoutId: null };
  const nextDefault = resolvedDefault.loadoutId;
  if (requestedDefault && !nextDefault) {
    const loadoutNames = Object.keys(loaded.config.loadouts ?? {});
    throw new Error(loadoutNames.length
      ? `Unknown quest default Materia loadout "${requestedDefault}". Available loadouts: ${loadoutNames.join(", ")}.`
      : "Cannot set a quest default Materia loadout because this config does not define any loadouts.");
  }
  const profile = await loadProfileConfig();
  await writeProfileConfig({ ...profile, questDefaultLoadoutId: nextDefault });
  return nextDefault;
}

export async function clearStaleQuestDefaultLoadoutPreference(cwd: string, configuredPath?: string): Promise<boolean> {
  const loaded = await loadConfig(cwd, configuredPath);
  const profile = await loadProfileConfig();
  if (!profile.questDefaultLoadoutId || loaded.questDefaultLoadoutId) return false;
  await writeProfileConfig({ ...profile, questDefaultLoadoutId: null });
  return true;
}

export function normalizeRoleGenerationModelPreference(model: string | null | undefined): string | null {
  const trimmed = typeof model === "string" ? model.trim() : null;
  return trimmed || null;
}

export function isProviderQualifiedModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export interface RoleGenerationPreferenceUpdate {
  model?: string | null;
  thinking?: string | null;
}

export interface RoleGenerationPreference {
  model: string | null;
  thinking: MateriaThinkingLevel | null;
}

export async function getRoleGenerationPreference(): Promise<RoleGenerationPreference> {
  const roleGeneration = (await loadProfileConfig()).roleGeneration;
  return {
    model: normalizeRoleGenerationModelPreference(roleGeneration?.model),
    thinking: normalizeRoleGenerationThinkingPreference(roleGeneration?.thinking),
  };
}

export async function getRoleGenerationModelPreference(): Promise<string | null> {
  return (await getRoleGenerationPreference()).model;
}

export function normalizeRoleGenerationThinkingPreference(thinking: string | null | undefined): MateriaThinkingLevel | null {
  const trimmed = typeof thinking === "string" ? thinking.trim() : null;
  return isMateriaThinkingLevel(trimmed) ? trimmed : null;
}

export async function saveRoleGenerationPreference(update: RoleGenerationPreferenceUpdate): Promise<RoleGenerationPreference> {
  const hasModel = Object.prototype.hasOwnProperty.call(update, "model");
  const hasThinking = Object.prototype.hasOwnProperty.call(update, "thinking");
  const nextModel = hasModel ? normalizeRoleGenerationModelPreference(update.model) : undefined;
  const nextThinking = hasThinking ? (typeof update.thinking === "string" ? update.thinking.trim() : null) : undefined;
  if (nextModel && !isProviderQualifiedModelId(nextModel)) {
    throw new Error('Invalid role-generation model. Expected a provider-qualified model id such as "provider/model".');
  }
  if (nextThinking && !isMateriaThinkingLevel(nextThinking)) {
    throw new Error('Invalid role-generation thinking. Expected one of: off, minimal, low, medium, high, xhigh.');
  }
  const profile = await loadProfileConfig();
  const roleGeneration = { ...(profile.roleGeneration ?? defaultRoleGenerationProfileConfig()) };
  if (hasModel) roleGeneration.model = nextModel;
  if (hasThinking) roleGeneration.thinking = nextThinking as MateriaThinkingLevel | null;
  await writeProfileConfig({ ...profile, roleGeneration });
  return {
    model: normalizeRoleGenerationModelPreference(roleGeneration.model),
    thinking: normalizeRoleGenerationThinkingPreference(roleGeneration.thinking),
  };
}

export async function saveRoleGenerationModelPreference(model: string | null): Promise<string | null> {
  return (await saveRoleGenerationPreference({ model })).model;
}

export async function saveMateriaConfigPatch(cwd: string, patch: MateriaConfigPatch, options: { target?: MateriaSaveTarget; configuredPath?: string } = {}): Promise<string> {
  rejectObsoleteConfigFields(patch as Record<string, unknown>, "patch");
  const target = options.target ?? "user";
  const file = getWritableConfigPath(cwd, options.configuredPath, target);
  rejectDefaultLoadoutDeletes(patch);
  rejectReadonlyDefaultLoadoutSaves(patch);
  const existing = existsSync(file) ? await readConfigPartial(file) : {};
  rejectProtectedMateriaDeletes(patch, existing);
  rejectLockedMateriaContentSaves(patch, existing);
  const next = mergeConfigPatch(existing, patch);
  if (next.materia) validateMateria(next.materia as Record<string, MateriaConfig>);
  next.loadouts = normalizeLoadoutsForSave(next.loadouts, next.materia as Record<string, MateriaConfig> | undefined);
  const materialized = withoutDeletedLoadoutMarkers(next);
  ensureCurrentLoadoutIdentity(materialized, target);
  ensureCurrentLoadoutIdentity(next, target);
  ensureCurrentLoadoutOwnershipAndLocks(materialized, target);
  ensureCurrentLoadoutOwnershipAndLocks(next, target);
  await validateSaveLoadoutOwnership(cwd, options.configuredPath, target, materialized);
  await validateSaveMateriaReferences(cwd, options.configuredPath, target, materialized);
  validateLoadoutGraphs(materialized.loadouts);
  await writeJsonAtomic(file, serializeCurrentPersistedConfig(next));
  return file;
}

export async function saveActiveLoadout(cwd: string, loadoutName: string, configuredPath?: string): Promise<string> {
  const loaded = await loadConfig(cwd, configuredPath);
  const loadoutNames = Object.keys(loaded.config.loadouts ?? {});
  if (loadoutNames.length === 0) {
    throw new Error(`Cannot change Materia loadout because this config does not define any loadouts.`);
  }
  const resolvedLoadout = resolveLoadoutSelection(loadoutName, loaded.config.loadouts, loaded.loadoutSources);
  const resolvedLoadoutName = resolvedLoadout?.loadoutName ?? null;
  if (!resolvedLoadoutName) {
    throw new Error(`Unknown Materia loadout "${loadoutName}". Available loadouts: ${loadoutNames.join(", ")}.`);
  }

  const targetPath = getWritableConfigPath(cwd, configuredPath, configuredPath ? "explicit" : "project");
  await writeMinimalActiveLoadout(targetPath, resolvedLoadoutName, resolvedLoadout?.loadoutId ?? findLoadoutId(loaded.config.loadouts, resolvedLoadoutName));
  return targetPath;
}

async function readConfigPartial(file: string): Promise<Partial<PiMateriaConfig>> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PiMateriaConfig>;
  if (!isPlainObject(parsed)) throw new Error(`Materia config file ${file} is invalid. Expected a JSON object.`);
  rejectObsoleteConfigFields(parsed as Record<string, unknown>, file);
  return normalizePersistedConfigForApplication(parsed);
}

function getBundledDefaultConfigPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "..", "config", "default.json");
}

export function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-materia.json");
}

export function getUserMateriaDir(): string {
  return process.env.PI_MATERIA_PROFILE_DIR?.trim() || path.join(homedir(), ".config", "pi", "pi-materia");
}

export function getUserProfileConfigPath(): string {
  return path.join(getUserMateriaDir(), "config.json");
}

export function getUserMateriaAssetPath(): string {
  return path.join(getUserMateriaDir(), "materia.json");
}

function getWritableConfigPath(cwd: string, configuredPath?: string, target: MateriaSaveTarget = configuredPath ? "explicit" : "user"): string {
  if (target === "explicit") {
    if (!configuredPath) throw new Error("Cannot save to explicit Materia config because no explicit config path is active.");
    return resolveFromCwd(cwd, configuredPath);
  }
  return target === "project" ? getProjectConfigPath(cwd) : getUserMateriaAssetPath();
}

async function validateSaveLoadoutOwnership(cwd: string, configuredPath: string | undefined, target: MateriaSaveTarget, nextTargetConfig: Partial<PiMateriaConfig>): Promise<void> {
  validateNoDuplicateLoadoutOwnership(await buildSaveValidationLayers(cwd, configuredPath, target, nextTargetConfig));
}

async function validateSaveMateriaReferences(cwd: string, configuredPath: string | undefined, target: MateriaSaveTarget, nextTargetConfig: Partial<PiMateriaConfig>): Promise<void> {
  const merged = await mergeConfigLayers((await buildSaveValidationLayers(cwd, configuredPath, target, nextTargetConfig)).map((layer) => layer.config));
  validateConfigMateriaReferences(merged);
}

async function buildSaveValidationLayers(cwd: string, configuredPath: string | undefined, target: MateriaSaveTarget, nextTargetConfig: Partial<PiMateriaConfig>): Promise<Array<{ scope: MateriaConfigLayerScope; config: Partial<PiMateriaConfig> }>> {
  const defaultPath = getBundledDefaultConfigPath();
  const userPath = getUserMateriaAssetPath();
  const projectPath = getProjectConfigPath(cwd);
  const explicitPath = configuredPath ? resolveFromCwd(cwd, configuredPath) : undefined;
  const layers: Array<{ scope: MateriaConfigLayerScope; config: Partial<PiMateriaConfig> }> = [
    { scope: "default", config: await readConfigPartial(defaultPath) },
  ];
  if (target === "user") layers.push({ scope: "user", config: nextTargetConfig });
  else if (existsSync(userPath)) layers.push({ scope: "user", config: await readConfigPartial(userPath) });
  if (target === "project") layers.push({ scope: "project", config: nextTargetConfig });
  else if (existsSync(projectPath)) layers.push({ scope: "project", config: await readConfigPartial(projectPath) });
  if (target === "explicit") layers.push({ scope: "explicit", config: nextTargetConfig });
  else if (explicitPath && existsSync(explicitPath)) layers.push({ scope: "explicit", config: await readConfigPartial(explicitPath) });
  return layers;
}

function ensureCurrentLoadoutIdentity(config: Partial<PiMateriaConfig>, scope: MateriaConfigLayerScope): void {
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

function ensureCurrentLoadoutOwnershipAndLocks(config: Partial<PiMateriaConfig>, scope: MateriaConfigLayerScope): void {
  if (!isPlainObject(config.loadouts)) return;
  for (const loadout of Object.values(config.loadouts as Record<string, unknown>)) {
    if (!isPlainObject(loadout)) continue;
    loadout.source = scope;
    if (scope === "default") delete loadout.lockState;
    else if (!isLoadoutLockState(loadout.lockState)) loadout.lockState = "unlocked";
  }
}

function validateNoDuplicateLoadoutOwnership(layers: Array<{ scope: MateriaConfigLayerScope; config: Partial<PiMateriaConfig> }>): void {
  const owners = new Map<string, MateriaConfigLayerScope>();
  for (const layer of layers) {
    if (!isPlainObject(layer.config.loadouts)) continue;
    for (const [name, loadout] of Object.entries(layer.config.loadouts as Record<string, unknown>)) {
      if (loadout === null || !isPlainObject(loadout)) continue;
      const existing = owners.get(name);
      if (existing && existing !== layer.scope) throw new Error(`Materia loadout "${name}" is already owned by ${existing} scope; choose a unique name before saving to ${layer.scope}.`);
      owners.set(name, layer.scope);
    }
  }
}

function isLoadoutLockState(value: unknown): value is LoadoutUserLockState {
  return value === "locked" || value === "unlocked";
}

function stableLoadoutId(scope: MateriaConfigLayerScope, displayName: string): string {
  const slug = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "loadout";
  return `${scope}:${slug}`;
}

const BUILTIN_FULL_AUTO_LOADOUT_ID = "default:full-auto";

function defaultProfileConfig(): MateriaProfileConfig {
  return { webui: { autoOpenBrowser: false }, defaultLoadoutId: null, questDefaultLoadoutId: BUILTIN_FULL_AUTO_LOADOUT_ID, defaultSaveTarget: "user", roleGeneration: defaultRoleGenerationProfileConfig() };
}

function defaultRoleGenerationProfileConfig(): MateriaRoleGenerationProfileConfig {
  return { enabled: true, useReadOnlyProjectContext: false };
}

function normalizeProfileConfig(parsed: Record<string, unknown>, file: string): MateriaProfileConfig {
  const defaults = defaultProfileConfig();
  const profile: MateriaProfileConfig = { ...defaults };

  if (parsed.webui !== undefined) {
    if (isPlainObject(parsed.webui)) profile.webui = parsed.webui as MateriaProfileConfig["webui"];
    else warnInvalidProfileConfig(file, "Ignoring invalid webui profile config. Expected an object.");
  }

  // Validate webui.centralApiBaseUrl so an invalid/unsafe value degrades to
  // the default local-only workflow rather than breaking the WebUI
  // (docs/enterprise-control-plane.md §2, §8). The launcher revalidates at the
  // server boundary via the WebUI mode helper.
  if (profile.webui) {
    const validCentralUrl = normalizeCentralApiBaseUrl(profile.webui.centralApiBaseUrl, file);
    if (validCentralUrl === undefined) delete profile.webui.centralApiBaseUrl;
    else profile.webui.centralApiBaseUrl = validCentralUrl;
  }

  if (parsed.defaultLoadoutId !== undefined) {
    if (parsed.defaultLoadoutId === null) profile.defaultLoadoutId = null;
    else if (typeof parsed.defaultLoadoutId === "string" && parsed.defaultLoadoutId.trim()) profile.defaultLoadoutId = parsed.defaultLoadoutId.trim();
    else warnInvalidProfileConfig(file, "Ignoring invalid defaultLoadoutId. Expected a non-empty string or null.");
  }

  if (parsed.questDefaultLoadoutId !== undefined) {
    if (parsed.questDefaultLoadoutId === null) profile.questDefaultLoadoutId = null;
    else if (typeof parsed.questDefaultLoadoutId === "string" && parsed.questDefaultLoadoutId.trim()) profile.questDefaultLoadoutId = parsed.questDefaultLoadoutId.trim();
    else warnInvalidProfileConfig(file, "Ignoring invalid questDefaultLoadoutId. Expected a non-empty string or null.");
  }

  if (parsed.defaultSaveTarget !== undefined) {
    if (parsed.defaultSaveTarget === "user" || parsed.defaultSaveTarget === "project") profile.defaultSaveTarget = parsed.defaultSaveTarget;
    else warnInvalidProfileConfig(file, 'Ignoring invalid defaultSaveTarget. Expected "user" or "project".');
  }

  profile.roleGeneration = normalizeRoleGenerationProfileConfig(parsed.roleGeneration, file);
  return profile;
}

function normalizeRoleGenerationProfileConfig(value: unknown, file: string): MateriaRoleGenerationProfileConfig {
  const config = defaultRoleGenerationProfileConfig();
  if (value === undefined) return config;
  if (!isPlainObject(value)) {
    warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration profile config. Expected an object.");
    return config;
  }

  if (value.enabled !== undefined) {
    if (typeof value.enabled === "boolean") config.enabled = value.enabled;
    else warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration.enabled. Expected a boolean.");
  }
  if (value.model !== undefined) {
    if (value.model === null) config.model = null;
    else if (typeof value.model === "string" && value.model.trim()) config.model = value.model.trim();
    else warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration.model. Expected a non-empty string or null.");
  }
  if (value.provider !== undefined) {
    if (typeof value.provider === "string" && value.provider.trim()) config.provider = value.provider.trim();
    else warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration.provider. Expected a non-empty string.");
  }
  if (value.api !== undefined) {
    if (typeof value.api === "string" && value.api.trim()) config.api = value.api.trim();
    else warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration.api. Expected a non-empty string.");
  }
  if (value.thinking !== undefined) {
    if (value.thinking === null) config.thinking = null;
    else if (typeof value.thinking === "string") {
      const thinking = value.thinking.trim();
      if (isMateriaThinkingLevel(thinking)) config.thinking = thinking;
      else warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration.thinking. Expected one of off, minimal, low, medium, high, xhigh, or null.");
    }
    else warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration.thinking. Expected one of off, minimal, low, medium, high, xhigh, or null.");
  }
  if (value.extraInstructions !== undefined) {
    if (typeof value.extraInstructions === "string") config.extraInstructions = value.extraInstructions.trim() || undefined;
    else warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration.extraInstructions. Expected a string.");
  }
  if (value.useReadOnlyProjectContext !== undefined) {
    if (typeof value.useReadOnlyProjectContext === "boolean") config.useReadOnlyProjectContext = value.useReadOnlyProjectContext;
    else warnInvalidProfileConfig(file, "Ignoring invalid roleGeneration.useReadOnlyProjectContext. Expected a boolean.");
  }

  return config;
}

function warnInvalidProfileConfig(file: string, message: string): void {
  console.warn(`[pi-materia] Profile config ${file}: ${message}`);
}

/**
 * Normalize an optional central control-plane base URL for the WebUI profile.
 * Returns a trimmed http(s) URL, or `undefined` when unset/invalid (after
 * warning). Unset/invalid means purely local and changes no default behavior
 * (docs/enterprise-control-plane.md §2, §8).
 */
function normalizeCentralApiBaseUrl(value: unknown, file: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    warnInvalidProfileConfig(file, "Ignoring invalid webui.centralApiBaseUrl. Expected a string.");
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      warnInvalidProfileConfig(file, "Ignoring invalid webui.centralApiBaseUrl. Expected an http(s) URL.");
      return undefined;
    }
    return trimmed;
  } catch {
    warnInvalidProfileConfig(file, "Ignoring invalid webui.centralApiBaseUrl. Expected an http(s) URL.");
    return undefined;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.pi-materia.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function writeProfileConfig(profile: MateriaProfileConfig): Promise<string> {
  const file = await ensureUserProfileConfig();
  await writeJsonAtomic(file, serializeCurrentProfileConfig(profile));
  return file;
}

function findLoadoutId(loadouts: PiMateriaConfig["loadouts"] | undefined, name: string): string | undefined {
  const loadout = loadouts?.[name];
  return loadout && typeof loadout === "object" && !Array.isArray(loadout) && typeof (loadout as { id?: unknown }).id === "string" ? (loadout as { id: string }).id : undefined;
}

async function writeMinimalActiveLoadout(file: string, loadoutName: string, loadoutId?: string): Promise<void> {
  let parsed: Partial<PiMateriaConfig> = {};
  if (existsSync(file)) {
    const text = await readFile(file, "utf8");
    parsed = JSON.parse(text) as Partial<PiMateriaConfig>;
    if (!isPlainObject(parsed)) throw new Error(`Materia config file ${file} is invalid. Expected a JSON object.`);
    rejectObsoleteConfigFields(parsed as Record<string, unknown>, file);
  }

  const activeLoadoutId = loadoutId ?? findLoadoutId(parsed.loadouts, loadoutName);
  const next = { ...parsed, activeLoadout: loadoutName, ...(activeLoadoutId ? { activeLoadoutId } : {}) };
  try {
    await writeJsonAtomic(file, serializeCurrentPersistedConfig(next));
  } catch (error) {
    throw new Error(`Failed to persist active Materia loadout to ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function mergeConfigLayers(layers: Partial<PiMateriaConfig>[]): Promise<PiMateriaConfig> {
  const [base, ...overrides] = layers;
  const defaultLoadoutNames = new Set(Object.keys(base.loadouts ?? {}));
  let config = { ...base } as PiMateriaConfig;
  for (const parsed of overrides) config = mergeConfig(config, parsed, defaultLoadoutNames);
  if (!isPlainObject(config.materia)) throw new Error(`Materia config must define top-level "materia" behavior definitions.`);
  validateMateria(config.materia);
  validateCompactionConfig(config.compaction);
  config = normalizeConfigRuntimeSockets(config);
  config = normalizeConfigLoadoutsForLoad(config);
  config = prepareConfigLoadoutsForSave(config);
  validateConfigMateriaReferences(config);
  validateLoadoutGraphs(config.loadouts);
  return config;
}

function normalizeConfigRuntimeSockets(config: PiMateriaConfig): PiMateriaConfig {
  if (!isPlainObject(config.loadouts)) return config;
  return {
    ...config,
    loadouts: Object.fromEntries(Object.entries(config.loadouts).map(([name, loadout]) => [name, normalizePersistedLoadoutForApplication(loadout, config.materia)])) as PiMateriaConfig["loadouts"],
  };
}

function mergeConfigPatch(base: Partial<PiMateriaConfig>, patch: MateriaConfigPatch): Partial<PiMateriaConfig> {
  return {
    ...base,
    ...patch,
    budget: patch.budget ? { ...(base.budget ?? {}), ...patch.budget } : base.budget,
    limits: patch.limits ? { ...(base.limits ?? {}), ...patch.limits } : base.limits,
    compaction: patch.compaction ? { ...(base.compaction ?? {}), ...patch.compaction } : base.compaction,
    loadouts: mergeLoadouts(base.loadouts, patch.loadouts, new Set<string>(), true),
    activeLoadout: patch.activeLoadout ?? base.activeLoadout,
    activeLoadoutId: patch.activeLoadoutId ?? base.activeLoadoutId,
    materia: patch.materia ? mergeMateria(base.materia ?? {}, patch.materia) : base.materia,
    eventing: patch.eventing === null ? undefined : (patch.eventing ? mergeEventing(base.eventing, patch.eventing) : base.eventing),
  };
}

function buildLoadoutSources(partials: Partial<PiMateriaConfig>[], layers: MateriaConfigLayer[], protectedLoadoutNames = new Set<string>()): Record<string, MateriaConfigLayerScope> {
  const sources: Record<string, MateriaConfigLayerScope> = {};
  partials.forEach((partial, index) => {
    const scope = layers[index]?.scope;
    if (!scope || !isPlainObject(partial.loadouts)) return;
    for (const [name, loadout] of Object.entries(partial.loadouts as Record<string, unknown>)) {
      if (loadout === null) {
        if (sources[name] !== "default") delete sources[name];
      } else if (isPlainObject(loadout)) {
        if (protectedLoadoutNames.has(name) && scope !== "default") continue;
        sources[name] = isLoadoutSource(loadout.source) ? loadout.source : scope;
      }
    }
  });
  return sources;
}

function buildMateriaSources(partials: Partial<PiMateriaConfig>[], layers: MateriaConfigLayer[]): Record<string, MateriaConfigLayerScope> {
  const sources: Record<string, MateriaConfigLayerScope> = {};
  partials.forEach((partial, index) => {
    const scope = layers[index]?.scope;
    if (!scope || !isPlainObject(partial.materia)) return;
    for (const [id, definition] of Object.entries(partial.materia as Record<string, unknown>)) {
      if (definition === null) {
        if (sources[id] !== "default") delete sources[id];
      } else if (isPlainObject(definition)) {
        sources[id] = scope;
      }
    }
  });
  return sources;
}

function buildMateriaCommandSources(partials: Partial<PiMateriaConfig>[], layers: MateriaConfigLayer[]): Record<string, MateriaConfigLayerScope> {
  const sources: Record<string, MateriaConfigLayerScope> = {};
  partials.forEach((partial, index) => {
    const scope = layers[index]?.scope;
    if (!scope || !isPlainObject(partial.materia)) return;
    for (const [id, definition] of Object.entries(partial.materia as Record<string, unknown>)) {
      if (isPlainObject(definition) && Array.isArray(definition.command)) sources[id] = scope;
    }
  });
  return sources;
}

function resolveUtilityExecutionBindings(config: PiMateriaConfig, commandSources: Record<string, MateriaConfigLayerScope>, layers: MateriaConfigLayer[]): void {
  // Only file-backed layers contribute a resolution directory; the read-only
  // `central` layer has no local path, so central utility materia keep their
  // commands as-is (typically absolute) and are not path-resolved.
  const configDirs = new Map(
    layers
      .filter((layer) => layer.loaded && layer.path !== undefined)
      .map((layer) => [layer.scope, path.dirname(layer.path!)]),
  );
  for (const [id, definition] of Object.entries(config.materia ?? {})) {
    if (definition.type !== "utility") continue;
    if (isShippedUtilityScriptRef(definition.script)) {
      definition.command = [definition.script.runtime ?? "node", resolveShippedUtilityScriptPath(getUserMateriaDir(), definition.script)];
      continue;
    }
    if (!Array.isArray(definition.command)) continue;
    const sourceDir = configDirs.get(commandSources[id]);
    if (!sourceDir) continue;
    definition.command = resolveUtilityCommandPaths(definition.command, sourceDir);
  }
}

function resolveUtilityCommandPaths(command: string[], sourceDir: string): string[] {
  const resolved = [...command];
  if (isRelativeScriptPath(resolved[0])) resolved[0] = path.resolve(sourceDir, resolved[0]);
  if (isNodeExecutable(resolved[0]) && isRelativeScriptPath(resolved[1])) resolved[1] = path.resolve(sourceDir, resolved[1]);
  return resolved;
}

function isNodeExecutable(command: string | undefined): boolean {
  return command === "node" || command === "nodejs" || command?.endsWith(`${path.sep}node`) === true || command?.endsWith(`${path.sep}nodejs`) === true;
}

function isRelativeScriptPath(value: string | undefined): value is string {
  return typeof value === "string" && !path.isAbsolute(value) && (value.startsWith("./") || value.startsWith("../")) && /\.(?:mjs|cjs|js)$/i.test(value);
}

function mergeConfig(base: PiMateriaConfig, parsed: Partial<PiMateriaConfig>, protectedLoadoutNames = new Set<string>()): PiMateriaConfig {
  return {
    ...base,
    ...parsed,
    budget: { ...base.budget, ...(parsed.budget ?? {}) },
    limits: { ...base.limits, ...(parsed.limits ?? {}) },
    compaction: { ...base.compaction, ...(parsed.compaction ?? {}) },
    loadouts: mergeLoadouts(base.loadouts, parsed.loadouts, protectedLoadoutNames),
    activeLoadout: parsed.activeLoadout ?? base.activeLoadout,
    activeLoadoutId: parsed.activeLoadoutId ?? base.activeLoadoutId,
    materia: mergeMateria(base.materia, parsed.materia),
    eventing: mergeEventing(base.eventing, parsed.eventing),
  } as PiMateriaConfig;
}

function mergeLoadouts(baseLoadouts: PiMateriaConfig["loadouts"], parsedLoadouts: Partial<PiMateriaConfig>["loadouts"], protectedLoadoutNames = new Set<string>(), preserveDeletedMarkers = false): PiMateriaConfig["loadouts"] {
  if (!parsedLoadouts) return baseLoadouts;
  const merged: Record<string, unknown> = { ...(baseLoadouts ?? {}) };
  for (const [name, loadout] of Object.entries(parsedLoadouts as Record<string, unknown>)) {
    if (loadout === null) {
      if (protectedLoadoutNames.has(name)) continue;
      if (preserveDeletedMarkers) merged[name] = null;
      else delete merged[name];
      continue;
    }
    if (!isPlainObject(loadout)) throw new Error(`Materia loadout "${name}" is invalid. Expected a pipeline object.`);
    if (protectedLoadoutNames.has(name)) continue;
    const baseLoadout = isPlainObject(baseLoadouts?.[name]) ? baseLoadouts[name] as MateriaPipelineConfig : undefined;
    const rawSockets = loadout.sockets ?? (baseLoadout ? loadoutSockets(baseLoadout) : {});
    const mergedLoadout = {
      ...(baseLoadout ?? {}),
      ...loadout,
      sockets: rawSockets,
      loops: loadout.loops ?? (hasLoadoutSocketMap(loadout) ? undefined : baseLoadout?.loops),
    } as MateriaPipelineConfig;
    merged[name] = normalizePipelineGraph(mergedLoadout);
  }
  return merged as PiMateriaConfig["loadouts"];
}

function hasLoadoutSocketMap(loadout: Record<string, unknown>): boolean {
  return loadout.sockets !== undefined;
}

function mergeEventing(base: PiMateriaConfig["eventing"], parsed: Partial<PiMateriaConfig>["eventing"]): PiMateriaConfig["eventing"] {
  if (parsed === undefined) return base;
  if (parsed === null) return undefined;
  const merged: NonNullable<PiMateriaConfig["eventing"]> = {
    ...(base ?? {}),
    ...parsed,
    sinks: mergeEventingSinks(base?.sinks, parsed.sinks),
    presets: parsed.presets !== undefined ? mergePresets(base?.presets, parsed.presets) : base?.presets,
  };
  return merged;
}

/**
 * Apply the documented `PI_MATERIA_EVENTING_*` environment overlay on top of a
 * fully-merged config, composed with controller-launch auto-activation.
 *
 * Called from {@link loadConfig} after `mergeConfigLayers` so launch-time
 * values take precedence over every file-backed layer
 * (default/central/user/project/explicit). Two independent env sources compose
 * here, in precedence order:
 *
 * 1. **Explicit `PI_MATERIA_EVENTING_*` overlay** (parsed by
 *    {@link readEventingEnvOverlay}) — the documented opt-in/opt-out vars a
 *    launcher may set. Highest precedence.
 * 2. **Controller-launch auto-activation** ({@link detectControllerLaunch}) —
 *    when agent_router sets `CONTROLLER_*` env vars (which it does on every
 *    launch) but does NOT set `PI_MATERIA_EVENTING_*`, eventing and the
 *    `agent-controller` preset are enabled automatically so state updates
 *    reach the controller without manual config. Controller activation only
 *    supplies defaults for fields the explicit overlay left unset, so an
 *    explicit `PI_MATERIA_EVENTING_ENABLED=false` opts out even under a
 *    controller launch.
 *
 * The overlay only touches the top-level eventing switches (`enabled`,
 * `presets`, `heartbeatIntervalMs`); configured sinks are preserved untouched
 * and `presets` is merged additively (de-duplicated).
 *
 * The overlay is in-memory only: this function never writes to config files.
 * Invalid documented values are ignored and surfaced as non-fatal warnings
 * (mirroring the existing profile-config diagnostic pattern) so they never
 * fail config load or unrelated local runs.
 *
 * @param config - The fully-merged config to overlay onto.
 * @param env - Environment to read (defaults to `process.env`). Injected for
 *   deterministic testing without mutating the real process environment.
 * @returns A config with the env overlay applied, or the same `config` when no
 *   documented variable or controller launch was present.
 */
export function applyEventingEnvOverlay(
  config: PiMateriaConfig,
  env: EventingEnvSource = process.env,
): PiMateriaConfig {
  const { overlay, present, diagnostics } = readEventingEnvOverlay(env);
  // Surface non-fatal diagnostics for invalid documented values. These mirror
  // the warnInvalidProfileConfig pattern and never fail config load.
  for (const diagnostic of diagnostics) {
    console.warn(`[pi-materia] ${diagnostic.varName}: ${diagnostic.message}`);
  }

  // Controller-launch auto-activation (docs/runtime-eventing.md §9.1).
  // agent_router sets CONTROLLER_* env vars when invoking pi-materia but does
  // NOT set the documented PI_MATERIA_EVENTING_* overlay vars. Detecting the
  // controller launch lets the agent-controller preset activate automatically
  // so state/lifecycle updates reach the controller without manual config.
  // Explicit PI_MATERIA_EVENTING_* values still take precedence — e.g.
  // PI_MATERIA_EVENTING_ENABLED=false opts out even under a controller launch.
  const controller = detectControllerLaunch(env);
  const composed = composeControllerActivation(overlay, controller.present);

  if (!present && !controller.present) return config;

  // Surface controller auto-activation so agent_router integration is debuggable
  // from session logs. This is informational (a positive expected signal), not a
  // failure, so it never blocks config load or unrelated local runs.
  if (controller.present && composed.controllerActivated) {
    console.warn(
      `[pi-materia] Controller launch detected (${controller.detected.join(", ")}); ` +
      `auto-enabling eventing with the "agent-controller" preset so state updates ` +
      `reach the controller. Set PI_MATERIA_EVENTING_ENABLED=false to opt out.`,
    );
  }

  const eventing = mergeEventing(config.eventing, composed.overlay);
  return eventing === config.eventing ? config : { ...config, eventing };
}

/**
 * Compose the explicit `PI_MATERIA_EVENTING_*` overlay with controller-launch
 * auto-activation.
 *
 * Controller activation supplies **defaults only** for fields the explicit
 * overlay left unset, so explicit values always win: a controller launch never
 * overrides an explicit `enabled: false` (opt-out) or an explicit `presets`
 * list. When the explicit overlay already set every field, controller
 * activation contributes nothing.
 *
 * Returns the composed partial eventing config plus a flag indicating whether
 * controller activation supplied any default (for diagnostics).
 */
function composeControllerActivation(
  explicit: Readonly<Partial<EventingConfig>>,
  controllerPresent: boolean,
): { overlay: Partial<EventingConfig>; controllerActivated: boolean } {
  if (!controllerPresent) {
    return { overlay: { ...explicit }, controllerActivated: false };
  }
  const composed: Partial<EventingConfig> = { ...explicit };
  let activated = false;
  if (composed.enabled === undefined) {
    composed.enabled = true;
    activated = true;
  }
  if (composed.presets === undefined) {
    composed.presets = ["agent-controller"];
    activated = true;
  }
  return { overlay: composed, controllerActivated: activated };
}

function mergePresets(basePresets: string[] | undefined, parsedPresets: string[]): string[] {
  const merged = [...(basePresets ?? [])];
  for (const preset of parsedPresets) {
    if (!merged.includes(preset)) merged.push(preset);
  }
  return merged;
}

function mergeEventingSinks(baseSinks: Record<string, EventSinkConfig> | undefined, parsedSinks: Record<string, unknown> | undefined): Record<string, EventSinkConfig> | undefined {
  if (parsedSinks === undefined) return baseSinks;
  const merged: Record<string, EventSinkConfig> = { ...(baseSinks ?? {}) };
  for (const [id, sink] of Object.entries(parsedSinks)) {
    if (sink === null) {
      delete merged[id];
      continue;
    }
    if (!isPlainObject(sink)) throw new Error(`Eventing sink "${id}" is invalid. Expected an object.`);
    const baseSink = merged[id];
    merged[id] = { ...(baseSink ?? {}), ...sink } as EventSinkConfig;
  }
  return merged;
}

function mergeMateria(baseMateria: Record<string, MateriaConfig>, parsedMateria: Partial<PiMateriaConfig>["materia"] | MateriaConfigPatch["materia"]): Record<string, MateriaConfig> {
  if (!parsedMateria) return baseMateria;
  const merged: Record<string, MateriaConfig> = { ...baseMateria };
  for (const [name, materia] of Object.entries(parsedMateria as Record<string, unknown>)) {
    if (materia === null) {
      delete merged[name];
      continue;
    }
    if (!isPlainObject(materia)) throw new Error(`Materia "${name}" is invalid. Expected a materia object.`);
    const next = { ...(baseMateria[name] ?? {}), ...materia } as Record<string, unknown>;
    for (const [key, value] of Object.entries(materia)) {
      if (value === null) delete next[key];
    }
    merged[name] = next as unknown as MateriaConfig;
  }
  return merged;
}

function normalizeLoadoutsForSave(loadouts: Partial<PiMateriaConfig>["loadouts"] | undefined, materia: Record<string, MateriaConfig> | undefined): PiMateriaConfig["loadouts"] {
  if (!loadouts) return loadouts as PiMateriaConfig["loadouts"];
  return Object.fromEntries(
    Object.entries(loadouts as Record<string, unknown>).map(([name, loadout]) => [name, loadout === null ? null : prepareLoadoutForSave(loadout as MateriaPipelineConfig, materia ?? {}, { loadoutName: name }).loadout]),
  ) as PiMateriaConfig["loadouts"];
}

function withoutDeletedLoadoutMarkers(config: Partial<PiMateriaConfig>): Partial<PiMateriaConfig> {
  if (!config.loadouts) return config;
  return {
    ...config,
    loadouts: Object.fromEntries(Object.entries(config.loadouts as Record<string, unknown>).filter(([, loadout]) => loadout !== null)) as PiMateriaConfig["loadouts"],
  };
}

function rejectDefaultLoadoutDeletes(patch: Pick<MateriaConfigPatch, "loadouts">): void {
  if (!patch.loadouts) return;
  const defaultLoadoutNames = new Set(Object.keys(JSON.parse(readFileSync(getBundledDefaultConfigPath(), "utf8")).loadouts ?? {}));
  for (const [name, loadout] of Object.entries(patch.loadouts as Record<string, unknown>)) {
    if (loadout === null && defaultLoadoutNames.has(name)) throw new Error(`Cannot delete shipped default Materia loadout "${name}".`);
  }
}

function rejectProtectedMateriaDeletes(patch: MateriaConfigPatch, existing: Partial<PiMateriaConfig>): void {
  if (!patch.materia) return;
  const defaultMateriaIds = new Set(Object.keys(JSON.parse(readFileSync(getBundledDefaultConfigPath(), "utf8")).materia ?? {}));
  const existingMateria = existing.materia as Record<string, unknown> | undefined;
  for (const [name, materia] of Object.entries(patch.materia as Record<string, unknown>)) {
    if (materia === null && defaultMateriaIds.has(name) && !Object.prototype.hasOwnProperty.call(existingMateria ?? {}, name)) {
      throw new Error(`Cannot delete shipped default Materia definition "${name}".`);
    }
  }
}

function rejectLockedMateriaContentSaves(patch: MateriaConfigPatch, existing: Partial<PiMateriaConfig>): void {
  if (!patch.materia || !isPlainObject(existing.materia)) return;
  const existingMateria = existing.materia as Record<string, unknown>;
  for (const [name, materiaPatch] of Object.entries(patch.materia as Record<string, unknown>)) {
    if (materiaPatch === null || !isPlainObject(materiaPatch)) continue;
    const current = existingMateria[name];
    if (!isPlainObject(current) || current.lockState !== "locked") continue;
    const contentKeys = Object.keys(materiaPatch).filter((key) => key !== "lockState");
    if (contentKeys.length > 0) throw new Error(`Materia definition "${name}" is locked. Unlock it before saving content changes.`);
  }
}

function rejectReadonlyDefaultLoadoutSaves(patch: Pick<MateriaConfigPatch, "loadouts">): void {
  if (!patch.loadouts) return;
  for (const [name, loadout] of Object.entries(patch.loadouts as Record<string, unknown>)) {
    if (!isPlainObject(loadout)) continue;
    if (loadout.source === "default") throw new Error(`Cannot save shipped default Materia loadout "${name}". Duplicate it before editing.`);
  }
}

function validateLoadoutGraphs(loadouts: PiMateriaConfig["loadouts"] | undefined): void {
  for (const [name, loadout] of Object.entries(loadouts ?? {}) as Array<[string, MateriaPipelineConfig]>) {
    validateCatalogOrigin(`loadouts.${name}`, loadout.catalogOrigin);
    try {
      assertValidPipelineGraph(loadout);
    } catch (error) {
      throw new Error(`Materia loadout "${name}" graph is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function validateConfigMateriaReferences(config: Pick<PiMateriaConfig, "materia" | "loadouts">): void {
  const catalog = normalizeMateriaCatalog(config.materia as unknown as Record<string, Record<string, unknown>>);
  if (!catalog.ok) {
    throw new Error(`Materia catalog is invalid: ${catalog.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  for (const [name, loadout] of Object.entries(config.loadouts ?? {}) as Array<[string, MateriaPipelineConfig]>) {
    const validation = validateLoadoutMateriaReferences(loadout as unknown as Parameters<typeof validateLoadoutMateriaReferences>[0], catalog.value, `loadouts.${name}`);
    if (!validation.ok) {
      throw new Error(`Materia loadout "${name}" has invalid materia references: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    }
  }
}

function validateMateria(materiaConfig: Record<string, MateriaConfig>): void {
  for (const [name, materia] of Object.entries(materiaConfig as Record<string, unknown>)) {
    if (!isPlainObject(materia)) throw new Error(`Materia "${name}" is invalid. Expected a materia object.`);
    if ("systemPrompt" in materia) throw new Error(`Materia "${name}" configures obsolete systemPrompt. Use prompt instead.`);
    validateMateriaLockState(name, materia.lockState);
    validateCatalogOrigin(`materia.${name}`, materia.catalogOrigin);
    const type = ensureMateriaDefinitionType(materia);
    if (type === "utility") {
      validateUtilityMateria(name, materia);
      continue;
    }
    if (materia.prompt === undefined || typeof materia.prompt !== "string") {
      throw new Error(`Materia "${name}" has invalid prompt. Expected a string.`);
    }
    if (materia.tools === undefined) {
      throw new Error(`Materia "${name}" has invalid tools. Expected ${validToolScopeShapeDescription()}.`);
    }
    const toolScope = validateToolScopeSpecShape(materia.tools, `materia.${name}.tools`);
    if (!toolScope.ok) {
      throw new Error(`Materia "${name}" has invalid tools. ${toolScope.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    }
    if (materia.model !== undefined && typeof materia.model !== "string") {
      throw new Error(`Materia "${name}" has invalid model. Expected a string when configured.`);
    }
    if (materia.thinking !== undefined && typeof materia.thinking !== "string") {
      throw new Error(`Materia "${name}" has invalid thinking. Expected a string when configured.`);
    }
    if (materia.multiTurn !== undefined && typeof materia.multiTurn !== "boolean") {
      throw new Error(`Materia "${name}" has invalid multiTurn. Expected a boolean when configured.`);
    }
    validateMateriaParseMode(name, materia.parse);
    if (materia.generator !== undefined && typeof materia.generator !== "boolean") {
      throw new Error(`Materia "${name}" has invalid generator. Expected a boolean when configured.`);
    }
    validateLegacyGeneratorDeclaration(name, materia.generates);
  }
}

function ensureMateriaDefinitionType(materia: Record<string, unknown>): "agent" | "utility" {
  if (materia.type === "agent" || materia.type === "utility") return materia.type;
  if (materia.type !== undefined) throw new Error(`Materia has invalid type. Expected "agent" or "utility".`);
  const inferred = materia.utility !== undefined || materia.command !== undefined || materia.script !== undefined ? "utility" : "agent";
  materia.type = inferred;
  return inferred;
}

function validateUtilityMateria(name: string, materia: Record<string, unknown>): void {
  if ("prompt" in materia) throw new Error(`Utility materia "${name}" must not configure prompt.`);
  if (!materia.utility && !materia.command && !materia.script) throw new Error(`Utility materia "${name}" must configure either "utility", "command", or "script".`);
  if (materia.utility !== undefined && typeof materia.utility !== "string") throw new Error(`Utility materia "${name}" has invalid utility. Expected a string.`);
  if (materia.command !== undefined) validateUtilityCommandMateria(name, materia.command);
  if (materia.script !== undefined) validateUtilityScriptMateria(name, materia.script);
  if (materia.timeoutMs !== undefined && (!Number.isFinite(materia.timeoutMs) || Number(materia.timeoutMs) <= 0)) {
    throw new Error(`Utility materia "${name}" has invalid timeoutMs. Expected a positive number of milliseconds.`);
  }
  validateMateriaParseMode(name, materia.parse);
  if (materia.generator !== undefined && typeof materia.generator !== "boolean") {
    throw new Error(`Materia "${name}" has invalid generator. Expected a boolean when configured.`);
  }
  validateLegacyGeneratorDeclaration(name, materia.generates);
}

function validateLegacyGeneratorDeclaration(name: string, generates: unknown): void {
  if (generates === undefined || generates === null) return;
  throw new Error(`Materia "${name}" configures obsolete generates metadata. Use generator: true and emit canonical JSON with workItems; custom generates.output aliases are not active runtime generator outputs.`);
}

function validateMateriaParseMode(name: string, parse: unknown): void {
  if (parse === undefined) return;
  if (parse !== "text" && parse !== "json") throw new Error(`Materia "${name}" has unsupported parse mode "${String(parse)}". Expected "text" or "json".`);
}

function validateMateriaLockState(name: string, lockState: unknown): void {
  if (lockState === undefined) return;
  if (!isMateriaLockState(lockState)) throw new Error(`Materia "${name}" has invalid lockState. Expected "locked" or "unlocked".`);
}

/** Validate persisted catalog origin provenance when present (docs/enterprise-control-plane.md §14.1). */
function validateCatalogOrigin(path: string, value: unknown): asserts value is CatalogOriginProvenance | undefined {
  if (value === undefined) return;
  if (!isValidCatalogOriginProvenance(value)) {
    throw new Error(`${path} has invalid catalogOrigin. Expected { catalogItemId, catalogVersion, catalogContentHash, source }.`);
  }
}

function isMateriaLockState(value: unknown): value is MateriaUserLockState {
  return value === "locked" || value === "unlocked";
}

function validateUtilityCommandMateria(name: string, command: unknown): void {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error(`Utility materia "${name}" has invalid command. Expected a non-empty string array.`);
  }
}

function validateUtilityScriptMateria(name: string, script: unknown): void {
  if (!isShippedUtilityScriptRef(script)) throw new Error(`Utility materia "${name}" has invalid script. Expected { kind: "shippedUtility", name: "<file>.mjs" }.`);
  resolveShippedUtilityScriptPath(getUserMateriaDir(), script);
  if (script.runtime !== undefined && script.runtime !== "node") throw new Error(`Utility materia "${name}" has invalid script runtime. Expected "node" when configured.`);
}

function rejectObsoleteConfigFields(config: Record<string, unknown>, file: string): void {
  if ("roles" in config) throw new Error(`Materia config file ${file} configures obsolete roles. Use top-level materia instead.`);
  if ("materiaDefinitions" in config) throw new Error(`Materia config file ${file} configures obsolete materiaDefinitions.`);
  for (const [name, materia] of Object.entries((config.materia ?? {}) as Record<string, unknown>)) {
    if (!isPlainObject(materia)) continue;
    if ("systemPrompt" in materia) throw new Error(`Materia "${name}" configures obsolete systemPrompt. Use prompt instead.`);
  }
  for (const [loadoutName, loadout] of Object.entries((config.loadouts ?? {}) as Record<string, unknown>)) {
    if (!isPlainObject(loadout)) continue;
    if ("prompt" in loadout) throw new Error(`Materia loadout "${loadoutName}" configures obsolete prompt. Define prompt on referenced materia instead.`);
    if ("systemPrompt" in loadout) throw new Error(`Materia loadout "${loadoutName}" configures obsolete systemPrompt. Define prompt on referenced materia instead.`);
    for (const [loopName, loop] of Object.entries((loadout.loops ?? {}) as Record<string, unknown>)) {
      if (isPlainObject(loop) && "label" in loop) throw new Error(`Materia loadout "${loadoutName}" loop "${loopName}" configures persisted label.`);
    }
    for (const [socketName, socket] of Object.entries(loadoutSockets(loadout as unknown as MateriaPipelineConfig) as Record<string, unknown>)) {
      if (!isPlainObject(socket)) continue;
      if ("type" in socket) throw new Error(`Materia loadout "${loadoutName}" socket "${socketName}" configures socket type. Define behavior on referenced materia instead.`);
      if ("role" in socket) throw new Error(`Materia loadout "${loadoutName}" socket "${socketName}" configures obsolete role. Use materia instead.`);
      if ("prompt" in socket) throw new Error(`Materia loadout "${loadoutName}" socket "${socketName}" configures obsolete prompt. Define prompt on the referenced materia instead.`);
      if ("systemPrompt" in socket) throw new Error(`Materia loadout "${loadoutName}" socket "${socketName}" configures obsolete systemPrompt. Define prompt on the referenced materia instead.`);
    }
  }
}

function isLoadoutSource(value: unknown): value is MateriaConfigLayerScope {
  return value === "default" || value === "central" || value === "user" || value === "project" || value === "explicit";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadDefaultConfig(): Promise<PiMateriaConfig> {
  return JSON.parse(await readFile(getBundledDefaultConfigPath(), "utf8")) as PiMateriaConfig;
}

export function resolveArtifactRoot(cwd: string, artifactDir?: string): string {
  return artifactDir ? resolveFromCwd(cwd, artifactDir) : path.join(cwd, ".pi", "pi-materia");
}

export function resolveFromCwd(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}
