import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelPolicyDocument } from "../domain/modelPolicy.js";

/**
 * Runtime model-policy resolution seam
 * (docs/enterprise-control-plane.md §11, §16.14).
 *
 * The local model selection flow (`applyMateriaModelSettings`) consults this
 * resolver to obtain the active model-policy document before enforcing it. The
 * default {@link createLocalModelPolicyResolver} returns `undefined`, which
 * preserves existing local-only selection behavior exactly: no policy is
 * applied and casts behave as before. At extension composition time the
 * central-connected adapter is registered here; it lazily resolves opt-in
 * runtime configuration and fetches the active policy through `ModelPolicyPort`.
 *
 * This is intentionally a thin runtime configuration seam, not a control-plane
 * port: the application `ModelPolicyPort` (`src/application/controlPlane.ts`)
 * remains the stable abstraction. The connected adapter implements this
 * resolver against that port, keeping enforcement in `applyMateriaModelSettings`
 * decoupled from its concrete HTTP transport.
 */

export interface ModelPolicyResolutionContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}

export interface ModelPolicyResolver {
  resolveActivePolicy(context: ModelPolicyResolutionContext): Promise<ModelPolicyDocument | undefined>;
}

/**
 * Local-only resolver: no central model policy is configured, so it returns
 * `undefined` and selection behavior is preserved exactly. This is the default
 * registered at module load.
 */
export function createLocalModelPolicyResolver(): ModelPolicyResolver {
  return {
    async resolveActivePolicy() {
      return undefined;
    },
  };
}

let activeResolver: ModelPolicyResolver = createLocalModelPolicyResolver();

/**
 * Register the runtime model-policy resolver. Intended to be called once at
 * extension startup to supply a central-connected resolver. The local default
 * (no policy) is used until a resolver is registered, preserving local-only
 * behavior.
 */
export function setActiveModelPolicyResolver(resolver: ModelPolicyResolver): void {
  activeResolver = resolver;
}

/** The currently registered runtime model-policy resolver. */
export function getActiveModelPolicyResolver(): ModelPolicyResolver {
  return activeResolver;
}

/** Reset to the local-only resolver. Primarily for deterministic tests. */
export function resetModelPolicyResolver(): void {
  activeResolver = createLocalModelPolicyResolver();
}

/**
 * Resolve the active model-policy document for the current Pi session. Returns
 * `undefined` in local-only mode, preserving existing local selection behavior.
 */
export async function resolveActiveModelPolicy(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ModelPolicyDocument | undefined> {
  return activeResolver.resolveActivePolicy({ pi, ctx });
}
