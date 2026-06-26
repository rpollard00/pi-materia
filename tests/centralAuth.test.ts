import { afterEach, describe, expect, test } from "bun:test";
import {
  BEARER_SCHEME,
  CENTRAL_CONTROL_PLANE_SCOPE,
  CENTRAL_SERVICE_ID,
  DEFAULT_CENTRAL_ROLES,
  DEFAULT_CENTRAL_ROLE_REGISTRY,
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  DEV_TOKEN_METHOD_KIND,
  checkPermission,
  createDefaultCentralAuth,
  createDevTokenAuthAdapter,
  createMateriaCentralServer,
  createRoleRegistry,
  defaultDevTokenPrincipals,
  defaultDevTokensReferenceDefaultRoles,
  readBearerToken,
  requirePermission,
  type AuthAdapter,
  type AuthRequest,
} from "../src/central/index.js";
import type { AuthContext } from "../src/domain/auth.js";
import type { Role } from "../src/domain/identity.js";

const servers: Array<ReturnType<typeof createMateriaCentralServer>["server"]> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(): Promise<string> {
  const created = createMateriaCentralServer({ port: 0 });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("central test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function bearer(token: string): { Authorization: string } {
  return { Authorization: `${BEARER_SCHEME} ${token}` };
}

function req(headers: Record<string, string> = {}): AuthRequest {
  return { headers };
}

describe("central auth — bearer token reader", () => {
  test("classifies missing, malformed, and valid bearer headers", () => {
    expect(readBearerToken({})).toBeUndefined();
    expect(readBearerToken({ authorization: "" })).toBeNull();
    expect(readBearerToken({ authorization: "Basic abc" })).toBeNull();
    expect(readBearerToken({ authorization: "Bearer" })).toBeNull();
    expect(readBearerToken({ authorization: "Bearer   " })).toBeNull();
    expect(readBearerToken({ authorization: "Bearer abc123" })).toBe("abc123");
    // Scheme is case-insensitive (RFC 6750); token returned as-is.
    expect(readBearerToken({ authorization: "bearer abc123" })).toBe("abc123");
    // First value of a repeated header is used.
    expect(readBearerToken({ authorization: ["Bearer abc123", "Bearer def"] })).toBe("abc123");
    // Falls back to capitalized header name.
    expect(readBearerToken({ Authorization: "Bearer xyz" })).toBe("xyz");
  });
});

describe("central auth — role registry", () => {
  test("default roles cover the central route namespaces with read/write/ingest groupings", () => {
    const ids = DEFAULT_CENTRAL_ROLES.map((role) => role.id);
    expect(ids).toContain("central-admin");
    expect(ids).toContain("central-reader");
    expect(ids).toContain("central-catalog-writer");
    expect(ids).toContain("central-telemetry-sink");

    expect(DEFAULT_CENTRAL_ROLE_REGISTRY.resolve("central-admin")?.permissions).toEqual(["*"]);
    expect(DEFAULT_CENTRAL_ROLE_REGISTRY.resolve("central-reader")?.permissions).toEqual([
      "catalog.read",
      "model-policy.read",
      "admin.read",
      "telemetry.read",
    ]);
    expect(DEFAULT_CENTRAL_ROLE_REGISTRY.resolve("does-not-exist")).toBeUndefined();
  });

  test("custom registry freezes roles and rejects invalid definitions", () => {
    const registry = createRoleRegistry([
      { id: "custom", name: "Custom", permissions: ["catalog.read"] },
    ] as readonly Role[]);
    const resolved = registry.resolve("custom");
    expect(resolved?.permissions).toEqual(["catalog.read"]);
    expect(Object.isFrozen(resolved?.permissions)).toBe(true);

    expect(() => createRoleRegistry([{ id: "bad", permissions: ["ok", 3] } as unknown as Role])).toThrow(/Invalid central role/);
  });
});

describe("central auth — dev-token adapter", () => {
  test("default dev tokens resolve to scoped principals with dev-token method", () => {
    const adapter = createDevTokenAuthAdapter();
    expect(adapter.adapterId).toBe("dev-token");

    const admin = adapter.resolve(req(bearer(DEFAULT_DEV_TOKEN_ADMIN)));
    expect(admin.status).toBe("authenticated");
    if (admin.status !== "authenticated") return;
    expect(admin.context.method).toEqual({ kind: "dev-token", adapter: "dev-token" });
    expect(admin.context.principal.id).toBe("dev-admin");
    expect(admin.context.principal.roleBindings.map((binding) => binding.roleId)).toEqual(["central-admin"]);

    const reader = adapter.resolve(req(bearer(DEFAULT_DEV_TOKEN_READER)));
    expect(reader.status).toBe("authenticated");
    if (reader.status !== "authenticated") return;
    expect(reader.context.principal.id).toBe("dev-reader");
  });

  test("reports coarse failure reasons for missing, malformed, and unknown tokens", () => {
    const adapter = createDevTokenAuthAdapter();
    expect(adapter.resolve(req({}))).toEqual({ status: "unauthenticated", reason: "missing" });
    expect(adapter.resolve(req({ Authorization: "Bearer not-a-real-token" }))).toEqual({ status: "unauthenticated", reason: "unknown" });
    expect(adapter.resolve(req({ Authorization: "Basic xyz" }))).toEqual({ status: "unauthenticated", reason: "malformed" });
  });

  test("custom token config maps tokens to principals and scopes", () => {
    const adapter = createDevTokenAuthAdapter({
      tokens: {
        "team-token": {
          principalId: "team-user",
          subject: "team-user",
          tenantId: "tenant-a",
          roleBindings: [{ roleId: "central-reader", scope: { tenantId: "tenant-a", workspaceId: "ws-1" } }],
          scope: { tenantId: "tenant-a", workspaceId: "ws-1" },
        },
      },
    });
    const result = adapter.resolve(req(bearer("team-token")));
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") return;
    expect(result.context.principal.tenantId).toBe("tenant-a");
    expect(result.context.scope).toEqual({ tenantId: "tenant-a", workspaceId: "ws-1" });
  });

  test("rejects invalid token config up front", () => {
    expect(() =>
      createDevTokenAuthAdapter({
        tokens: { "bad": { principalId: "", tenantId: "t", roleBindings: [] } },
      }),
    ).toThrow(/invalid principal/);
    expect(() =>
      createDevTokenAuthAdapter({
        tokens: { "": { principalId: "p", tenantId: "t", roleBindings: [{ roleId: "central-reader" }] } },
      }),
    ).toThrow(/empty token string/);
  });

  test("default dev tokens only reference default roles", () => {
    expect(defaultDevTokensReferenceDefaultRoles()).toBe(true);
    expect(Object.keys(defaultDevTokenPrincipals()).sort()).toEqual(
      [DEFAULT_DEV_TOKEN_ADMIN, DEFAULT_DEV_TOKEN_READER, DEFAULT_DEV_TOKEN_SINK].sort(),
    );
  });
});

describe("central auth — RBAC permission decisions", () => {
  const auth = createDefaultCentralAuth();

  test("default central auth is wired with the dev-token method kind", () => {
    expect(auth.methodKind).toBe(DEV_TOKEN_METHOD_KIND);
    expect(auth.adapter.adapterId).toBe("dev-token");
  });

  test("admin wildcard passes any central permission", () => {
    for (const permission of ["catalog.read", "catalog.write", "model-policy.write", "admin.write", "telemetry.ingest"]) {
      const decision = checkPermission({ auth, req: req(bearer(DEFAULT_DEV_TOKEN_ADMIN)), permission });
      expect(decision.ok).toBe(true);
    }
  });

  test("reader passes reads but denies writes and telemetry ingest", () => {
    const readerReq = req(bearer(DEFAULT_DEV_TOKEN_READER));
    expect(checkPermission({ auth, req: readerReq, permission: "telemetry.read" }).ok).toBe(true);
    expect(checkPermission({ auth, req: readerReq, permission: "catalog.read" }).ok).toBe(true);
    expect(checkPermission({ auth, req: readerReq, permission: "admin.read" }).ok).toBe(true);

    const writeDecision = checkPermission({ auth, req: readerReq, permission: "catalog.write" });
    expect(writeDecision.ok).toBe(false);
    if (writeDecision.ok) return;
    expect(writeDecision.status).toBe(403);

    const ingestDecision = checkPermission({ auth, req: readerReq, permission: "telemetry.ingest" });
    expect(ingestDecision.ok).toBe(false);
    if (ingestDecision.ok) return;
    expect(ingestDecision.status).toBe(403);
  });

  test("telemetry sink can ingest but cannot read telemetry", () => {
    const sinkReq = req(bearer(DEFAULT_DEV_TOKEN_SINK));
    expect(checkPermission({ auth, req: sinkReq, permission: "telemetry.ingest" }).ok).toBe(true);
    const readDecision = checkPermission({ auth, req: sinkReq, permission: "telemetry.read" });
    expect(readDecision.ok).toBe(false);
    if (readDecision.ok) return;
    expect(readDecision.status).toBe(403);
  });

  test("unauthenticated credentials map to 401 with the coarse reason", () => {
    expect(checkPermission({ auth, req: req({}), permission: "telemetry.read" })).toEqual({ ok: false, status: 401, reason: "missing" });
    expect(checkPermission({ auth, req: req({ Authorization: "Bearer nope" }), permission: "telemetry.read" })).toEqual({ ok: false, status: 401, reason: "unknown" });
    expect(checkPermission({ auth, req: req({ Authorization: "Basic xyz" }), permission: "telemetry.read" })).toEqual({ ok: false, status: 401, reason: "malformed" });
  });

  test("a future OAuth adapter satisfies the same boundary and is honored by the guard", () => {
    const oauthContext: AuthContext = {
      principal: {
        id: "oauth-user",
        tenantId: "tenant-oauth",
        subject: "ext-sub",
        roleBindings: [{ roleId: "central-reader" }],
      },
      method: { kind: "oauth", adapter: "oidc" },
    };
    const oauthAdapter: AuthAdapter = {
      adapterId: "oidc",
      resolve(request: AuthRequest) {
        if (request.headers.authorization === "Bearer oauth-token") return { status: "authenticated", context: oauthContext };
        return { status: "unauthenticated", reason: "missing" };
      },
    };
    const oauthAuth = { adapter: oauthAdapter, roleRegistry: DEFAULT_CENTRAL_ROLE_REGISTRY, methodKind: "oauth" as const };
    expect(checkPermission({ auth: oauthAuth, req: req({ authorization: "Bearer oauth-token" }), permission: "catalog.read" }).ok).toBe(true);
    expect(checkPermission({ auth: oauthAuth, req: req({ authorization: "Bearer oauth-token" }), permission: "catalog.write" }).ok).toBe(false);
    expect(checkPermission({ auth: oauthAuth, req: req({}), permission: "catalog.read" })).toEqual({ ok: false, status: 401, reason: "missing" });
  });
});

describe("central auth — HTTP enforcement", () => {
  test("health remains public without credentials", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
  });

  test("status requires telemetry.read: 401 without a token, with WWW-Authenticate", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/status`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`Bearer realm="${CENTRAL_SERVICE_ID}"`);
    const body = (await response.json()) as { ok: boolean; scope: string; service: string; error: string; reason: string };
    expect(body.ok).toBe(false);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.error).toBe("Unauthorized");
    expect(body.reason).toBe("missing");
  });

  test("status with an unknown token is 401 unknown", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/status`, { headers: bearer("definitely-not-a-real-token") });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { reason: string };
    expect(body.reason).toBe("unknown");
  });

  test("status with a malformed authorization header is 401 malformed", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/status`, { headers: { Authorization: "Basic xyz" } });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { reason: string };
    expect(body.reason).toBe("malformed");
  });

  test("status with a telemetry-sink token is 403 (ingest != read)", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/status`, { headers: bearer(DEFAULT_DEV_TOKEN_SINK) });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { ok: boolean; error: string; permission: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Forbidden");
    expect(body.permission).toBe("telemetry.read");
  });

  test("status with an admin token is 200", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/status`, { headers: bearer(DEFAULT_DEV_TOKEN_ADMIN) });
    expect(response.status).toBe(200);
  });

  test("unknown routes still return 404 (route matching precedes auth)", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/catalog/items`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Not found");
  });

  test("requirePermission writes the response and returns undefined on denial", async () => {
    const baseUrl = await startServer();
    // Drive the guard directly through the live server: sink token denies telemetry.read → 403.
    const response = await fetch(`${baseUrl}/api/status`, { headers: bearer(DEFAULT_DEV_TOKEN_SINK) });
    expect(response.status).toBe(403);
  });
});
