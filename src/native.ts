// Compatibility barrel for legacy imports. Runtime implementation lives in
// castRuntime.ts; new code should import focused application/infrastructure
// modules or compose runtime adapters at the plugin edge.
export * from "./castRuntime.js";
