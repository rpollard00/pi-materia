import { readFile } from "node:fs/promises";

export type CentralConfigEnv = Readonly<Record<string, string | undefined>>;
export type CentralSecretFileReader = (file: string) => Promise<string>;

export interface CentralSecretEnvNames {
  value: string;
  file: string;
}

/**
 * Resolve a secret from either an environment value or its Docker-secret style
 * `*_FILE` companion. Secret contents are never included in diagnostics.
 */
export async function readCentralSecret(
  env: CentralConfigEnv,
  names: CentralSecretEnvNames,
  readSecretFile: CentralSecretFileReader = defaultSecretFileReader,
): Promise<string | undefined> {
  const direct = nonEmpty(env[names.value]);
  const file = nonEmpty(env[names.file]);
  if (direct !== undefined && file !== undefined) {
    throw new Error(`Central configuration cannot set both ${names.value} and ${names.file}.`);
  }
  if (direct !== undefined) return direct;
  if (file === undefined) return undefined;

  let contents: string;
  try {
    contents = await readSecretFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Central configuration could not read ${names.file} (${file}): ${message}`);
  }
  const secret = contents.trim();
  if (!secret) throw new Error(`Central configuration ${names.file} (${file}) is empty.`);
  return secret;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function defaultSecretFileReader(file: string): Promise<string> {
  return readFile(file, "utf8");
}
