import { afterEach, describe, expect, test } from "bun:test";
import {
  CENTRAL_BUILD_SCHEMA_VERSION,
  CENTRAL_BUILD_VERSION,
  CENTRAL_CONTROL_PLANE_SCOPE,
  CENTRAL_SERVICE_ID,
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  createMateriaCentralServer,
  type MateriaCentralServer,
  type MateriaCentralServerOptions,
} from "../src/central/index.js";

const servers: Array<MateriaCentralServer["server"]> = [];

interface AdminResponse {
  readonly ok: boolean;
  readonly scope: string;
  readonly service: string;
  readonly metadata: {
    readonly server: {
      readonly service: string;
      readonly mode: string;
      readonly buildVersion: string;
      readonly schemaVersion: number;
      readonly authMethods: readonly string[];
      readonly startedAt?: string;
    };
    readonly principals: readonly {
      readonly principalId: string;
      readonly subject?: string;
      readonly tenantId: string;
      readonly roleIds: readonly string[];
    }[];
    readonly roles: readonly {
      readonly roleId: string;
      readonly permissions: readonly string[];
    }[];
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(options: MateriaCentralServerOptions = { authMode: "development" }): Promise<string> {
  const created = createMateriaCentralServer({ port: 0, ...options });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("central admin test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

describe("central server — admin metadata", () => {
  test("exposes server/build/schema, roles, and secret-free configured principal summaries", async () => {
    const baseUrl = await startServer({ authMode: "development", label: "admin-test" });
    const response = await fetch(`${baseUrl}/api/admin`, { headers: bearer(DEFAULT_DEV_TOKEN_READER) });
    const text = await response.text();
    const body = JSON.parse(text) as AdminResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.metadata.server).toMatchObject({
      service: CENTRAL_SERVICE_ID,
      mode: "central-admin",
      buildVersion: CENTRAL_BUILD_VERSION,
      schemaVersion: CENTRAL_BUILD_SCHEMA_VERSION,
      authMethods: ["dev-token"],
    });
    expect(typeof body.metadata.server.startedAt).toBe("string");
    expect(body.metadata.principals).toEqual([
      { principalId: "dev-admin", subject: "dev-admin", tenantId: "default", roleIds: ["central-admin"] },
      { principalId: "dev-reader", subject: "dev-reader", tenantId: "default", roleIds: ["central-reader"] },
      { principalId: "dev-sink", subject: "dev-sink", tenantId: "default", roleIds: ["central-telemetry-sink"] },
    ]);
    expect(body.metadata.roles.map((role) => role.roleId)).toEqual([
      "central-admin",
      "central-catalog-writer",
      "central-reader",
      "central-telemetry-sink",
    ]);
    expect(body.metadata.roles.find((role) => role.roleId === "central-reader")?.permissions).toContain("admin.read");
    for (const secret of [DEFAULT_DEV_TOKEN_ADMIN, DEFAULT_DEV_TOKEN_READER, DEFAULT_DEV_TOKEN_SINK]) {
      expect(text).not.toContain(secret);
    }
  });

  test("requires admin.read while leaving health public", async () => {
    const baseUrl = await startServer();

    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);

    const missing = await fetch(`${baseUrl}/api/admin`);
    expect(missing.status).toBe(401);
    expect((await missing.json()) as object).toMatchObject({ error: "Unauthorized", reason: "missing" });

    const forbidden = await fetch(`${baseUrl}/api/admin`, { headers: bearer(DEFAULT_DEV_TOKEN_SINK) });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()) as object).toMatchObject({ error: "Forbidden", permission: "admin.read" });

    expect((await fetch(`${baseUrl}/api/admin`, { headers: bearer(DEFAULT_DEV_TOKEN_READER) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin`, { headers: bearer(DEFAULT_DEV_TOKEN_ADMIN) })).status).toBe(200);
  });

  test("returns 404/405 before authentication and reserves mutations for future admin.write routes", async () => {
    const baseUrl = await startServer();

    const unknown = await fetch(`${baseUrl}/api/admin/principals/unknown`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()) as object).toMatchObject({ error: "Not found" });

    const unsupported = await fetch(`${baseUrl}/api/admin`, { method: "POST" });
    expect(unsupported.status).toBe(405);
    expect((await unsupported.json()) as object).toMatchObject({ error: "Method not allowed" });
  });

  test("never exposes deployment bearer values", async () => {
    const credentials = {
      adminToken: "production-admin-secret-value",
      readToken: "production-reader-secret-value",
      telemetryToken: "production-telemetry-secret-value",
    };
    const baseUrl = await startServer({ authMode: "production", credentials });
    const response = await fetch(`${baseUrl}/api/admin`, { headers: bearer(credentials.readToken) });
    const text = await response.text();

    expect(response.status).toBe(200);
    for (const token of Object.values(credentials)) expect(text).not.toContain(token);
    const body = JSON.parse(text) as AdminResponse;
    expect(body.metadata.principals.map((principal) => principal.principalId)).toEqual([
      "central-admin",
      "central-reader",
      "central-telemetry-ingest",
    ]);
  });
});
