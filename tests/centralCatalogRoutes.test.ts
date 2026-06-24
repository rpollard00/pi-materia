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
import type { ControlPlanePorts } from "../src/application/index.js";

const servers: Array<MateriaCentralServer["server"]> = [];

const ADMIN = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_ADMIN}` };
const READER = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_READER}` };
const SINK = { Authorization: `Bearer ${DEFAULT_DEV_TOKEN_SINK}` };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startCatalogServer(ports?: ControlPlanePorts): Promise<{ baseUrl: string; ports: ControlPlanePorts }> {
  const resolvedPorts = ports ?? createInMemoryCentralPorts();
  const created = createMateriaCentralServer({ port: 0, ports: resolvedPorts });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("central catalog test server did not bind to a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, ports: resolvedPorts };
}

async function createItem(
  baseUrl: string,
  id: string,
  kind: "loadout" | "materia",
  definition: Record<string, unknown>,
): Promise<{ result: { action: string; summary: { id: string; kind: string; version: string; contentHash: string } } }> {
  const response = await fetch(`${baseUrl}/api/catalog`, {
    method: "POST",
    headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ id, kind, content: { definition } }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { result: { action: string; summary: { id: string; kind: string; version: string; contentHash: string } } };
}

describe("central catalog HTTP routes — RBAC", () => {
  test("list requires catalog.read: 401 without credentials, 403 for telemetry-sink token", async () => {
    const { baseUrl } = await startCatalogServer();

    const noCreds = await fetch(`${baseUrl}/api/catalog`);
    expect(noCreds.status).toBe(401);
    const noCredsBody = (await noCreds.json()) as { ok: boolean; scope: string; service: string; error: string; reason: string };
    expect(noCredsBody.ok).toBe(false);
    expect(noCredsBody.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(noCredsBody.service).toBe(CENTRAL_SERVICE_ID);
    expect(noCredsBody.error).toBe("Unauthorized");
    expect(noCreds.headers.get("www-authenticate")).toContain("Bearer");

    const sinkRes = await fetch(`${baseUrl}/api/catalog`, { headers: SINK });
    expect(sinkRes.status).toBe(403);
    const sinkBody = (await sinkRes.json()) as { ok: boolean; error: string; permission: string };
    expect(sinkBody.ok).toBe(false);
    expect(sinkBody.error).toBe("Forbidden");
    expect(sinkBody.permission).toBe("catalog.read");
  });

  test("reader can read catalog but cannot write (403 on create)", async () => {
    const { baseUrl } = await startCatalogServer();

    const listRes = await fetch(`${baseUrl}/api/catalog`, { headers: READER });
    expect(listRes.status).toBe(200);

    const createRes = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { ...READER, "content-type": "application/json" },
      body: JSON.stringify({ id: "r1", kind: "materia", content: { definition: {} } }),
    });
    expect(createRes.status).toBe(403);
    const body = (await createRes.json()) as { permission: string };
    expect(body.permission).toBe("catalog.write");
  });

  test("unknown sub-paths return 404 without leaking through a 401", async () => {
    const { baseUrl } = await startCatalogServer();
    // Unknown action under a valid item path → 404 (no auth requested).
    const res = await fetch(`${baseUrl}/api/catalog/materia/x/unknown-action`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Not found");
  });
});

describe("central catalog HTTP routes — reads", () => {
  test("GET /api/catalog lists summaries and supports kind/search filters", async () => {
    const { baseUrl } = await startCatalogServer();
    await createItem(baseUrl, "zeta", "materia", { label: "Zeta" });
    await createItem(baseUrl, "alpha", "materia", { label: "Alpha" });
    await createItem(baseUrl, "loadout-beta", "loadout", { sockets: [] });

    const allRes = await fetch(`${baseUrl}/api/catalog`, { headers: READER });
    expect(allRes.status).toBe(200);
    const allBody = (await allRes.json()) as { ok: boolean; items: { id: string; kind: string }[] };
    expect(allBody.ok).toBe(true);
    expect(allBody.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "loadout:loadout-beta",
      "materia:alpha",
      "materia:zeta",
    ]);

    const materiaRes = await fetch(`${baseUrl}/api/catalog?kind=materia`, { headers: READER });
    const materiaBody = (await materiaRes.json()) as { items: { id: string }[] };
    expect(materiaBody.items.map((item) => item.id)).toEqual(["alpha", "zeta"]);

    const searchRes = await fetch(`${baseUrl}/api/catalog?search=alph`, { headers: READER });
    const searchBody = (await searchRes.json()) as { items: { id: string }[] };
    expect(searchBody.items.map((item) => item.id)).toEqual(["alpha"]);
  });

  test("invalid kind query param returns 400", async () => {
    const { baseUrl } = await startCatalogServer();
    const res = await fetch(`${baseUrl}/api/catalog?kind=bogus`, { headers: READER });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/kind/);
  });

  test("GET /api/catalog/:kind/:id returns the full item with content", async () => {
    const { baseUrl } = await startCatalogServer();
    await createItem(baseUrl, "buildga", "materia", { type: "agent", model: { value: "zai/glm-4.6" } });

    const res = await fetch(`${baseUrl}/api/catalog/materia/buildga`, { headers: READER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scope: string;
      service: string;
      item: { id: string; kind: string; version: string; contentHash: string; content: { definition: Record<string, unknown> } };
    };
    expect(body.ok).toBe(true);
    expect(body.scope).toBe(CENTRAL_CONTROL_PLANE_SCOPE);
    expect(body.service).toBe(CENTRAL_SERVICE_ID);
    expect(body.item.id).toBe("buildga");
    expect(body.item.kind).toBe("materia");
    expect(body.item.version).toBe("1");
    expect(body.item.content.definition).toEqual({ type: "agent", model: { value: "zai/glm-4.6" } });
    expect(body.item.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const missing = await fetch(`${baseUrl}/api/catalog/materia/missing`, { headers: READER });
    expect(missing.status).toBe(404);
  });

  test("GET /api/catalog/:kind/:id/summary returns the head summary without content", async () => {
    const { baseUrl } = await startCatalogServer();
    await createItem(baseUrl, "loadout-a", "loadout", { sockets: [1, 2] });

    const res = await fetch(`${baseUrl}/api/catalog/loadout/loadout-a/summary`, { headers: READER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; summary: { id: string; version: string; contentHash: string } };
    expect(body.ok).toBe(true);
    expect(body.summary.id).toBe("loadout-a");
    expect(body.summary.version).toBe("1");
    expect(body.summary.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((body as { content?: unknown }).content).toBeUndefined();

    const missing = await fetch(`${baseUrl}/api/catalog/loadout/missing/summary`, { headers: READER });
    expect(missing.status).toBe(404);
  });

  test("invalid kind path segment returns 404", async () => {
    const { baseUrl } = await startCatalogServer();
    const res = await fetch(`${baseUrl}/api/catalog/bogus/x`, { headers: READER });
    expect(res.status).toBe(404);
  });
});

describe("central catalog HTTP routes — admin writes", () => {
  test("POST /api/catalog creates an item, stamps the acting principal in audit, and 409s on conflict", async () => {
    const { baseUrl } = await startCatalogServer();
    const response = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "c1", kind: "materia", content: { definition: { v: 1 } } }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      result: {
        action: string;
        summary: { id: string; version: string };
        audit?: { action: string; principalId?: string; source: string };
      };
    };
    expect(created.result.action).toBe("created");
    expect(created.result.summary.id).toBe("c1");
    expect(created.result.summary.version).toBe("1");
    // Audit carries the admin principal id resolved from the dev token.
    expect(created.result.audit?.action).toBe("catalog-item.created");
    expect(created.result.audit?.principalId).toBe("dev-admin");
    expect(created.result.audit?.source).toBe("catalog-admin");

    // Conflicting create surfaces a 409 envelope.
    const conflict = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "c1", kind: "materia", content: { definition: {} } }),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { ok: boolean; code: string; error: string };
    expect(conflictBody.ok).toBe(false);
    expect(conflictBody.code).toBe("conflict");
    expect(conflictBody.error).toMatch(/already exists/);
  });

  test("POST rejects malformed bodies with 400 and preserves 400 precedence over auth failure shape", async () => {
    const { baseUrl } = await startCatalogServer();

    // Non-object body.
    const notObject = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(notObject.status).toBe(400);

    // Missing kind.
    const noKind = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "x", content: { definition: {} } }),
    });
    expect(noKind.status).toBe(400);
    const noKindBody = (await noKind.json()) as { error: string };
    expect(noKindBody.error).toMatch(/kind/);

    // Bad content shape.
    const badContent = await fetch(`${baseUrl}/api/catalog`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ id: "x", kind: "materia", content: { definition: "no" } }),
    });
    expect(badContent.status).toBe(400);
  });

  test("PATCH updates fields, bumps version, and 404s on unknown items", async () => {
    const { baseUrl } = await startCatalogServer();
    await createItem(baseUrl, "u1", "loadout", { sockets: [1] });

    const res = await fetch(`${baseUrl}/api/catalog/loadout/u1`, {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Loadout U1", content: { definition: { sockets: [1, 2] } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { action: string; summary: { version: string; name: string } } };
    expect(body.ok).toBe(true);
    expect(body.result.action).toBe("updated");
    expect(body.result.summary.version).toBe("2");
    expect(body.result.summary.name).toBe("Loadout U1");

    const missing = await fetch(`${baseUrl}/api/catalog/loadout/missing`, {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { code: string };
    expect(missingBody.code).toBe("not_found");
  });

  test("PATCH honors ?expectedVersion and surfaces currentVersion on mismatch", async () => {
    const { baseUrl } = await startCatalogServer();
    await createItem(baseUrl, "v1", "materia", { v: 1 });

    const stale = await fetch(`${baseUrl}/api/catalog/materia/v1?expectedVersion=99`, {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "stale" }),
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { code: string; currentVersion: string };
    expect(staleBody.code).toBe("version_mismatch");
    expect(staleBody.currentVersion).toBe("1");

    const ok = await fetch(`${baseUrl}/api/catalog/materia/v1?expectedVersion=1`, {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "fresh" }),
    });
    expect(ok.status).toBe(200);
  });

  test("DELETE removes an item, honors ?expectedVersion, and 404s when gone", async () => {
    const { baseUrl } = await startCatalogServer();
    await createItem(baseUrl, "d1", "materia", { v: 1 });

    const staleVersion = await fetch(`${baseUrl}/api/catalog/materia/d1?expectedVersion=99`, {
      method: "DELETE",
      headers: ADMIN,
    });
    expect(staleVersion.status).toBe(409);

    const ok = await fetch(`${baseUrl}/api/catalog/materia/d1?expectedVersion=1`, { method: "DELETE", headers: ADMIN });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { result: { action: string } };
    expect(okBody.result.action).toBe("deleted");

    // Now absent.
    const getRes = await fetch(`${baseUrl}/api/catalog/materia/d1`, { headers: READER });
    expect(getRes.status).toBe(404);

    const gone = await fetch(`${baseUrl}/api/catalog/materia/d1`, { method: "DELETE", headers: ADMIN });
    expect(gone.status).toBe(404);
  });
});

describe("central catalog HTTP routes — method handling", () => {
  test("unsupported methods on known paths return 405", async () => {
    const { baseUrl } = await startCatalogServer();
    await createItem(baseUrl, "m1", "materia", { v: 1 });

    const putCollection = await fetch(`${baseUrl}/api/catalog`, { method: "PUT", headers: ADMIN });
    expect(putCollection.status).toBe(405);

    const putItem = await fetch(`${baseUrl}/api/catalog/materia/m1`, { method: "PUT", headers: ADMIN });
    expect(putItem.status).toBe(405);

    const postSummary = await fetch(`${baseUrl}/api/catalog/materia/m1/summary`, { method: "POST", headers: ADMIN });
    expect(postSummary.status).toBe(405);
  });

  test("shared id across kinds is distinguished by the path kind segment", async () => {
    const { baseUrl } = await startCatalogServer();
    await createItem(baseUrl, "shared", "materia", { m: 1 });
    await createItem(baseUrl, "shared", "loadout", { l: 1 });

    const materia = await fetch(`${baseUrl}/api/catalog/materia/shared`, { headers: READER });
    const materiaBody = (await materia.json()) as { item: { kind: string } };
    expect(materiaBody.item.kind).toBe("materia");

    const loadout = await fetch(`${baseUrl}/api/catalog/loadout/shared`, { headers: READER });
    const loadoutBody = (await loadout.json()) as { item: { kind: string } };
    expect(loadoutBody.item.kind).toBe("loadout");
  });
});
