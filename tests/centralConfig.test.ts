import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  CENTRAL_CONFIG_ENV,
  DEFAULT_CENTRAL_CORS_ORIGIN,
  DEFAULT_CENTRAL_REQUEST_TIMEOUT_MS,
  DEFAULT_CENTRAL_RETENTION_DAYS,
  loadCentralConnectedRuntimeConfig,
  loadCentralServerConfig,
  type CentralConfigEnv,
} from "../src/central/index.js";
import type { MateriaProfileConfig } from "../src/types.js";

function env(values: Record<string, string | undefined> = {}): CentralConfigEnv {
  return values;
}

describe("central-connected runtime configuration", () => {
  test("stays local-only and performs no secret-file I/O without an API URL", async () => {
    let reads = 0;
    const config = await loadCentralConnectedRuntimeConfig({
      env: env({
        [CENTRAL_CONFIG_ENV.requestTimeoutMs]: "not-a-number",
        [CENTRAL_CONFIG_ENV.readTokenFile]: "/should/not/be/read",
      }),
      readSecretFile: async () => {
        reads += 1;
        throw new Error("unexpected read");
      },
    });

    expect(config).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("preserves the legacy WebUI API URL as a compatibility fallback", async () => {
    const profile: MateriaProfileConfig = {
      webui: { centralApiBaseUrl: "https://central.example.test/api" },
    };
    const config = await loadCentralConnectedRuntimeConfig({ env: env(), profile });

    expect(config).toEqual({
      apiUrl: "https://central.example.test/api",
      requestTimeoutMs: DEFAULT_CENTRAL_REQUEST_TIMEOUT_MS,
      credentials: {},
    });
  });

  test("uses typed profile settings and lets environment values take precedence", async () => {
    const profile: MateriaProfileConfig = {
      webui: { centralApiBaseUrl: "https://legacy.example.test" },
      central: { apiUrl: "https://profile.example.test", requestTimeoutMs: 2_500 },
    };
    const config = await loadCentralConnectedRuntimeConfig({
      env: env({
        [CENTRAL_CONFIG_ENV.apiUrl]: " https://env.example.test/control ",
        [CENTRAL_CONFIG_ENV.requestTimeoutMs]: "7500",
        [CENTRAL_CONFIG_ENV.readToken]: " reader-secret ",
        [CENTRAL_CONFIG_ENV.adminToken]: "admin-secret",
        [CENTRAL_CONFIG_ENV.telemetryToken]: "telemetry-secret",
      }),
      profile,
    });

    expect(config).toEqual({
      apiUrl: "https://env.example.test/control",
      requestTimeoutMs: 7_500,
      credentials: {
        readToken: "reader-secret",
        adminToken: "admin-secret",
        telemetryToken: "telemetry-secret",
      },
    });
  });

  test("loads role-specific credentials from *_FILE values", async () => {
    const files: Record<string, string> = {
      "/run/secrets/read": "read-file-token\n",
      "/run/secrets/admin": "admin-file-token\n",
      "/run/secrets/telemetry": "telemetry-file-token\n",
    };
    const config = await loadCentralConnectedRuntimeConfig({
      env: env({
        [CENTRAL_CONFIG_ENV.apiUrl]: "http://127.0.0.1:4000",
        [CENTRAL_CONFIG_ENV.readTokenFile]: "/run/secrets/read",
        [CENTRAL_CONFIG_ENV.adminTokenFile]: "/run/secrets/admin",
        [CENTRAL_CONFIG_ENV.telemetryTokenFile]: "/run/secrets/telemetry",
      }),
      readSecretFile: async (file) => files[file] ?? Promise.reject(new Error("missing fixture")),
    });

    expect(config?.credentials).toEqual({
      readToken: "read-file-token",
      adminToken: "admin-file-token",
      telemetryToken: "telemetry-file-token",
    });
  });

  test("validates explicit runtime settings and ambiguous secret sources", async () => {
    await expect(loadCentralConnectedRuntimeConfig({
      env: env({ [CENTRAL_CONFIG_ENV.apiUrl]: "file:///tmp/control-plane" }),
    })).rejects.toThrow(CENTRAL_CONFIG_ENV.apiUrl);

    await expect(loadCentralConnectedRuntimeConfig({
      env: env({
        [CENTRAL_CONFIG_ENV.apiUrl]: "https://central.example.test",
        [CENTRAL_CONFIG_ENV.requestTimeoutMs]: "0",
      }),
    })).rejects.toThrow(CENTRAL_CONFIG_ENV.requestTimeoutMs);

    await expect(loadCentralConnectedRuntimeConfig({
      env: env({
        [CENTRAL_CONFIG_ENV.apiUrl]: "https://central.example.test",
        [CENTRAL_CONFIG_ENV.adminToken]: "direct",
        [CENTRAL_CONFIG_ENV.adminTokenFile]: "/run/secrets/admin",
      }),
    })).rejects.toThrow(/cannot set both.*ADMIN_TOKEN.*ADMIN_TOKEN_FILE/i);
  });
});

describe("central standalone server configuration", () => {
  test("provides typed local-development defaults only when explicitly enabled", async () => {
    const config = await loadCentralServerConfig({
      env: env({ [CENTRAL_CONFIG_ENV.authMode]: "development" }),
      cwd: "/srv/materia",
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(0);
    expect(config.databasePath).toBe(path.resolve("/srv/materia", "data/pi-materia-central.sqlite"));
    expect(config.retentionDays).toBe(DEFAULT_CENTRAL_RETENTION_DAYS);
    expect(config.corsOrigin).toBe(DEFAULT_CENTRAL_CORS_ORIGIN);
    expect(config.authMode).toBe("development");
    expect(config.credentials).toEqual({});
  });

  test("loads bind, database, retention, CORS, label, and secret settings", async () => {
    const config = await loadCentralServerConfig({
      cwd: "/srv/materia",
      env: env({
        [CENTRAL_CONFIG_ENV.host]: "0.0.0.0",
        [CENTRAL_CONFIG_ENV.port]: "8787",
        [CENTRAL_CONFIG_ENV.databasePath]: "state/control.sqlite",
        [CENTRAL_CONFIG_ENV.retentionDays]: "90",
        [CENTRAL_CONFIG_ENV.corsOrigin]: "https://admin.example.test",
        [CENTRAL_CONFIG_ENV.label]: "production-a",
        [CENTRAL_CONFIG_ENV.readTokenFile]: "/run/secrets/read",
        [CENTRAL_CONFIG_ENV.adminToken]: "admin-from-env",
        [CENTRAL_CONFIG_ENV.telemetryToken]: "telemetry-from-env",
      }),
      readSecretFile: async () => "reader-from-file\n",
    });

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 8787,
      databasePath: path.resolve("/srv/materia", "state/control.sqlite"),
      retentionDays: 90,
      corsOrigin: "https://admin.example.test",
      authMode: "production",
      credentials: {
        readToken: "reader-from-file",
        adminToken: "admin-from-env",
        telemetryToken: "telemetry-from-env",
      },
      label: "production-a",
    });
  });

  test("rejects insecure or invalid production authentication settings", async () => {
    await expect(loadCentralServerConfig({ env: env() })).rejects.toThrow(/production authentication.*missing/i);
    await expect(loadCentralServerConfig({
      env: env({ [CENTRAL_CONFIG_ENV.authMode]: "preview" }),
    })).rejects.toThrow(CENTRAL_CONFIG_ENV.authMode);
    await expect(loadCentralServerConfig({
      env: env({
        [CENTRAL_CONFIG_ENV.readToken]: "same-token",
        [CENTRAL_CONFIG_ENV.adminToken]: "same-token",
        [CENTRAL_CONFIG_ENV.telemetryToken]: "telemetry-token",
      }),
    })).rejects.toThrow(/distinct bearer token/i);
  });

  test("does not include secret-provider details in file-read diagnostics", async () => {
    const providerDetail = "provider accidentally returned secret-value";
    let message = "";
    try {
      await loadCentralServerConfig({
        env: env({
          [CENTRAL_CONFIG_ENV.authMode]: "development",
          [CENTRAL_CONFIG_ENV.readTokenFile]: "/run/secrets/read",
        }),
        readSecretFile: async () => { throw new Error(providerDetail); },
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain(CENTRAL_CONFIG_ENV.readTokenFile);
    expect(message).not.toContain(providerDetail);
  });

  test("rejects invalid ports and retention", async () => {
    const development = { [CENTRAL_CONFIG_ENV.authMode]: "development" };
    await expect(loadCentralServerConfig({
      env: env({ ...development, [CENTRAL_CONFIG_ENV.port]: "70000" }),
    })).rejects.toThrow(CENTRAL_CONFIG_ENV.port);
    await expect(loadCentralServerConfig({
      env: env({ ...development, [CENTRAL_CONFIG_ENV.retentionDays]: "forever" }),
    })).rejects.toThrow(CENTRAL_CONFIG_ENV.retentionDays);
  });
});
