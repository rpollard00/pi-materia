import { describe, expect, test } from "bun:test";
import {
  CentralModelPolicyWriteError,
  ModelPolicyConflictError,
  ModelPolicyNotFoundError,
  ModelPolicyVersionMismatchError,
  createInMemoryModelPolicyRepository,
} from "../src/central/controlPlane/inMemoryModelPolicyRepository.js";
import type { CreateModelPolicyInput, ModelPolicyDocument } from "../src/application/controlPlane.js";

function doc(overrides: Partial<ModelPolicyDocument> = {}): ModelPolicyDocument {
  return {
    id: "ignored-on-create",
    deny: [{ value: "forbidden/model" }],
    allow: [{ value: "zai/glm-4.6" }, { value: "anthropic/claude" }],
    prefer: [{ value: "anthropic/claude" }],
    ...overrides,
  };
}

function createInput(id: string, overrides: Partial<CreateModelPolicyInput> = {}): CreateModelPolicyInput {
  return { id, document: doc(), ...overrides };
}

describe("in-memory model-policy repository — reads", () => {
  test("starts empty with no active policy", async () => {
    const repo = createInMemoryModelPolicyRepository();
    expect(repo.size()).toBe(0);
    expect(await repo.list()).toEqual([]);
    expect(await repo.get("anything")).toBeUndefined();
    expect(await repo.getActive()).toBeUndefined();
    expect(await repo.getActivePolicyId()).toBeUndefined();
  });

  test("seed policies are validated, versioned, and timestamped", async () => {
    const repo = createInMemoryModelPolicyRepository({
      clock: () => "2026-06-24T00:00:00.000Z",
      seed: [createInput("alpha", { setActive: true }), createInput("beta")],
    });
    expect(repo.size()).toBe(2);

    const list = await repo.list();
    expect(list.map((policy) => policy.id)).toEqual(["alpha", "beta"]);
    for (const policy of list) {
      expect(policy.version).toBe("1");
      expect(policy.updatedAt).toBe("2026-06-24T00:00:00.000Z");
      // Constraint fields from the seed document are preserved.
      expect(policy.deny).toEqual([{ value: "forbidden/model" }]);
    }

    // The seed id is authoritative; the placeholder document id is overwritten.
    const alpha = (await repo.get("alpha"))!;
    expect(alpha.id).toBe("alpha");

    // setActive on a seeded create marks it active.
    expect(await repo.getActivePolicyId()).toBe("alpha");
    expect((await repo.getActive())?.id).toBe("alpha");
  });
});

describe("in-memory model-policy repository — admin writes", () => {
  test("create assigns version 1, stamps active, and produces an audit record", async () => {
    const repo = createInMemoryModelPolicyRepository({ clock: () => "2026-06-24T00:00:00.000Z" });
    const result = await repo.create(createInput("p1", { setActive: true, principalId: "dev-admin" }));
    expect(result.action).toBe("created");
    expect(result.policy?.id).toBe("p1");
    expect(result.policy?.version).toBe("1");
    expect(result.policy?.updatedAt).toBe("2026-06-24T00:00:00.000Z");
    expect(result.activePolicyId).toBe("p1");
    expect(result.audit?.action).toBe("model-policy.created");
    expect(result.audit?.principalId).toBe("dev-admin");
    expect(result.audit?.source).toBe("model-policy-admin");
    expect(result.audit?.resourceId).toBe("p1");
  });

  test("create conflicts when the id already exists", async () => {
    const repo = createInMemoryModelPolicyRepository({ seed: [createInput("p1")] });
    await expect(repo.create(createInput("p1"))).rejects.toBeInstanceOf(ModelPolicyConflictError);
    try {
      await repo.create(createInput("p1"));
    } catch (error) {
      expect((error as ModelPolicyConflictError).statusCode).toBe(409);
      expect((error as ModelPolicyConflictError).message).toMatch(/already exists/);
    }
  });

  test("update bumps the version, replaces constraints, and honors expectedVersion", async () => {
    const repo = createInMemoryModelPolicyRepository({ seed: [createInput("p1")] });

    const ok = await repo.update({ id: "p1", expectedVersion: "1", document: doc({ deny: [{ value: "other/model" }] }) });
    expect(ok.action).toBe("updated");
    expect(ok.policy?.version).toBe("2");
    expect(ok.policy?.deny).toEqual([{ value: "other/model" }]);
  });

  test("update rejects stale expectedVersion with currentVersion surfaced", async () => {
    const repo = createInMemoryModelPolicyRepository({ seed: [createInput("p1")] });
    await expect(repo.update({ id: "p1", expectedVersion: "99" })).rejects.toBeInstanceOf(ModelPolicyVersionMismatchError);
    try {
      await repo.update({ id: "p1", expectedVersion: "99" });
    } catch (error) {
      expect((error as ModelPolicyVersionMismatchError).currentVersion).toBe("1");
    }
  });

  test("update on a missing id throws not-found", async () => {
    const repo = createInMemoryModelPolicyRepository();
    await expect(repo.update({ id: "missing" })).rejects.toBeInstanceOf(ModelPolicyNotFoundError);
  });

  test("delete removes the policy and clears active designation when active", async () => {
    const repo = createInMemoryModelPolicyRepository({ seed: [createInput("p1", { setActive: true })] });
    expect(await repo.getActivePolicyId()).toBe("p1");

    const result = await repo.remove({ id: "p1", principalId: "dev-admin" });
    expect(result.action).toBe("deleted");
    expect(result.policy).toBeUndefined();
    expect(result.activePolicyId).toBeUndefined();
    expect(result.audit?.action).toBe("model-policy.deleted");
    expect(repo.size()).toBe(0);
  });

  test("setActive designates the active policy and replaces the previous one", async () => {
    const repo = createInMemoryModelPolicyRepository({ seed: [createInput("alpha", { setActive: true }), createInput("beta")] });
    expect(await repo.getActivePolicyId()).toBe("alpha");

    const result = await repo.setActive({ id: "beta", principalId: "dev-admin" });
    expect(result.action).toBe("activated");
    expect(result.activePolicyId).toBe("beta");
    expect(result.audit?.action).toBe("model-policy.activated");
    expect((await repo.getActive())?.id).toBe("beta");
  });

  test("setActive on a missing id throws not-found", async () => {
    const repo = createInMemoryModelPolicyRepository();
    await expect(repo.setActive({ id: "missing" })).rejects.toBeInstanceOf(ModelPolicyNotFoundError);
  });
});

describe("in-memory model-policy repository — validation", () => {
  test("rejects structurally invalid documents on create", async () => {
    const repo = createInMemoryModelPolicyRepository();
    // The repository pins the id from the input; the document must otherwise
    // pass isValidModelPolicyDocument. A document with a non-array allow list is invalid.
    await expect(
      repo.create({ id: "bad", document: { id: "bad", allow: "not-an-array" } as unknown as ModelPolicyDocument }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("rejects non-string ids", async () => {
    const repo = createInMemoryModelPolicyRepository();
    await expect(repo.create({ id: 5 as unknown as string, document: doc() })).rejects.toBeInstanceOf(TypeError);
    await expect(repo.update({ id: "" as unknown as string })).rejects.toBeInstanceOf(TypeError);
  });

  test("all write errors extend the abstract base with a statusCode", () => {
    expect(new ModelPolicyConflictError("x")).toBeInstanceOf(CentralModelPolicyWriteError);
    expect(new ModelPolicyConflictError("x").statusCode).toBe(409);
    expect(new ModelPolicyNotFoundError("x").statusCode).toBe(404);
    expect(new ModelPolicyVersionMismatchError("x", "1").statusCode).toBe(409);
  });
});
