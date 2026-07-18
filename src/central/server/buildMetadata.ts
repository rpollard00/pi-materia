import { createRequire } from "node:module";
import { CENTRAL_SCHEMA_VERSION } from "../persistence/index.js";

interface PackageManifest {
  readonly version?: unknown;
}

/** Package version embedded in central admin metadata. */
export const CENTRAL_BUILD_VERSION = readPackageVersion();

/** Schema version supported by this central-server build. */
export const CENTRAL_BUILD_SCHEMA_VERSION = CENTRAL_SCHEMA_VERSION;

function readPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest = require("../../../package.json") as PackageManifest;
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
    throw new Error("Central server could not resolve a package build version.");
  }
  return manifest.version;
}
