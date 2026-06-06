import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const bootstrapScript = path.resolve("config", "utilities", "blackbelt-bootstrap.mjs");
const maintainScript = path.resolve("config", "utilities", "blackbelt-maintain.mjs");

async function makeFakeJj() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-fake-jj-"));
  const log = path.join(dir, "jj.log");
  const jj = path.join(dir, "jj");
  await writeFile(
    jj,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$JJ_LOG"
case "$1" in
  root)
    pwd
    ;;
  diff)
    if [ "$JJ_DIRTY" = "1" ]; then echo 'M file.txt'; fi
    ;;
  git|bookmark|describe|new)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    "utf8",
  );
  await chmod(jj, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log };
}

async function runUtility(script: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(`${JSON.stringify(input)}\n`);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode, json: JSON.parse(stdout) };
}

async function runBootstrap(input: Record<string, unknown>) {
  const fake = await makeFakeJj();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-bootstrap-cwd-"));
  return runUtility(
    bootstrapScript,
    { cwd, runDir: path.join(cwd, ".pi", "pi-materia", "run"), state: {}, ...input },
    { PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`, JJ_LOG: fake.log },
  );
}

describe("Blackbelt utility scripts", () => {
  test("bootstrap generates deterministic noun-verb-hash bookmark names from castId", async () => {
    const castId = "2026-06-06T19-39-18-566Z";
    const first = await runBootstrap({ castId });
    const second = await runBootstrap({ castId });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const bookmarkName = first.json.state.blackbeltBootstrap.bookmarkName;
    expect(bookmarkName).toBe(second.json.state.blackbeltBootstrap.bookmarkName);
    expect(bookmarkName).toMatch(/^blackbelt\/[a-z0-9]+-[a-z]+-[a-f0-9]{10}$/);
    expect(bookmarkName.endsWith(createHash("sha256").update(castId).digest("hex").slice(0, 10))).toBe(true);
    expect(bookmarkName).not.toContain(castId.toLowerCase());
  });

  test("bootstrap generated names are ref-safe and do not expose raw cast ids", async () => {
    const castId = "Feature/Bad @{Cast} Name.lock 2026-06-06T19:39:18.566Z";
    const result = await runBootstrap({ castId });

    expect(result.exitCode).toBe(0);
    const bookmarkName = result.json.state.blackbeltBootstrap.bookmarkName;
    expect(bookmarkName).toMatch(/^blackbelt\/[a-z0-9]+-[a-z]+-[a-f0-9]{10}$/);
    expect(bookmarkName).not.toContain("feature");
    expect(bookmarkName).not.toContain("name.lock");
    expect(bookmarkName).not.toContain("@{");
    expect(bookmarkName).not.toContain(" ");
  });

  test("bootstrap preserves explicit bookmarkName as a sanitized override", async () => {
    const result = await runBootstrap({
      castId: "ignored-cast-id",
      params: { bookmarkName: "Feature Name.lock" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.state.blackbeltBootstrap.bookmarkName).toBe("blackbelt/feature-name-lock");
  });

  test("maintain refuses to invent a bookmark when bootstrap state is missing", async () => {
    const fake = await makeFakeJj();
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-maintain-cwd-"));
    const result = await runUtility(
      maintainScript,
      {
        cwd,
        castId: "2026-06-06T19-39-18-566Z",
        state: {},
        item: { title: "fix: checkpoint" },
      },
      { PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`, JJ_LOG: fake.log },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({
      satisfied: false,
      context: "Blackbelt-Maintain: missing state.blackbeltBootstrap.bookmarkName. Run Blackbelt-Bootstrap first so maintain can advance the bootstrap-owned bookmark.",
    });
    expect(await readFile(fake.log, "utf8")).toBe("");
  });
});
