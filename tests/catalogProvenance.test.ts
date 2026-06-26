import { describe, expect, test } from "bun:test";
import {
  CATALOG_DRIFT_STATUSES,
  type CatalogDriftCentralSummary,
  type CatalogDriftInfo,
  type CatalogOriginProvenance,
  isCatalogDriftStatus,
  isValidCatalogOriginProvenance,
  readCatalogOriginProvenance,
  resolveCatalogDrift,
} from "../src/domain/catalogProvenance.js";

function origin(overrides: Partial<CatalogOriginProvenance> = {}): CatalogOriginProvenance {
  return {
    catalogItemId: "team-build",
    catalogVersion: "3",
    catalogContentHash: "sha256:origin",
    source: "user",
    ...overrides,
  };
}

describe("catalog provenance domain contracts", () => {
  test("CATALOG_DRIFT_STATUSES exposes the documented statuses", () => {
    expect(CATALOG_DRIFT_STATUSES).toEqual(["current", "behind", "diverged", "orphaned"]);
    expect(isCatalogDriftStatus("current")).toBe(true);
    expect(isCatalogDriftStatus("ahead")).toBe(false);
  });

  test("isValidCatalogOriginProvenance accepts valid records and rejects invalid ones", () => {
    expect(isValidCatalogOriginProvenance(origin())).toBe(true);
    expect(isValidCatalogOriginProvenance({ ...origin(), source: "central" })).toBe(false);
    expect(isValidCatalogOriginProvenance({ ...origin(), catalogItemId: "" })).toBe(false);
    expect(isValidCatalogOriginProvenance({ ...origin(), catalogVersion: "  " })).toBe(false);
    expect(isValidCatalogOriginProvenance({ catalogItemId: "x" })).toBe(false);
    expect(isValidCatalogOriginProvenance(undefined)).toBe(false);
    expect(isValidCatalogOriginProvenance("nope")).toBe(false);
  });

  test("readCatalogOriginProvenance reads valid provenance and ignores invalid/absent", () => {
    expect(readCatalogOriginProvenance({ catalogOrigin: origin() })).toEqual(origin());
    expect(readCatalogOriginProvenance({ catalogOrigin: { ...origin(), source: "central" } })).toBeUndefined();
    expect(readCatalogOriginProvenance({})).toBeUndefined();
    expect(readCatalogOriginProvenance(undefined)).toBeUndefined();
  });
});

describe("resolveCatalogDrift status resolution", () => {
  const sameCentral: CatalogDriftCentralSummary = { version: "3", contentHash: "sha256:origin" };

  test("current when central matches the recorded origin regardless of local edits", () => {
    // Unedited local copy: digest equals recorded origin hash.
    expect(resolveCatalogDrift(origin(), "sha256:origin", sameCentral)).toEqual<CatalogDriftInfo>({
      status: "current",
      centralVersion: "3",
      centralContentHash: "sha256:origin",
    });
    // Central unchanged but local edited: still current w.r.t. central.
    expect(resolveCatalogDrift(origin(), "sha256:local-edit", sameCentral)).toEqual<CatalogDriftInfo>({
      status: "current",
      centralVersion: "3",
      centralContentHash: "sha256:origin",
    });
  });

  test("behind when central moved and the local copy is still the original content", () => {
    const moved: CatalogDriftCentralSummary = { version: "5", contentHash: "sha256:central-new" };
    expect(resolveCatalogDrift(origin(), "sha256:origin", moved)).toEqual<CatalogDriftInfo>({
      status: "behind",
      centralVersion: "5",
      centralContentHash: "sha256:central-new",
    });
  });

  test("diverged when central moved and the local copy was also edited", () => {
    const moved: CatalogDriftCentralSummary = { version: "5", contentHash: "sha256:central-new" };
    expect(resolveCatalogDrift(origin(), "sha256:local-edit", moved)).toEqual<CatalogDriftInfo>({
      status: "diverged",
      centralVersion: "5",
      centralContentHash: "sha256:central-new",
    });
  });

  test("orphaned when the origin catalog item is no longer present centrally", () => {
    expect(resolveCatalogDrift(origin(), "sha256:origin", undefined)).toEqual<CatalogDriftInfo>({
      status: "orphaned",
    });
    expect(resolveCatalogDrift(origin(), "sha256:local-edit", undefined)).toEqual<CatalogDriftInfo>({
      status: "orphaned",
    });
  });

  test("central version change alone (hash unchanged) is treated as current", () => {
    // Hash equality means content is identical; a stray version bump is not drift.
    expect(resolveCatalogDrift(origin(), "sha256:origin", { version: "4", contentHash: "sha256:origin" })).toEqual<CatalogDriftInfo>({
      status: "current",
      centralVersion: "4",
      centralContentHash: "sha256:origin",
    });
  });
});
