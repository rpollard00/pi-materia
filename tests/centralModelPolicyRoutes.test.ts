import { afterEach, describe, expect, test } from "bun:test";
import {
  CENTRAL_CONTROL_PLANE_SCOPE,
  CENTRAL_SERVICE_ID,
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  createInMemoryCentralPorts,
  createMateriaCentralServer,
  type MateriaCentralServer,
} from "../src/central/index.js";
import type { CentralModelCatalog, ControlPlanePorts, ModelPolicyDocument } from "../src/application/index.js";

const servers: Array<MateriaCentralServer["server"]> = [];

const ADMIN = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_ADMIN}` };
const READER = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_READER}` };
const SINK = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_SINK}` };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function policyDocument(overrides: Partial<ModelPolicyDocument> = {}): ModelPolicyDocument {
  return {
    id: "ignored",
    allow: [{ value: "zai/glm-4.6" }, { value: "anthropic/claude" }],
    deny: [{ value: "forbidden/model" }],
    prefer: [{ value: "anthropic/claude" }],
    severity: "enforced",
    ...overrides,
  };
}

async function startPolicyServer(ports?: ControlPlanePorts): Promise<{ baseUrl: string; ports: ControlPlanePorts }> {
  const resolvedPorts = ports ?? createInMemoryCentralPorts();
  const created = createMateriaCentralServer({ port: 0, ports: resolvedPorts, authMode: "development" });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("central policy test server did not bind to a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, ports: resolvedPorts };
}

async function createPolicy(
  baseUrl: string,
  id: string,
  document: ModelPolicyDocument,
  options: { setActive?: boolean } = {},
): Promise<{
  result: { action: string; policy: { id: string; version: string }; activePolicyId?: string; audit?: { action: string; principalId?: string } };
}> {
  const response = await fetch(`${baseUrl}/api/model-policy/policies`, {
    method: "POST",
    headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ id, document, ...(options.setActive !== undefined ? { setActive: options.setActive } : {}) }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    result: { action: string; policy: { id: string; version: string }; activePolicyId?: string; audit?: { action: string; principalId?: string } };
  };
}

describe("central model-policy HTTP routes — RBAC", () => {
  test("reads require model-policy.read: 401 without credentials, 403 for telemetry-sink token", async () => {
    const { baseUrl } = await startPolicyServer();

    const noCreds = await fetch(`${baseUrl}/api/model-policy/policies`);
    expect(noCreds.status).toBe(401);
    const noCredsBody = (await noCreds.json()) as { ok: boolean; scope: string; service: string; error: string };
    expect(noCredsBody.ok).toBe(false);
    expect(noCredsBody.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(noCredsBody.service).toBe(CENTRAL_SERVICE_ID);
    expect(noCreds.headers.get("www-authenticate")).toContain("Bearer");

    const sinkRes = await fetch(`${baseUrl}/api/model-policy/policies`, { headers: SINK });
    expect(sinkRes.status).toBe(403);
    const sinkBody = (await sinkRes.json()) as { permission: string };
    expect(sinkBody.permission).toBe("model-policy.read");
  });

  test("reader can read policies but cannot write (403 on create)", async () => {
    const { baseUrl } = await startPolicyServer();

    const listRes = await fetch(`${baseUrl}/api/model-policy/policies`, { headers: READER });
    expect(listRes.status).toBe(200);

    const createRes = await fetch(`${baseUrl}/api/model-policy/policies`, {
      method: "POST",
      headers: { ...READER, "content-type": "application/json" },
      body: JSON.stringify({ id: "r1", document: policyDocument() }),
    });
    expect(createRes.status).toBe(403);
    expect(((await createRes.json()) as { permission: string }).permission).toBe("model-policy.write");
  });

  test("unknown sub-paths return 404 without leaking through a 401", async () => {
    const { baseUrl } = await startPolicyServer();
    const res = await fetch(`${baseUrl}/api/model-policy/policies/p1/unknown-action`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Not found");
  });
});

describe("central model-policy HTTP routes — reads", () => {
  test("GET /api/model-policy returns the active policy and activePolicyId, independent of local availability", async () => {
    const { baseUrl } = await startPolicyServer();
    await createPolicy(baseUrl, "active-1", policyDocument(), { setActive: true });

    const res = await fetch(`${baseUrl}/api/model-policy`, { headers: READER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scope: string;
      service: string;
      activePolicyId: string;
      policy: { id: string; version: string; deny: { value: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.activePolicyId).toBe("active-1");
    expect(body.policy.id).toBe("active-1");
    expect(body.policy.version).toBe("1");
    expect(body.policy.deny).toEqual([{ value: "forbidden/model" }]);
  });

  test("GET /api/model-policy omits policy fields when no active policy is configured", async () => {
    const { baseUrl } = await startPolicyServer();
    const res = await fetch(`${baseUrl}/api/model-policy`, { headers: READER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; policy?: unknown; activePolicyId?: string };
    expect(body.ok).toBe(true);
    expect(body.policy).toBeUndefined();
    expect(body.activePolicyId).toBeUndefined();
  });

  test("GET /api/model-policy/policies lists documents and reports the active policy id", async () => {
    const { baseUrl } = await startPolicyServer();
    await createPolicy(baseUrl, "alpha", policyDocument(), { setActive: true });
    await createPolicy(baseUrl, "beta", policyDocument());

    const res = await fetch(`${baseUrl}/api/model-policy/policies`, { headers: READER });
    const body = (await res.json()) as { policies: { id: string }[]; activePolicyId: string };
    expect(body.policies.map((policy) => policy.id)).toEqual(["alpha", "beta"]);
    expect(body.activePolicyId).toBe("alpha");
  });

  test("GET /api/model-policy/policies/:id returns the document and 404s when missing", async () => {
    const { baseUrl } = await startPolicyServer();
    await createPolicy(baseUrl, "buildga", policyDocument({ allow: [{ value: "zai/glm-4.6" }] }));

    const res = await fetch(`${baseUrl}/api/model-policy/policies/buildga`, { headers: READER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; policy: { id: string; version: string; allow: { value: string }[] } };
    expect(body.policy.id).toBe("buildga");
    expect(body.policy.version).toBe("1");
    expect(body.policy.allow).toEqual([{ value: "zai/glm-4.6" }]);

    const missing = await fetch(`${baseUrl}/api/model-policy/policies/missing`, { headers: READER });
    expect(missing.status).toBe(404);
  });
});

describe("central model-policy HTTP routes — admin writes", () => {
  test("POST creates a policy, stamps the acting principal in audit, and 409s on conflict", async () => {
    const { baseUrl } = await startPolicyServer();
    const created = await createPolicy(baseUrl, "c1", policyDocument(), { setActive: true });
    expect(created.result.action).toBe("created");
    expect(created.result.policy.id).toBe("c1");
    expect(created.result.activePolicyId).toBe("c1");
    expect(created.result.audit?.action).toBe("model-policy.created");
    expect(created.result.audit?.principalId).toBe("dev-admin");

    const conflict = await fetch(`${baseUrl}/api/model-policy/policies`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "c1", document: policyDocument() }),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { code: string; error: string };
    expect(conflictBody.code).toBe("conflict");
    expect(conflictBody.error).toMatch(/already exists/);
  });

  test("POST rejects malformed bodies with 400", async () => {
    const { baseUrl } = await startPolicyServer();

    const missingDocument = await fetch(`${baseUrl}/api/model-policy/policies`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "x" }),
    });
    expect(missingDocument.status).toBe(400);

    const invalidDocument = await fetch(`${baseUrl}/api/model-policy/policies`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "x", document: { id: "x", allow: "not-an-array" } }),
    });
    expect(invalidDocument.status).toBe(400);
    expect(((await invalidDocument.json()) as { error: string }).error).toMatch(/structural validation/);
  });

  test("PATCH updates the document, bumps version, and 404s on unknown items", async () => {
    const { baseUrl } = await startPolicyServer();
    await createPolicy(baseUrl, "u1", policyDocument());

    const res = await fetch(`${baseUrl}/api/model-policy/policies/u1`, {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ document: policyDocument({ deny: [{ value: "other/model" }] }) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { action: string; policy: { version: string; deny: { value: string }[] } } };
    expect(body.result.action).toBe("updated");
    expect(body.result.policy.version).toBe("2");
    expect(body.result.policy.deny).toEqual([{ value: "other/model" }]);

    const missing = await fetch(`${baseUrl}/api/model-policy/policies/missing`, {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ document: policyDocument() }),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("not_found");
  });

  test("PATCH honors ?expectedVersion and surfaces currentVersion on mismatch", async () => {
    const { baseUrl } = await startPolicyServer();
    await createPolicy(baseUrl, "v1", policyDocument());

    const stale = await fetch(`${baseUrl}/api/model-policy/policies/v1?expectedVersion=99`, {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string; currentVersion: string }).currentVersion).toBe("1");

    const ok = await fetch(`${baseUrl}/api/model-policy/policies/v1?expectedVersion=1`, {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ document: policyDocument({ severity: "advisory" }) }),
    });
    expect(ok.status).toBe(200);
  });

  test("DELETE removes a policy, honors ?expectedVersion, and 404s when gone", async () => {
    const { baseUrl } = await startPolicyServer();
    await createPolicy(baseUrl, "d1", policyDocument());

    const staleVersion = await fetch(`${baseUrl}/api/model-policy/policies/d1?expectedVersion=99`, { method: "DELETE", headers: ADMIN });
    expect(staleVersion.status).toBe(409);

    const ok = await fetch(`${baseUrl}/api/model-policy/policies/d1?expectedVersion=1`, { method: "DELETE", headers: ADMIN });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { action: string } }).result.action).toBe("deleted");

    const gone = await fetch(`${baseUrl}/api/model-policy/policies/d1`, { method: "DELETE", headers: ADMIN });
    expect(gone.status).toBe(404);
  });

  test("POST /api/model-policy/active designates the active policy and requires id", async () => {
    const { baseUrl } = await startPolicyServer();
    await createPolicy(baseUrl, "alpha", policyDocument(), { setActive: true });
    await createPolicy(baseUrl, "beta", policyDocument());

    const res = await fetch(`${baseUrl}/api/model-policy/active`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "beta" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { action: string; activePolicyId: string } };
    expect(body.result.action).toBe("activated");
    expect(body.result.activePolicyId).toBe("beta");

    const activeRes = await fetch(`${baseUrl}/api/model-policy`, { headers: READER });
    expect(((await activeRes.json()) as { activePolicyId: string }).activePolicyId).toBe("beta");

    const missing = await fetch(`${baseUrl}/api/model-policy/active`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "ghost" }),
    });
    expect(missing.status).toBe(404);

    const noId = await fetch(`${baseUrl}/api/model-policy/active`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noId.status).toBe(400);
  });
});

describe("central model-policy HTTP routes — method handling", () => {
  test("unsupported methods on known paths return 405", async () => {
    const { baseUrl } = await startPolicyServer();
    await createPolicy(baseUrl, "m1", policyDocument());

    const putCollection = await fetch(`${baseUrl}/api/model-policy/policies`, { method: "PUT", headers: ADMIN });
    expect(putCollection.status).toBe(405);

    const putItem = await fetch(`${baseUrl}/api/model-policy/policies/m1`, { method: "PUT", headers: ADMIN });
    expect(putItem.status).toBe(405);

    const postRoot = await fetch(`${baseUrl}/api/model-policy`, { method: "POST", headers: ADMIN });
    expect(postRoot.status).toBe(405);
  });
});

describe("central model-catalog HTTP route — optional metadata", () => {
  test("GET /api/model-catalog returns configured catalog metadata, gated by model-policy.read", async () => {
    const catalog: CentralModelCatalog = {
      entries: [{ value: "zai/glm-4.6", label: "GLM 4.6", vendor: "zai" }],
      updatedAt: "2026-06-24T00:00:00.000Z",
    };
    const ports = createInMemoryCentralPorts({ modelCatalog: catalog });
    const { baseUrl } = await startPolicyServer(ports);

    const noCreds = await fetch(`${baseUrl}/api/model-catalog`);
    expect(noCreds.status).toBe(401);

    const sinkRes = await fetch(`${baseUrl}/api/model-catalog`, { headers: SINK });
    expect(sinkRes.status).toBe(403);

    const res = await fetch(`${baseUrl}/api/model-catalog`, { headers: READER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scope: string;
      catalog: { entries: { value: string; label: string; vendor: string }[]; updatedAt: string };
    };
    expect(body.ok).toBe(true);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.catalog.entries).toEqual([{ value: "zai/glm-4.6", label: "GLM 4.6", vendor: "zai" }]);
    expect(body.catalog.updatedAt).toBe("2026-06-24T00:00:00.000Z");
  });

  test("GET /api/model-catalog omits catalog when none configured and 404s/405s on sub-paths/wrong methods", async () => {
    const { baseUrl } = await startPolicyServer();

    const res = await fetch(`${baseUrl}/api/model-catalog`, { headers: READER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; catalog?: unknown };
    expect(body.ok).toBe(true);
    expect(body.catalog).toBeUndefined();

    const subPath = await fetch(`${baseUrl}/api/model-catalog/extra`, { headers: READER });
    expect(subPath.status).toBe(404);

    const wrongMethod = await fetch(`${baseUrl}/api/model-catalog`, { method: "POST", headers: ADMIN });
    expect(wrongMethod.status).toBe(405);
  });
});
