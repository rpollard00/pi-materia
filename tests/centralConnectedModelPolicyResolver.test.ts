import { describe, expect, test } from "bun:test";
import {
  centralConnectedModeMetadata,
  type ModelPolicyPort,
} from "../src/application/controlPlane.js";
import type { CentralHttpControlPlaneClientOptions } from "../src/central/client/index.js";
import type { ModelPolicyDocument } from "../src/domain/modelPolicy.js";
import { createCentralConnectedModelPolicyResolver } from "../src/infrastructure/centralConnectedModelPolicyResolver.js";
import type { ModelPolicyResolutionContext } from "../src/runtime/modelPolicyResolver.js";

const context = {} as ModelPolicyResolutionContext;

function policy(id: string): ModelPolicyDocument {
  return { id, deny: [{ value: "forbidden/model" }] };
}

function modelPolicyPort(getActivePolicy: () => Promise<ModelPolicyDocument | undefined>): ModelPolicyPort {
  return {
    mode: () => centralConnectedModeMetadata(),
    getActivePolicy,
    getActivePolicyId: async () => undefined,
    listPolicies: async () => [],
    getPolicy: async () => undefined,
    getModelCatalog: async () => undefined,
  };
}

describe("central-connected model-policy resolver", () => {
  test("keeps local-only resolution free of central client and policy I/O", async () => {
    let clientCreations = 0;
    const resolver = createCentralConnectedModelPolicyResolver({
      resolveRuntimeConfig: async () => undefined,
      createModelPolicyPort: () => {
        clientCreations++;
        return modelPolicyPort(async () => policy("unexpected"));
      },
    });

    await expect(resolver.resolveActivePolicy(context)).resolves.toBeUndefined();
    await expect(resolver.resolveActivePolicy(context)).resolves.toBeUndefined();
    expect(clientCreations).toBe(0);
  });

  test("constructs the HTTP-backed port with reader settings and caches successful policy reads", async () => {
    const active = policy("active");
    let now = 1_000;
    let policyReads = 0;
    let clientOptions: CentralHttpControlPlaneClientOptions | undefined;
    const resolver = createCentralConnectedModelPolicyResolver({
      resolveRuntimeConfig: async () => ({
        apiUrl: "https://central.example.test",
        requestTimeoutMs: 2_500,
        credentials: { readToken: "reader" },
      }),
      createModelPolicyPort: (options) => {
        clientOptions = options;
        return modelPolicyPort(async () => {
          policyReads++;
          return active;
        });
      },
      cacheTtlMs: 100,
      clock: () => now,
    });

    await expect(resolver.resolveActivePolicy(context)).resolves.toEqual(active);
    now = 1_099;
    await expect(resolver.resolveActivePolicy(context)).resolves.toEqual(active);

    expect(policyReads).toBe(1);
    expect(clientOptions).toMatchObject({
      apiUrl: "https://central.example.test",
      requestTimeoutMs: 2_500,
      credentials: { readToken: "reader" },
      mode: "central-connected",
    });
  });

  test("uses the last successful policy during an outage and throttles refresh attempts", async () => {
    const cached = policy("cached");
    const replacement = policy("replacement");
    let now = 0;
    let policyReads = 0;
    let outage = false;
    let current = cached;
    const resolver = createCentralConnectedModelPolicyResolver({
      resolveRuntimeConfig: async () => ({
        apiUrl: "https://central.example.test",
        requestTimeoutMs: 1_000,
        credentials: { readToken: "reader" },
      }),
      createModelPolicyPort: () => modelPolicyPort(async () => {
        policyReads++;
        if (outage) throw new Error("central unavailable");
        return current;
      }),
      cacheTtlMs: 100,
      clock: () => now,
    });

    await expect(resolver.resolveActivePolicy(context)).resolves.toEqual(cached);
    outage = true;
    now = 100;
    await expect(resolver.resolveActivePolicy(context)).resolves.toEqual(cached);
    now = 150;
    await expect(resolver.resolveActivePolicy(context)).resolves.toEqual(cached);
    expect(policyReads).toBe(2);

    outage = false;
    current = replacement;
    now = 200;
    await expect(resolver.resolveActivePolicy(context)).resolves.toEqual(replacement);
    expect(policyReads).toBe(3);
  });

  test("degrades to local behavior without a successful cache and clears stale policy when disconnected", async () => {
    let connected = true;
    let fail = true;
    let now = 0;
    let policyReads = 0;
    const active = policy("active");
    const resolver = createCentralConnectedModelPolicyResolver({
      resolveRuntimeConfig: async () => connected ? ({
        apiUrl: "https://central.example.test",
        requestTimeoutMs: 1_000,
        credentials: { readToken: "reader" },
      }) : undefined,
      createModelPolicyPort: () => modelPolicyPort(async () => {
        policyReads++;
        if (fail) throw new Error("offline");
        return active;
      }),
      cacheTtlMs: 50,
      clock: () => now,
    });

    await expect(resolver.resolveActivePolicy(context)).resolves.toBeUndefined();
    now = 25;
    await expect(resolver.resolveActivePolicy(context)).resolves.toBeUndefined();
    expect(policyReads).toBe(1);

    fail = false;
    now = 50;
    await expect(resolver.resolveActivePolicy(context)).resolves.toEqual(active);
    connected = false;
    await expect(resolver.resolveActivePolicy(context)).resolves.toBeUndefined();
    connected = true;
    now = 51;
    fail = true;
    await expect(resolver.resolveActivePolicy(context)).resolves.toBeUndefined();
  });

  test("deduplicates concurrent policy refreshes", async () => {
    let release!: (policy: ModelPolicyDocument) => void;
    const pending = new Promise<ModelPolicyDocument>((resolve) => { release = resolve; });
    let policyReads = 0;
    const resolver = createCentralConnectedModelPolicyResolver({
      resolveRuntimeConfig: async () => ({
        apiUrl: "https://central.example.test",
        requestTimeoutMs: 1_000,
        credentials: {},
      }),
      createModelPolicyPort: () => modelPolicyPort(async () => {
        policyReads++;
        return pending;
      }),
    });

    const first = resolver.resolveActivePolicy(context);
    const second = resolver.resolveActivePolicy(context);
    await Promise.resolve();
    release(policy("shared"));

    await expect(Promise.all([first, second])).resolves.toEqual([policy("shared"), policy("shared")]);
    expect(policyReads).toBe(1);
  });
});
