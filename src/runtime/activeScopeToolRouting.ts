import path from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { MateriaCastState } from "../types.js";

/**
 * Route Pi's cwd-bound coding tools through the active execution scope.
 * Pi extension contexts keep the session-project cwd, so relative tool inputs
 * must be made scope-relative at this boundary.
 */
export function routeAgentToolCallToActiveScope(event: ToolCallEvent, state: MateriaCastState | undefined): void {
  if (!state?.active || (state.socketState !== "awaiting_agent_response" && state.socketState !== "awaiting_user_refinement")) return;
  const cwd = state.activeScope.cwd;
  const input = event.input as Record<string, unknown>;

  if (event.toolName === "bash" && typeof input.command === "string") {
    input.command = `cd -- ${shellQuote(cwd)} && ${input.command}`;
    return;
  }
  if (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") {
    absolutize(input, "path", cwd, false);
    return;
  }
  if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
    absolutize(input, "path", cwd, true);
  }
}

function absolutize(input: Record<string, unknown>, key: string, cwd: string, defaultToCwd: boolean): void {
  const value = input[key];
  if (value === undefined && defaultToCwd) {
    input[key] = cwd;
  } else if (typeof value === "string" && !path.isAbsolute(value)) {
    input[key] = path.resolve(cwd, value);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
