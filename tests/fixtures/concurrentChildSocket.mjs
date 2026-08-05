#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import net from "node:net";

const specPath = process.env.PI_MATERIA_CHILD_LAUNCH_SPEC;
if (typeof specPath !== "string" || specPath.length === 0) throw new Error("fixture child launch spec is missing");

const spec = JSON.parse(await readFile(specPath, "utf8"));
const laneId = spec.identity.laneId;
const loopId = spec.identity.loopId;
const workItems = spec.compiledLoadout.initialData.workItems;
const firstContext = workItems[0]?.context;
const fixture = JSON.parse(firstContext);
const loadout = spec.compiledLoadout.loadout;
const loop = loadout.loops?.[loopId];
const entry = typeof loadout.entry === "string" ? loadout.entry : loadout.entry?.id;
const loopSocketIds = spec.compiledLoadout.nominalProgress?.orderedLoopSocketIds;
if (typeof laneId !== "string" || typeof loopId !== "string" || !Array.isArray(workItems) || typeof entry !== "string" || !loop || !Array.isArray(loopSocketIds) || loopSocketIds.length === 0) {
  throw new Error(`fixture child launch graph is incomplete for ${laneId}`);
}

const total = loopSocketIds.length * workItems.length;
let socket;
let inputBuffer = "";
const responses = [];

function responsePromise() {
  return new Promise((resolve, reject) => {
    responses.push({ resolve, reject });
  });
}

function sendRequest(message) {
  socket.write(`${JSON.stringify(message)}\n`);
  return responsePromise();
}

function writeStdout(message) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });
}

try {
  socket = await new Promise((resolve, reject) => {
    const candidate = net.createConnection({ host: fixture.host, port: fixture.port }, () => resolve(candidate));
    candidate.on("data", (chunk) => {
      inputBuffer += chunk.toString("utf8");
      while (true) {
        const newline = inputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        const pending = responses.shift();
        if (!pending) continue;
        try {
          pending.resolve(JSON.parse(line));
        } catch (error) {
          pending.reject(error);
        }
      }
    });
    candidate.on("error", (error) => {
      while (responses.length > 0) responses.shift().reject(error);
      reject(error);
    });
  });

  async function announce(stage, position, phase, workItemIndex) {
    const occurredAt = Date.now();
    await writeStdout({ type: "pi_materia_child_progress", position, total, socketId: stage });
    const response = await sendRequest({
      kind: "stage",
      phase,
      laneId,
      stage,
      position,
      workItemIndex,
      occurredAt,
    });
    if (response.kind !== "continue") throw new Error(`fixture barrier rejected ${laneId}/${stage}: ${response.message ?? "unknown reason"}`);
  }

  await sendRequest({ kind: "connected", phase: "dispatch", laneId });
  await announce(entry, 0, "prelude", undefined);
  let position = 0;
  for (let workItemIndex = 0; workItemIndex < workItems.length; workItemIndex += 1) {
    for (const stage of loopSocketIds) {
      position += 1;
      await announce(stage, position, "socket-execution", spec.compiledLoadout.initialData.workItemIndexes[workItemIndex]);
    }
  }

  const endedAt = Date.now();
  await sendRequest({ kind: "terminal", phase: "terminal-coordination", laneId, endedAt });
  await writeStdout({
    type: "pi_materia_child_terminal",
    result: {
      status: "succeeded",
      accepted: true,
      endedAt,
      output: { laneId, workItemIndexes: spec.compiledLoadout.initialData.workItemIndexes },
    },
  });
  socket.end();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await sendRequest({ kind: "error", phase: "socket-execution", laneId, message });
  } catch {
    // The parent includes the bounded child stderr artifact in its diagnostics.
  }
  console.error(message);
  process.exitCode = 1;
}
