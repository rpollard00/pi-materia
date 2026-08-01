import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const scriptPath = path.resolve("config", "utilities", "parallel-lane-checkpoint.mjs");

test("bundled config registers the lane-local checkpoint as a child-safe shipped utility", async () => {
  const config = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8")) as {
    materia?: Record<string, Record<string, unknown>>;
  };
  expect(config.materia?.["Parallel-Lane-Checkpoint"]).toMatchObject({
    type: "utility",
    parse: "json",
    parallelSafe: true,
    script: { kind: "shippedUtility", name: "parallel-lane-checkpoint.mjs", runtime: "node" },
  });
});

type CheckpointOutput = {
  satisfied: boolean;
  context: string;
  state?: { parallelLaneCheckpoint?: Record<string, any> };
};

async function makeFakeJj(options: { dirty?: boolean; fail?: "describe" | "new" | "status" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-lane-jj-"));
  const log = path.join(dir, "jj.log");
  const statusFile = path.join(dir, "status");
  const revisionFile = path.join(dir, "revision");
  await writeFile(statusFile, options.dirty === false ? "clean" : "dirty");
  await writeFile(revisionFile, "1");
  const fail = options.fail ?? "";
  const executable = path.join(dir, "jj");
  await writeFile(executable, `#!/usr/bin/env bash
printf '%s|%s\\n' "$PWD" "$*" >> "$JJ_LOG"
case "$1" in
  status)
    if [ "${fail}" = "status" ]; then exit 1; fi
    if [ "$(cat \"$JJ_STATUS\")" = "clean" ]; then echo "The working copy has no changes."; else echo "Working copy changes:"; echo "M src/change.ts"; fi
    ;;
  describe)
    if [ "${fail}" = "describe" ]; then exit 1; fi
    ;;
  log)
    if [[ "$*" == *"empty"* ]]; then
      if [ "$(cat \"$JJ_STATUS\")" = "clean" ]; then echo true; else echo false; fi
    else
      revision=$(cat "$JJ_REVISION")
      printf 'commit-%s\\tchange-%s\\n' "$revision" "$revision"
    fi
    ;;
  new)
    if [ "${fail}" = "new" ]; then exit 1; fi
    printf clean > "$JJ_STATUS"
    revision=$(cat "$JJ_REVISION")
    printf '%s' "$((revision + 1))" > "$JJ_REVISION"
    ;;
esac
`, "utf8");
  await chmod(executable, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log, statusFile };
}

async function runCheckpoint(input: Record<string, unknown>, fake: Awaited<ReturnType<typeof makeFakeJj>>) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-lane-cwd-"));
  const processHandle = Bun.spawn([process.execPath, scriptPath], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
      JJ_LOG: fake.log,
      JJ_STATUS: fake.statusFile,
      JJ_REVISION: path.join(fake.dir, "revision"),
    },
  });
  processHandle.stdin.write(`${JSON.stringify({ cwd, ...input })}\n`);
  processHandle.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout) as CheckpointOutput;
}

describe("Parallel-Lane-Checkpoint shipped utility", () => {
  test("skips clean lane working copies without describe or new", async () => {
    const fake = await makeFakeJj({ dirty: false });
    const output = await runCheckpoint({
      item: { title: "feat: no-op lane item" },
      itemKey: "0",
      params: { laneId: "lane-api" },
      state: {
        parallelLaneCheckpoint: {
          laneId: "lane-api",
          latestMeaningfulHead: { commitId: "commit-old", changeId: "change-old" },
          checkpoints: [{ itemTitle: "feat: previous", head: { commitId: "commit-old", changeId: "change-old" } }],
        },
      },
    }, fake);

    expect(output.satisfied).toBe(true);
    expect(output.context).toContain("skipped empty checkpoint");
    expect(output.state?.parallelLaneCheckpoint).toMatchObject({
      ok: true,
      laneId: "lane-api",
      checkpointCreated: false,
      latestMeaningfulHead: { commitId: "commit-old", changeId: "change-old" },
    });
    expect(output.state?.parallelLaneCheckpoint?.checkpoints).toHaveLength(1);
    const log = await readFile(fake.log, "utf8");
    expect(log).toContain("status");
    expect(log).not.toContain("describe");
    expect(log).not.toContain(" new");
    expect(log).not.toContain("bookmark");
  });

  test("describes meaningful work, records each lane head, and opens a fresh empty commit", async () => {
    const fake = await makeFakeJj();
    const first = await runCheckpoint({ item: { title: "feat: first lane item" }, itemKey: "0", state: {} }, fake);
    expect(first.satisfied).toBe(true);
    expect(first.state?.parallelLaneCheckpoint).toMatchObject({
      checkpointCreated: true,
      latestMeaningfulHead: { commitId: "commit-1", changeId: "change-1" },
    });

    await writeFile(fake.statusFile, "dirty");
    const second = await runCheckpoint({
      item: { title: "fix: second lane item" },
      itemKey: "1",
      state: first.state,
    }, fake);
    expect(second.satisfied).toBe(true);
    expect(second.state?.parallelLaneCheckpoint).toMatchObject({
      checkpointCreated: true,
      latestMeaningfulHead: { commitId: "commit-2", changeId: "change-2" },
    });
    expect(second.state?.parallelLaneCheckpoint?.checkpoints).toHaveLength(2);
    expect(second.state?.parallelLaneCheckpoint?.checkpoints?.map((entry: any) => entry.itemTitle)).toEqual([
      "feat: first lane item",
      "fix: second lane item",
    ]);

    const log = await readFile(fake.log, "utf8");
    expect(log).not.toContain("bookmark");
    expect(log.match(/describe/g)).toHaveLength(2);
    expect(log.match(/new/g)).toHaveLength(2);
    expect(log.match(/empty/g)).toHaveLength(2);
  });

  test("reports jj failures without touching bookmarks", async () => {
    const fake = await makeFakeJj({ fail: "new" });
    const output = await runCheckpoint({ item: { title: "feat: failing lane item" }, state: {} }, fake);
    expect(output.satisfied).toBe(false);
    expect(output.context).toContain("jj new failed");
    expect(output.state?.parallelLaneCheckpoint).toMatchObject({
      ok: false,
      checkpointCreated: false,
      latestMeaningfulHead: { commitId: "commit-1", changeId: "change-1" },
    });
    expect(await readFile(fake.log, "utf8")).not.toContain("bookmark");
  });

  test("supports concurrent lane processes against one repository without shared-ref commands", async () => {
    const fake = await makeFakeJj();
    const [api, ui] = await Promise.all([
      runCheckpoint({ item: { title: "feat: api lane" }, params: { laneId: "lane-api" }, state: {} }, fake),
      runCheckpoint({ item: { title: "feat: ui lane" }, params: { laneId: "lane-ui" }, state: {} }, fake),
    ]);

    expect(api.satisfied).toBe(true);
    expect(ui.satisfied).toBe(true);
    expect(api.state?.parallelLaneCheckpoint?.laneId).toBe("lane-api");
    expect(ui.state?.parallelLaneCheckpoint?.laneId).toBe("lane-ui");
    expect(await readFile(fake.log, "utf8")).not.toContain("bookmark");
  });
});
