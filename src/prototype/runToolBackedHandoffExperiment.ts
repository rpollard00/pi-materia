import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseToolBackedHandoffExperimentArguments } from "./toolBackedHandoffExperimentCli.js";
import { runToolHandoffProviderExperiment } from "./toolBackedHandoffExperiment.js";

const options = parseToolBackedHandoffExperimentArguments(process.argv.slice(2));
const evidence = await runToolHandoffProviderExperiment({
  provider: options.provider,
  model: options.model,
  thinking: options.thinking,
  repetitions: options.repetitions,
  maxRecoveryPrompts: options.maxRecoveryPrompts,
});
const output = path.resolve(options.output);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(`Wrote sanitized provider experiment evidence to ${output}`);
console.log(JSON.stringify(evidence.summary, null, 2));
