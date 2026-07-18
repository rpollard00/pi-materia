import {
  AgentHandoffBuilder,
  AgentHandoffBuilderError,
  type AgentHandoffBuilderOptions,
  type AgentHandoffBuilderScope,
} from "./agentHandoffBuilder.js";

interface ActiveAgentHandoffBuilder {
  readonly scope: AgentHandoffBuilderScope;
  readonly builder: AgentHandoffBuilder;
}

/**
 * Owns at most one active finalization accumulator per Pi session object.
 * Starting another cast, socket visit, or finalization attempt invalidates and
 * clears the previous accumulator before exposing a new one.
 */
export class AgentHandoffBuilderRegistry<Session extends object = object> {
  private readonly activeBySession = new WeakMap<Session, ActiveAgentHandoffBuilder>();

  begin(session: Session, options: AgentHandoffBuilderOptions): AgentHandoffBuilder {
    assertSessionObject(session);
    // Validate the replacement before invalidating a usable active attempt.
    const builder = new AgentHandoffBuilder(options);
    const previous = this.activeBySession.get(session);
    if (previous) previous.builder.discard();

    this.activeBySession.set(session, { scope: builder.scope, builder });
    return builder;
  }

  /** Return the builder only when every run/socket/attempt identity matches. */
  get(session: Session, scope: AgentHandoffBuilderScope): AgentHandoffBuilder | undefined {
    assertSessionObject(session);
    const active = this.activeBySession.get(session);
    return active && sameScope(active.scope, scope) ? active.builder : undefined;
  }

  require(session: Session, scope: AgentHandoffBuilderScope): AgentHandoffBuilder {
    const builder = this.get(session, scope);
    if (builder) return builder;
    throw new AgentHandoffBuilderError("closed", scope, [{
      path: "$.scope",
      message: "no active handoff builder matches this session, cast, socket visit, and finalization attempt",
    }]);
  }

  /**
   * Discard only a matching scope. A stale tool call cannot clear a newer
   * attempt in the same session.
   */
  discard(session: Session, scope: AgentHandoffBuilderScope): boolean {
    assertSessionObject(session);
    const active = this.activeBySession.get(session);
    if (!active || !sameScope(active.scope, scope)) return false;
    active.builder.discard();
    this.activeBySession.delete(session);
    return true;
  }

  clearSession(session: Session): boolean {
    assertSessionObject(session);
    const active = this.activeBySession.get(session);
    if (!active) return false;
    active.builder.discard();
    this.activeBySession.delete(session);
    return true;
  }
}

export function createAgentHandoffBuilderRegistry<Session extends object = object>(): AgentHandoffBuilderRegistry<Session> {
  return new AgentHandoffBuilderRegistry<Session>();
}

function sameScope(left: AgentHandoffBuilderScope, right: AgentHandoffBuilderScope): boolean {
  return left.castId === right.castId
    && left.socketId === right.socketId
    && left.socketVisit === right.socketVisit
    && left.finalizationAttempt === right.finalizationAttempt;
}

function assertSessionObject(value: unknown): asserts value is object {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError("Agent handoff builder sessions must use a non-null object identity.");
  }
}
