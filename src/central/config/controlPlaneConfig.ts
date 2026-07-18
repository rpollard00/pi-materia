import path from "node:path";
import type { MateriaProfileConfig } from "../../types.js";
import {
  readCentralSecret,
  type CentralConfigEnv,
  type CentralSecretFileReader,
} from "./secretValue.js";

/** Environment contract shared by the standalone server and connected runtimes. */
export const CENTRAL_CONFIG_ENV = {
  apiUrl: "MATERIA_CENTRAL_API_URL",
  requestTimeoutMs: "MATERIA_CENTRAL_REQUEST_TIMEOUT_MS",
  databasePath: "MATERIA_CENTRAL_DATABASE_PATH",
  retentionDays: "MATERIA_CENTRAL_RETENTION_DAYS",
  host: "MATERIA_CENTRAL_HOST",
  port: "MATERIA_CENTRAL_PORT",
  corsOrigin: "MATERIA_CENTRAL_CORS_ORIGIN",
  label: "MATERIA_CENTRAL_LABEL",
  authMode: "MATERIA_CENTRAL_AUTH_MODE",
  readToken: "MATERIA_CENTRAL_READ_TOKEN",
  readTokenFile: "MATERIA_CENTRAL_READ_TOKEN_FILE",
  adminToken: "MATERIA_CENTRAL_ADMIN_TOKEN",
  adminTokenFile: "MATERIA_CENTRAL_ADMIN_TOKEN_FILE",
  telemetryToken: "MATERIA_CENTRAL_TELEMETRY_TOKEN",
  telemetryTokenFile: "MATERIA_CENTRAL_TELEMETRY_TOKEN_FILE",
} as const;

export const DEFAULT_CENTRAL_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_CENTRAL_DATABASE_PATH = "data/pi-materia-central.sqlite";
export const DEFAULT_CENTRAL_RETENTION_DAYS = 30;
export const DEFAULT_CENTRAL_HOST = "127.0.0.1";
export const DEFAULT_CENTRAL_PORT = 0;
export const DEFAULT_CENTRAL_CORS_ORIGIN = "*";
export const DEFAULT_CENTRAL_AUTH_MODE: CentralServerAuthMode = "production";

/**
 * Authentication posture for the standalone server. Development mode is
 * deliberately opt-in because it enables the built-in development credentials.
 */
export type CentralServerAuthMode = "production" | "development";

/** Role-specific bearer values. Undefined means that role is not configured. */
export interface CentralCredentialConfig {
  readonly readToken?: string;
  readonly adminToken?: string;
  readonly telemetryToken?: string;
}

/** Configuration used only when a local runtime is explicitly central-connected. */
export interface CentralConnectedRuntimeConfig {
  readonly apiUrl: string;
  readonly requestTimeoutMs: number;
  readonly credentials: CentralCredentialConfig;
}

/** Configuration for the standalone central HTTP server process. */
export interface CentralServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly retentionDays: number;
  readonly corsOrigin: string;
  readonly authMode: CentralServerAuthMode;
  readonly credentials: CentralCredentialConfig;
  readonly label?: string;
}

export interface LoadCentralConnectedRuntimeConfigOptions {
  readonly env?: CentralConfigEnv;
  /**
   * Profile settings are intentionally optional. `central.apiUrl` is the new
   * runtime setting; `webui.centralApiBaseUrl` remains a compatibility fallback.
   */
  readonly profile?: MateriaProfileConfig;
  readonly readSecretFile?: CentralSecretFileReader;
}

export interface LoadCentralServerConfigOptions {
  readonly env?: CentralConfigEnv;
  /** Base directory for a relative database path. Defaults to process.cwd(). */
  readonly cwd?: string;
  readonly readSecretFile?: CentralSecretFileReader;
}

/**
 * Load connected-runtime configuration. This short-circuits before reading any
 * secret file when no API URL is configured, preserving the local-only path.
 */
export async function loadCentralConnectedRuntimeConfig(
  options: LoadCentralConnectedRuntimeConfigOptions = {},
): Promise<CentralConnectedRuntimeConfig | undefined> {
  const env = options.env ?? process.env;
  const envApiUrl = nonEmpty(env[CENTRAL_CONFIG_ENV.apiUrl]);
  const profileApiUrl = nonEmpty(options.profile?.central?.apiUrl)
    ?? nonEmpty(options.profile?.webui?.centralApiBaseUrl);
  const apiUrl = parseHttpUrl(envApiUrl ?? profileApiUrl);

  // Invalid persisted WebUI values historically degrade to local-only. Keep
  // that behavior; explicit environment configuration is validated strictly.
  if (apiUrl === undefined) {
    if (envApiUrl !== undefined) {
      throw new Error(`${CENTRAL_CONFIG_ENV.apiUrl} must be an absolute http(s) URL.`);
    }
    return undefined;
  }

  const envTimeout = nonEmpty(env[CENTRAL_CONFIG_ENV.requestTimeoutMs]);
  const requestTimeoutMs = envTimeout === undefined
    ? positiveIntegerOrDefault(options.profile?.central?.requestTimeoutMs, DEFAULT_CENTRAL_REQUEST_TIMEOUT_MS)
    : parsePositiveInteger(envTimeout, CENTRAL_CONFIG_ENV.requestTimeoutMs);
  const credentials = await loadCentralCredentials(env, options.readSecretFile);
  return { apiUrl, requestTimeoutMs, credentials };
}

/** Load and validate standalone server configuration without starting a server. */
export async function loadCentralServerConfig(
  options: LoadCentralServerConfigOptions = {},
): Promise<CentralServerConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configuredDatabasePath = nonEmpty(env[CENTRAL_CONFIG_ENV.databasePath]) ?? DEFAULT_CENTRAL_DATABASE_PATH;
  const host = nonEmpty(env[CENTRAL_CONFIG_ENV.host]) ?? DEFAULT_CENTRAL_HOST;
  const portRaw = nonEmpty(env[CENTRAL_CONFIG_ENV.port]);
  const retentionRaw = nonEmpty(env[CENTRAL_CONFIG_ENV.retentionDays]);
  const credentials = await loadCentralCredentials(env, options.readSecretFile);
  const authMode = parseAuthMode(nonEmpty(env[CENTRAL_CONFIG_ENV.authMode]));
  validateCentralServerCredentials(authMode, credentials);
  const label = nonEmpty(env[CENTRAL_CONFIG_ENV.label]);

  return {
    host,
    port: portRaw === undefined ? DEFAULT_CENTRAL_PORT : parsePort(portRaw),
    databasePath: path.resolve(cwd, configuredDatabasePath),
    retentionDays: retentionRaw === undefined
      ? DEFAULT_CENTRAL_RETENTION_DAYS
      : parsePositiveInteger(retentionRaw, CENTRAL_CONFIG_ENV.retentionDays),
    corsOrigin: nonEmpty(env[CENTRAL_CONFIG_ENV.corsOrigin]) ?? DEFAULT_CENTRAL_CORS_ORIGIN,
    authMode,
    credentials,
    ...(label !== undefined ? { label } : {}),
  };
}

async function loadCentralCredentials(
  env: CentralConfigEnv,
  readSecretFile?: CentralSecretFileReader,
): Promise<CentralCredentialConfig> {
  const readToken = await readCentralSecret(env, {
    value: CENTRAL_CONFIG_ENV.readToken,
    file: CENTRAL_CONFIG_ENV.readTokenFile,
  }, readSecretFile);
  const adminToken = await readCentralSecret(env, {
    value: CENTRAL_CONFIG_ENV.adminToken,
    file: CENTRAL_CONFIG_ENV.adminTokenFile,
  }, readSecretFile);
  const telemetryToken = await readCentralSecret(env, {
    value: CENTRAL_CONFIG_ENV.telemetryToken,
    file: CENTRAL_CONFIG_ENV.telemetryTokenFile,
  }, readSecretFile);
  return {
    ...(readToken !== undefined ? { readToken } : {}),
    ...(adminToken !== undefined ? { adminToken } : {}),
    ...(telemetryToken !== undefined ? { telemetryToken } : {}),
  };
}

/**
 * Validate the role-specific credential set before server startup. Production
 * requires three distinct credentials so no route group silently starts with a
 * development fallback or an ambiguous role binding.
 */
export function validateCentralServerCredentials(
  authMode: CentralServerAuthMode,
  credentials: CentralCredentialConfig,
): void {
  const entries = [
    [CENTRAL_CONFIG_ENV.readToken, credentials.readToken],
    [CENTRAL_CONFIG_ENV.adminToken, credentials.adminToken],
    [CENTRAL_CONFIG_ENV.telemetryToken, credentials.telemetryToken],
  ] as const;

  if (authMode === "production") {
    const missing = entries.filter(([, token]) => token === undefined).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `Central production authentication requires configured reader, admin, and telemetry credentials; missing ${missing.join(", ")}.`,
      );
    }
  }

  const configured = entries.flatMap(([, token]) => token === undefined ? [] : [token]);
  if (new Set(configured).size !== configured.length) {
    throw new Error("Central reader, admin, and telemetry credentials must use distinct bearer token values.");
  }
}

function parseAuthMode(value: string | undefined): CentralServerAuthMode {
  if (value === undefined) return DEFAULT_CENTRAL_AUTH_MODE;
  if (value === "production" || value === "development") return value;
  throw new Error(`${CENTRAL_CONFIG_ENV.authMode} must be either production or development.`);
}

function parseHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${CENTRAL_CONFIG_ENV.port} must be an integer from 0 through 65535.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${CENTRAL_CONFIG_ENV.port} must be an integer from 0 through 65535.`);
  }
  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
