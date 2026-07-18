import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { runToolHandoffProviderExperiment } from "./toolBackedHandoffExperiment.js";

interface CliOptions {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  repetitions: number;
  maxRecoveryPrompts: number;
  output: string;
}

const options = parseArguments(process.argv.slice(2));
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

function parseArguments(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--")) throw usageError(`Unexpected argument ${JSON.stringify(flag)}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw usageError(`Missing value for ${flag}.`);
    values.set(flag.slice(2), value);
    index += 1;
  }

  const output = values.get("output");
  if (!output) throw usageError("--output is required.");
  const thinking = values.get("thinking") ?? "minimal";
  if (!isThinkingLevel(thinking)) throw usageError(`Unsupported thinking level ${JSON.stringify(thinking)}.`);

  return {
    provider: values.get("provider") ?? "openai-codex",
    model: values.get("model") ?? "gpt-5.4-mini",
    thinking,
    repetitions: integerArgument(values.get("runs") ?? "3", "--runs", 1),
    maxRecoveryPrompts: integerArgument(values.get("max-recovery-prompts") ?? "1", "--max-recovery-prompts", 0),
    output,
  };
}

function integerArgument(value: string, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw usageError(`${flag} must be an integer greater than or equal to ${minimum}.`);
  }
  return parsed;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function usageError(message: string): Error {
  return new Error(`${message}\nUsage: npm run experiment:tool-handoff -- --output <file> [--provider <id>] [--model <id>] [--thinking <level>] [--runs <n>] [--max-recovery-prompts <n>]`);
}
