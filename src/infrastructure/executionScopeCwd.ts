import { statSync } from "node:fs";
import path from "node:path";

/** Validate a utility-selected cwd at the filesystem boundary. */
export function assertExecutionScopeCwd(cwd: string): void {
  if (!path.isAbsolute(cwd)) throw new Error("utility execution scope cwd must be absolute.");
  let stats;
  try {
    stats = statSync(cwd);
  } catch (error) {
    throw new Error(`utility execution scope cwd is unavailable: ${JSON.stringify(cwd)}.`, { cause: error });
  }
  if (!stats.isDirectory()) throw new Error(`utility execution scope cwd is not a directory: ${JSON.stringify(cwd)}.`);
}
