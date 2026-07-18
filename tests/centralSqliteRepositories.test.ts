import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CatalogVersionMismatchError,
  ModelPolicyVersionMismatchError,
  createMateriaCentralServer,
  createSqliteCentralCatalogRepository,
  createSqliteModelPolicyRepository,
  hashCentralContent,
  initializeCentralSqliteDatabase,
} from "../src/central/index.js";
import type { ModelPolicyDocument } from "../src/application/controlPlane.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-materia-central-repositories-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "central.sqlite");
}

function policy(id: string, denied: string): ModelPolicyDocument {
  return {
    id,
    name: `Policy ${id}`,
    deny: [{ value: denied }],
    allow: [{ value: "allowed/model" }],
    severity: "enforced",
  };
}

describe("SQLite central catalog repository", () => {
  test("preserves content, provenance, hashes, and monotonic versions across database restarts", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = await initializeCentralSqliteDatabase({ path: databasePath });
    const catalog = createSqliteCentralCatalogRepository(first.database, {
      clock: (() => {
        const values = ["2026-07-18T01:00:00.000Z", "2026-07-18T01:01:00.000Z"];
        return () => values.shift() ?? "2026-07-18T01:02:00.000Z";
      })(),
    });

    const created = await catalog.create({
      id: "buildja",
      kind: "materia",
      name: "Buildja",
      content: { definition: { model: { value: "allowed/model" }, type: "agent" } },
      provenance: { source: "upstream", author: "team-a", repositoryId: "repo-a" },
      principalId: "admin-a",
    });
    expect(created.summary.version).toBe("1");
    expect(created.summary.contentHash).toBe(hashCentralContent({
      definition: { type: "agent", model: { value: "allowed/model" } },
    }));

    const updated = await catalog.update({
      id: "buildja",
      kind: "materia",
      expectedVersion: "1",
      description: "durable builder",
      content: { definition: { type: "agent", model: { value: "new/model" } } },
      principalId: "admin-b",
    });
    expect(updated.summary).toMatchObject({
      version: "2",
      updatedAt: "2026-07-18T01:01:00.000Z",
      provenance: { source: "upstream", author: "team-a", repositoryId: "repo-a" },
    });
    first.database.close();

    const second = await initializeCentralSqliteDatabase({ path: databasePath });
    try {
      const restarted = createSqliteCentralCatalogRepository(second.database, {
        clock: () => "2026-07-18T01:03:00.000Z",
      });
      expect(restarted.size()).toBe(1);
      expect(await restarted.get("buildja", "materia")).toEqual({
        id: "buildja",
        kind: "materia",
        name: "Buildja",
        description: "durable builder",
        version: "2",
        updatedAt: "2026-07-18T01:01:00.000Z",
        contentHash: hashCentralContent({ definition: { type: "agent", model: { value: "new/model" } } }),
        provenance: { source: "upstream", author: "team-a", repositoryId: "repo-a" },
        content: { definition: { type: "agent", model: { value: "new/model" } } },
      });

      await expect(restarted.update({ id: "buildja", expectedVersion: "1" }))
        .rejects.toBeInstanceOf(CatalogVersionMismatchError);
      expect((await restarted.update({ id: "buildja", expectedVersion: "2" })).summary.version).toBe("3");

      const audits = second.database.prepare(`
        SELECT principal_id AS principalId, action, resource_id AS resourceId, metadata_json AS metadataJson
        FROM audit_records
        WHERE resource_type = 'catalog-item'
        ORDER BY id ASC
      `).all<{ principalId: string; action: string; resourceId: string; metadataJson: string }>();
      expect(audits.map((audit) => audit.action)).toEqual([
        "catalog-item.created",
        "catalog-item.updated",
        "catalog-item.updated",
      ]);
      expect(audits[0]).toMatchObject({ principalId: "admin-a", resourceId: "materia:buildja" });
      expect(JSON.parse(audits[1].metadataJson)).toMatchObject({ version: "2", id: "buildja" });
    } finally {
      second.database.close();
    }
  });
});

describe("SQLite central model-policy repository", () => {
  test("preserves policy versions and the active designation across database restarts", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = await initializeCentralSqliteDatabase({ path: databasePath });
    const policies = createSqliteModelPolicyRepository(first.database, {
      clock: () => "2026-07-18T02:00:00.000Z",
    });

    await policies.create({ id: "alpha", document: policy("ignored-alpha", "alpha/denied"), setActive: true, principalId: "admin-a" });
    await policies.create({ id: "beta", document: policy("ignored-beta", "beta/denied"), principalId: "admin-a" });
    const updated = await policies.update({
      id: "alpha",
      expectedVersion: "1",
      document: policy("ignored-update", "alpha/denied-v2"),
      principalId: "admin-b",
    });
    expect(updated.policy).toMatchObject({ id: "alpha", version: "2", deny: [{ value: "alpha/denied-v2" }] });
    first.database.close();

    const second = await initializeCentralSqliteDatabase({ path: databasePath });
    try {
      const restarted = createSqliteModelPolicyRepository(second.database, {
        clock: () => "2026-07-18T02:01:00.000Z",
      });
      expect(restarted.size()).toBe(2);
      expect((await restarted.list()).map((entry) => entry.id)).toEqual(["alpha", "beta"]);
      expect(await restarted.getActivePolicyId()).toBe("alpha");
      expect(await restarted.getActive()).toMatchObject({ id: "alpha", version: "2" });

      await expect(restarted.update({ id: "alpha", expectedVersion: "1" }))
        .rejects.toBeInstanceOf(ModelPolicyVersionMismatchError);
      const activated = await restarted.setActive({ id: "beta", principalId: "admin-c" });
      expect(activated.activePolicyId).toBe("beta");
      await restarted.remove({ id: "beta", expectedVersion: "1", principalId: "admin-c" });
      expect(await restarted.getActivePolicyId()).toBeUndefined();

      const audits = second.database.prepare(`
        SELECT action, principal_id AS principalId, metadata_json AS metadataJson
        FROM audit_records
        WHERE resource_type = 'model-policy'
        ORDER BY id ASC
      `).all<{ action: string; principalId: string; metadataJson: string }>();
      expect(audits.map((audit) => audit.action)).toEqual([
        "model-policy.created",
        "model-policy.created",
        "model-policy.updated",
        "model-policy.activated",
        "model-policy.deleted",
      ]);
      expect(audits.at(-1)?.principalId).toBe("admin-c");
      expect(JSON.parse(audits[2].metadataJson)).toEqual({ id: "alpha", version: "2" });
    } finally {
      second.database.close();
    }
  });

  test("the central server composes durable repositories behind the existing ports", async () => {
    const databasePath = await temporaryDatabasePath();
    const initialized = await initializeCentralSqliteDatabase({ path: databasePath });
    const created = createMateriaCentralServer({ database: initialized.database });
    try {
      await created.ports.admin.createCatalogItem({
        id: "through-port",
        kind: "loadout",
        content: { definition: { sockets: [] } },
      });
      await created.ports.admin.createModelPolicy({
        id: "through-port",
        document: policy("through-port", "blocked/model"),
        setActive: true,
      });
      expect((await created.ports.catalog.get("through-port", "loadout"))?.version).toBe("1");
      expect((await created.ports.modelPolicy.getActivePolicy())?.id).toBe("through-port");
    } finally {
      initialized.database.close();
    }

    const restarted = await initializeCentralSqliteDatabase({ path: databasePath });
    try {
      const createdAgain = createMateriaCentralServer({ database: restarted.database });
      expect((await createdAgain.ports.catalog.get("through-port", "loadout"))?.version).toBe("1");
      expect((await createdAgain.ports.modelPolicy.getActivePolicy())?.id).toBe("through-port");
    } finally {
      restarted.database.close();
    }
  });
});
