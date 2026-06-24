import { describe, expect, test } from "bun:test";
import {
  CATALOG_DRIFT_STATUSES,
  CATALOG_ITEM_KINDS,
  CONTROL_PLANE_MODES,
  MODEL_POLICY_SEVERITIES,
  centralAdminModeMetadata,
  centralConnectedModeMetadata,
  defaultCapabilities,
  deriveControlPlaneMode,
  isCatalogDriftStatus,
  isCatalogItemKind,
  isControlPlaneMode,
  isModelPolicySeverity,
  isModelPolicyThinkingConstraint,
  localOnlyModeMetadata,
  modelPolicyAllowsThinking,
  modelPolicyAllowsValue,
  modelPolicyDeniesValue,
  type AdminMetadataPort,
  type CatalogAccessPort,
  type CatalogDriftInfo,
  type CatalogItem,
  type CatalogItemSummary,
  type CatalogOriginProvenance,
  type ControlPlaneModeMetadata,
  type ControlPlanePorts,
  type ModelPolicyDocument,
  type ModelPolicyPort,
  type TelemetryStatusPort,
} from "../src/application/index.js";

describe("control-plane mode metadata", () => {
  test("derives mode from connection topology", () => {
    expect(deriveControlPlaneMode({ hasLocalSession: true, hasCentral: false })).toBe("local-only");
    expect(deriveControlPlaneMode({ hasLocalSession: true, hasCentral: true })).toBe("central-connected");
    expect(deriveControlPlaneMode({ hasLocalSession: false, hasCentral: true })).toBe("central-admin");
    expect(deriveControlPlaneMode({ hasLocalSession: false, hasCentral: false })).toBe("local-only");
  });

  test("default capabilities follow central reachability", () => {
    expect(defaultCapabilities(false)).toEqual({ catalog: false, modelPolicy: false, telemetry: false, admin: false });
    expect(defaultCapabilities(true)).toEqual({ catalog: true, modelPolicy: true, telemetry: true, admin: true });
  });

  test("mode-metadata builders carry topology, capabilities, and optional fields", () => {
    expect(localOnlyModeMetadata()).toEqual({
      mode: "local-only",
      hasLocalSession: true,
      hasCentral: false,
      capabilities: defaultCapabilities(false),
    });
    expect(localOnlyModeMetadata("dev")).toHaveProperty("label", "dev");

    const connected = centralConnectedModeMetadata({ centralApiBaseUrl: "https://central.example/api", label: "rt" });
    expect(connected).toMatchObject({
      mode: "central-connected",
      hasLocalSession: true,
      hasCentral: true,
      centralApiBaseUrl: "https://central.example/api",
      label: "rt",
    });
    expect(connected.capabilities).toEqual(defaultCapabilities(true));

    const admin = centralAdminModeMetadata({ centralApiBaseUrl: "https://central.example/api" });
    expect(admin).toMatchObject({
      mode: "central-admin",
      hasLocalSession: false,
      hasCentral: true,
      centralApiBaseUrl: "https://central.example/api",
    });
  });

  test("guards the mode enum", () => {
    expect(CONTROL_PLANE_MODES).toEqual(["local-only", "central-connected", "central-admin"]);
    expect(isControlPlaneMode("central-connected")).toBe(true);
    expect(isControlPlaneMode("cloud")).toBe(false);
  });
});

describe("control-plane catalog DTOs", () => {
  test("guards item kinds and drift statuses", () => {
    expect(CATALOG_ITEM_KINDS).toEqual(["loadout", "materia"]);
    expect(isCatalogItemKind("loadout")).toBe(true);
    expect(isCatalogItemKind("quest")).toBe(false);

    expect(CATALOG_DRIFT_STATUSES).toEqual(["current", "behind", "diverged", "orphaned"]);
    expect(isCatalogDriftStatus("behind")).toBe(true);
    expect(isCatalogDriftStatus("ahead")).toBe(false);
  });

  test("origin provenance is constrained to writable local scopes", () => {
    const origin: CatalogOriginProvenance = {
      catalogItemId: "loadout-core",
      catalogVersion: "3",
      catalogContentHash: "sha256:abc",
      source: "user",
    };
    expect(origin.source).toBe("user");

    const drift: CatalogDriftInfo = { status: "behind", centralVersion: "4", centralContentHash: "sha256:def" };
    expect(drift.status).toBe("behind");
  });
});

describe("control-plane model-policy helpers", () => {
  test("allow/deny value matching is exact", () => {
    const refs = [{ value: "zai/glm-4.6" }, { value: "openai/gpt-4o" }];
    expect(modelPolicyAllowsValue(refs, "zai/glm-4.6")).toBe(true);
    expect(modelPolicyAllowsValue(refs, "anthropic/claude")).toBe(false);
    // Undefined allow list = unconstrained; empty allow list = unconstrained.
    expect(modelPolicyAllowsValue(undefined, "anything")).toBe(true);
    expect(modelPolicyAllowsValue([], "zai/glm-4.6")).toBe(true);

    expect(modelPolicyDeniesValue(refs, "openai/gpt-4o")).toBe(true);
    expect(modelPolicyDeniesValue(refs, "anthropic/claude")).toBe(false);
    expect(modelPolicyDeniesValue(undefined, "zai/glm-4.6")).toBe(false);
  });

  test("thinking constraint honors allow list and max ceiling", () => {
    expect(modelPolicyAllowsThinking(undefined, "high")).toBe(true);

    const allowList = { allow: ["off", "low", "medium"] as const };
    expect(modelPolicyAllowsThinking(allowList, "low")).toBe(true);
    expect(modelPolicyAllowsThinking(allowList, "high")).toBe(false);

    const ceiling = { max: "medium" as const };
    expect(modelPolicyAllowsThinking(ceiling, "medium")).toBe(true);
    expect(modelPolicyAllowsThinking(ceiling, "high")).toBe(false);
    expect(modelPolicyAllowsThinking(ceiling, "off")).toBe(true);
  });

  test("guards severity and thinking-constraint shapes", () => {
    expect(MODEL_POLICY_SEVERITIES).toEqual(["advisory", "enforced"]);
    expect(isModelPolicySeverity("enforced")).toBe(true);
    expect(isModelPolicySeverity("hard")).toBe(false);

    expect(isModelPolicyThinkingConstraint({ allow: ["low", "medium"] })).toBe(true);
    expect(isModelPolicyThinkingConstraint({ max: "high" })).toBe(true);
    expect(isModelPolicyThinkingConstraint({ allow: ["low", "nuclear"] })).toBe(false);
    expect(isModelPolicyThinkingConstraint({ max: "turbo" })).toBe(false);
    expect(isModelPolicyThinkingConstraint({ allow: "low" })).toBe(false);
  });

  test("model-policy document composes advisory prefer + hard deny", () => {
    const policy: ModelPolicyDocument = {
      id: "default",
      deny: [{ value: "legacy/expired-model" }],
      prefer: [{ value: "zai/glm-4.6", label: "GLM" }],
      thinking: { max: "high" },
      severity: "advisory",
      version: "1",
      updatedAt: "2026-06-24T00:00:00.000Z",
    };
    expect(modelPolicyDeniesValue(policy.deny, "legacy/expired-model")).toBe(true);
    expect(modelPolicyAllowsThinking(policy.thinking, "xhigh")).toBe(false);
  });
});

// A tiny in-memory fake that implements all four control-plane ports against the
// DTOs. This proves the contracts are implementable and that every method
// returns/exchanges DTOs (no transport types leak through the ports). The
// repository behavior itself is a follow-on work item and intentionally does
// not live in the production contract module.
function trivialHash(definition: Readonly<Record<string, unknown>>): string {
  return `sha256:${JSON.stringify(definition).length}`;
}

class FakeControlPlane implements ControlPlanePorts {
  readonly catalog: CatalogAccessPort;
  readonly modelPolicy: ModelPolicyPort;
  readonly telemetry: TelemetryStatusPort;
  readonly admin: AdminMetadataPort;
  private readonly items = new Map<string, CatalogItem>();
  private versionCounter = 0;
  private policy: ModelPolicyDocument | undefined;

  constructor(private readonly modeMetadata: ControlPlaneModeMetadata) {
    this.catalog = {
      mode: () => this.modeMetadata,
      list: async (query) =>
        [...this.items.values()]
          .filter((item) => (query?.kind ? item.kind === query.kind : true))
          .filter((item) => (query?.search ? item.id.includes(query.search) || (item.name ?? "").includes(query.search) : true))
          .map(this.summarize),
      get: async (id, kind) => {
        const item = this.items.get(id);
        return item && (kind === undefined || item.kind === kind) ? item : undefined;
      },
      head: async (id, kind) => {
        const item = await this.catalog.get(id, kind);
        return item ? this.summarize(item) : undefined;
      },
    };
    this.modelPolicy = {
      mode: () => this.modeMetadata,
      getActivePolicy: async () => this.policy,
      listPolicies: async () => (this.policy ? [this.policy] : []),
    };
    this.telemetry = {
      mode: () => this.modeMetadata,
      ingest: async (input) => ({ accepted: input.events.length, ingestedAt: "2026-06-24T00:00:00.000Z" }),
      status: async () => ({ mode: this.modeMetadata.mode, capturedAt: "2026-06-24T00:00:00.000Z", eventCount: this.items.size }),
      queryEvents: async () => [],
    };
    this.admin = {
      mode: () => this.modeMetadata,
      getMetadata: async () => ({
        server: { mode: this.modeMetadata.mode, authMethods: ["dev-token"], capabilities: this.modeMetadata.capabilities },
      }),
      createCatalogItem: async (input) => {
        if (this.items.has(input.id)) throw new Error(`catalog item ${input.id} already exists`);
        const version = String(++this.versionCounter);
        const updatedAt = "2026-06-24T00:00:00.000Z";
        const item: CatalogItem = {
          id: input.id,
          kind: input.kind,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          version,
          updatedAt,
          contentHash: trivialHash(input.content.definition),
          ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
          content: { definition: input.content.definition },
        };
        this.items.set(input.id, item);
        return { action: "created", summary: this.summarize(item) };
      },
      updateCatalogItem: async (input) => {
        const existing = this.items.get(input.id);
        if (!existing) throw new Error(`catalog item ${input.id} not found`);
        const version = String(++this.versionCounter);
        const updatedAt = "2026-06-24T00:00:00.001Z";
        const next: CatalogItem = {
          ...existing,
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.content !== undefined ? { content: { definition: input.content.definition }, contentHash: trivialHash(input.content.definition) } : {}),
          ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
          version,
          updatedAt,
        };
        this.items.set(input.id, next);
        return { action: "updated", summary: this.summarize(next) };
      },
      deleteCatalogItem: async (input) => {
        const existing = this.items.get(input.id);
        if (!existing) throw new Error(`catalog item ${input.id} not found`);
        this.items.delete(input.id);
        return { action: "deleted", summary: this.summarize(existing) };
      },
    };
  }

  private summarize = (item: CatalogItem): CatalogItemSummary => ({
    id: item.id,
    kind: item.kind,
    version: item.version,
    updatedAt: item.updatedAt,
    contentHash: item.contentHash,
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.provenance !== undefined ? { provenance: item.provenance } : {}),
  });
}

describe("control-plane ports compose and exchange DTOs", () => {
  test("a local-only adapter implements all four ports reporting local-only mode", async () => {
    const cp = new FakeControlPlane(localOnlyModeMetadata("local-dev"));
    expect(cp.catalog.mode().mode).toBe("local-only");
    expect(cp.modelPolicy.mode().hasLocalSession).toBe(true);
    expect(cp.telemetry.mode().capabilities).toEqual(defaultCapabilities(false));
    expect(cp.admin.mode().mode).toBe("local-only");

    const created = await cp.admin.createCatalogItem({
      id: "loadout-core",
      kind: "loadout",
      content: { definition: { entry: "Socket-1" } },
      principalId: "u1",
    });
    expect(created.action).toBe("created");
    expect(created.summary.id).toBe("loadout-core");

    const fetched = await cp.catalog.get("loadout-core", "loadout");
    expect(fetched?.content.definition).toEqual({ entry: "Socket-1" });

    const head = await cp.catalog.head("loadout-core");
    expect(head?.version).toBe(created.summary.version);
    expect(await cp.catalog.list({ kind: "loadout" })).toHaveLength(1);
    expect(await cp.catalog.list({ kind: "materia" })).toHaveLength(0);

    const updated = await cp.admin.updateCatalogItem({ id: "loadout-core", content: { definition: { entry: "Socket-2" } } });
    expect(updated.action).toBe("updated");
    expect((await cp.catalog.get("loadout-core"))?.content.definition).toEqual({ entry: "Socket-2" });

    const deleted = await cp.admin.deleteCatalogItem({ id: "loadout-core" });
    expect(deleted.action).toBe("deleted");
    expect(await cp.catalog.get("loadout-core")).toBeUndefined();

    const ingest = await cp.telemetry.ingest({ events: [] });
    expect(ingest.accepted).toBe(0);
    const status = await cp.telemetry.status();
    expect(status.mode).toBe("local-only");
    const meta = await cp.admin.getMetadata();
    expect(meta.server.authMethods).toEqual(["dev-token"]);
  });

  test("a central-admin adapter reports no local session", () => {
    const cp = new FakeControlPlane(centralAdminModeMetadata({ centralApiBaseUrl: "https://central.example/api" }));
    expect(cp.admin.mode()).toMatchObject({ mode: "central-admin", hasLocalSession: false, hasCentral: true });
  });

  test("no control-plane port exposes quest-board APIs", () => {
    const questish = (name: string) => /quest/i.test(name);
    const portMethodNames = (port: object): string[] =>
      Object.getOwnPropertyNames(port).filter((name) => {
        const value = (port as unknown as Record<string, unknown>)[name];
        return typeof value === "function";
      });

    const cp = new FakeControlPlane(localOnlyModeMetadata());
    for (const port of [cp.catalog, cp.modelPolicy, cp.telemetry, cp.admin]) {
      expect(portMethodNames(port).some(questish)).toBe(false);
    }
  });
});
