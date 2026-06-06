# Utility Materia

Utility sockets are deterministic Materia pipeline sockets that run configured local utilities instead of starting a Pi agent/LLM turn. Use them for setup, discovery, code generation, checks, or other repeatable steps that should be visible in the loadout and removable by editing config.

Agent sockets still render prompts and wait for Pi assistant output. Utility sockets skip the agent turn, write artifacts, optionally parse their output, apply `assign`, route through `edges`, participate in `foreach`, and update the same manifest/event log as agent sockets.

## Utility schema

Canonical utility sockets reference reusable top-level utility materia; executable behavior lives on the materia definition:

```ts
// socket
{ "materia": "Ignore-Artifacts", "edges"?: [{ "when"?: string, "to": string }] }

// materia
{
  "type": "utility",
  "label"?: string,
  "description"?: string,
  "group"?: string,
  "color"?: string,
  "command"?: string[],         // explicit local command and args
  "script"?: {                  // shipped utility script resolved through the user profile
    "kind": "shippedUtility",
    "name": "blackbelt-bootstrap.mjs",
    "runtime"?: "node"
  },
  "params"?: object,            // JSON-serializable utility parameters
  "parse"?: "text" | "json",    // default/text preserves stdout; json parses stdout
  "assign"?: { [target: string]: string },
  "timeoutMs"?: number,
  "generator"?: boolean
}
```

A utility materia must configure either `command` or `script`. Commands are string arrays only; pi-materia does not invoke a shell and does not auto-discover project scripts. Runtime sockets reference top-level utility materia such as `Ignore-Artifacts`, `Detect-VCS`, or `Blackbelt-Bootstrap`.

Shipped defaults use the typed script locator `{ "kind": "shippedUtility", "name": "...mjs" }`. On config load, pi-materia syncs packaged scripts to the active profile utilities directory (`${XDG_CONFIG_HOME:-~/.config}/pi/pi-materia/utilities`, or `PI_MATERIA_PROFILE_DIR/utilities` when overridden), records hashes in `.pi-materia-shipped-utilities.json`, and resolves execution to that profile copy. If a user-modified profile script would be overwritten during an update, the modified file is preserved and the new packaged script is written under a hash-suffixed filename that the manifest points to. Relative command script paths from non-shipped config files are still resolved from the directory containing the owning config file, while every spawned process cwd remains the target project directory.

Common mechanics:

- `parse: "json"` parses stdout into `lastJson`; `parse: "text"` or omitted keeps stdout as `lastOutput`.
- `assign` copies values into generic cast state. Prefer utility-owned state patches such as `{ "vcs": "$.state.vcs" }`; explicit script-owned output paths such as `{ "kind": "$.kind" }` are also valid when documented by that utility.
- `edges` evaluate against parsed output (`$`) and state (`state.foo`), then route to `to`.
- `foreach` exposes current item metadata to the utility and can loop over arrays in state.

## JSON stdin/stdout protocol

For command utilities, pi-materia starts the configured process with cwd set to the target project and writes one JSON object to stdin:

```json
{
  "cwd": "/path/to/project",
  "runDir": "/path/to/project/.pi/pi-materia/2026-05-01T00-00-00-000Z",
  "request": "original user request",
  "castId": "2026-05-01T00-00-00-000Z",
  "socketId": "hello",
  "params": { "message": "HELLO WORLD" },
  "state": {},
  "item": null,
  "itemKey": null,
  "itemLabel": null,
  "cursor": null,
  "cursors": {}
}
```

The command writes its result to stdout. With `parse: "json"`, stdout must be valid JSON:

```json
{ "state": { "hello": { "ok": true, "message": "HELLO WORLD" } } }
```

Utility JSON is deterministic script output, not an agent handoff. Scripts may return structured data for explicit `assign` paths, and when a utility is configured to patch shared runtime state directly that structured patch belongs under a top-level `state` object. Do not model utility output as a broad agent envelope; agent-authored handoffs are limited to `workItems`, `satisfied`, and `context`.

## stdout, stderr, exit codes, and timeouts

- Exit code `0` means stdout is the utility result.
- Non-zero exit codes fail the utility socket and cast; the diagnostic includes the command, exit code or signal, stderr summary, and artifact paths.
- stderr is captured as diagnostics in a separate artifact and never replaces stdout as the result.
- Invalid JSON fails the socket when `parse` is `"json"`.
- `timeoutMs` overrides the default 30 second timeout. Timed-out processes are terminated and the utility socket/cast fails.
- Captured stdout and stderr are bounded (currently 1 MiB each). Truncation is recorded in command metadata artifacts.

## Security and trust model

Utility commands are arbitrary local code with the same practical authority as running a script in your shell from the project directory. Only enable loadouts and scripts you trust. Prefer explicit command paths checked into or reviewed with the project, inspect scripts before running casts, avoid shell wrappers unless needed, and set reasonable timeouts/output sizes for predictable behavior.

pi-materia only runs commands or built-in aliases that are explicitly configured in the loadout. Removing a utility socket removes that behavior.

## Complete HELLO WORLD utility loadout

This loadout completes without an LLM turn by using an explicit command utility. Save it as `hello-utility.json`, then run pi-materia with `--materia-config ./hello-utility.json`.

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Hello Utility",
  "loadouts": {
    "Hello Utility": {
      "entry": "hello",
      "sockets": {
        "hello": {
          "materia": "helloUtility",
          "edges": [{ "when": "always", "to": "end" }]
        }
      }
    }
  },
  "materia": {
    "helloUtility": {
      "type": "utility",
      "label": "Hello Utility",
      "command": ["python3", "-c", "import json,sys; ctx=json.load(sys.stdin); print(json.dumps({'state': {'hello': {'ok': True, 'message': ctx['params']['message']}}}))"],
      "params": { "message": "HELLO WORLD" },
      "parse": "json",
      "assign": { "hello": "$.state.hello" }
    }
  }
}
```

Expected result: the cast writes utility input/stdout/stderr/metadata under `.pi/pi-materia/<cast-id>/sockets/hello/` (current-stable artifact path, keyed by socket id), assigns `state.hello`, and ends without asking a model to respond.

## Python example: add ignore patterns

Example script `scripts/ensure_ignored.py`:

```python
#!/usr/bin/env python3
import json
import sys
from pathlib import Path

ctx = json.load(sys.stdin)
cwd = Path(ctx["cwd"])
params = ctx.get("params", {})
patterns = params.get("patterns", [])
ignore_file = cwd / params.get("file", ".gitignore")

existing = ignore_file.read_text() if ignore_file.exists() else ""
lines = existing.splitlines()
added = []

for pattern in patterns:
    if pattern not in lines:
        added.append(pattern)

if added:
    with ignore_file.open("a", encoding="utf-8") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        for pattern in added:
            f.write(pattern + "\n")

print(json.dumps({
    "state": {
        "artifactIgnore": {
            "ok": True,
            "file": str(ignore_file),
            "changed": bool(added),
            "added": added
        }
    }
}))
```

Complete loadout using the script:

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Ignore Artifacts",
  "loadouts": {
    "Ignore Artifacts": {
      "entry": "ignoreArtifacts",
      "sockets": {
        "ignoreArtifacts": {
          "materia": "Ignore-Artifacts",
          "edges": [{ "when": "always", "to": "end" }]
        }
      }
    }
  },
  "materia": {
    "Ignore-Artifacts": {
      "type": "utility",
      "label": "Ignore Artifacts",
      "command": ["python3", "scripts/ensure_ignored.py"],
      "params": {
        "file": ".gitignore",
        "patterns": [".pi/pi-materia/"]
      },
      "parse": "json",
      "assign": { "artifactIgnore": "$.state.artifactIgnore" }
    }
  }
}
```

## Routing from JSON output

Utility JSON output can route with edges:

```json
{
  "materia": "Detect-VCS",
  "edges": [
    { "when": "satisfied", "to": "Maintain" },
    { "when": "not_satisfied", "to": "GitMaintain" },
    { "when": "always", "to": "Socket-3" }
  ]
}
```

The referenced `Detect-VCS` utility materia writes deterministic repository details under `state.vcs` and owns `parse: "json"` plus `assign: { "vcs": "$.state.vcs" }`, so sockets can focus on graph placement and routing. Bootstrap flows should prefer `Blackbelt-Bootstrap` when repository setup is desired instead of asking planners/builders to create manual VCS setup work items.

## Utility generators

Utility materia marked `generator: true` follow the same top-level `workItems` / `satisfied` / `context` contract as agent generators. A deterministic script emits canonical generator output; utility state patches remain under a separate `state` object. This lets utility generators participate in loop regions and generator-to-generator pipelines with `consumes: { "from": "Socket-N", "output": "workItems" }`.

A utility materia may set `generator: true` when a deterministic script should produce generated work items for loop regions. Generator utility output is normalized to `parse: "json"` and must expose top-level `workItems` from stdout JSON. Generated work item entries use the same minimal item shape as agent output: `title:string` plus `context:string`.

Utility scripts should not emit broad agent-envelope fields such as `summary`, `guidance`, `decisions`, `risks`, `feedback`, or `missing`. When deterministic structured data is needed in shared runtime state, put it under a separate top-level `state` object (for example, `{ "state": { "planMetadata": { "source": "script" } }, "workItems": [...] }`) or map script-owned output with explicit `assign` entries. Do not use generated-output aliases such as `tasks`.

### Pass-through generator validators

Some utility generators are validators that do not transform `workItems`. `Commit-Sigil` is the canonical example: it consumes `state.workItems`, validates Conventional Commit title formatting on each item, and echoes the input `workItems` array unchanged. It toggles `satisfied` based on validation results and includes actionable `context` so routing can loop back to planning when titles need correction. It is `generator: true` because it produces canonical top-level `workItems` for downstream generator/loop semantics — not because it rewrites or filters titles. The echoed `workItems` payload carries the same shape as agent generator output into the next socket.

## Bundled utility scripts

The default config defines `Ignore-Artifacts`, `Detect-VCS`, `Blackbelt-Bootstrap`, `Blackbelt-Maintain`, and `Commit-Sigil` as shipped-script utility materia that run profile-resolved copies of their scripts. These scripts use only Node standard APIs, stdin JSON, stdout JSON, and stderr diagnostics. Current ids `ensureArtifactsIgnored` and `detectVcs`, current aliases `project.ensureIgnored` and `vcs.detect`, and generated ids such as `currentUtilityVcsDetect...` are obsolete input, not canonical shipped ids.

### Blackbelt-Bootstrap

`Blackbelt-Bootstrap` is the deterministic replacement for planner-created VCS setup tasks in bootstrap flows. It requires `jj` on `PATH`; if `jj` is missing, the utility hard-fails and writes a `state.blackbeltBootstrap` failure payload. When run in a directory that is not already a jj repository, it runs `jj git init` from the current project directory, including when a plain Git repository already exists, and does not use colocated mode. After detecting or initializing the jj repository, it checks whether the current jj commit is empty with `jj diff --summary`. If the current commit has content, it runs `jj new` so downstream Blackbelt-Maintain work starts from a fresh empty working commit. If the directory is already a jj repository with an empty current commit, it exits successfully without changing repository state.

The utility writes deterministic state under `state.blackbeltBootstrap` (including `ok`, `root`, `available`, `initialized`, `newWorkingCommit`, and `emptyHead` on success). That utility state patch is separate from agent-authored handoff JSON; do not ask planners, builders, or maintainers to emit those fields as agent JSON.

### Commit-Sigil

`Commit-Sigil` is a pass-through generator validator. It is `generator: true` because it produces canonical top-level `workItems` for downstream generator and loop-region semantics — the `Release` loadout loop consumes `workItems` from the Commit-Sigil socket. It does **not** rewrite, filter, or transform titles; it echoes the input `workItems` array unchanged while validating each title against Conventional Commit format (`type: description` or `type(scope): description`, with optional `!` for breaking changes).

The script reads work items from `state.workItems` (with a top-level `workItems` fallback for direct tests), validates each `title` string, and writes canonical generator output:

```json
{
  "workItems": [{"title": "feat: add release workflow", "context": "…"}],
  "satisfied": true,
  "context": "All work items validated."
}
```

When validation fails, `satisfied` is `false` and `context` includes item indices and actionable correction hints so routing can loop back to planning:

```json
{
  "workItems": [{"title": "bad title", "context": "…"}],
  "satisfied": false,
  "context": "Work item 0: title must start with type: (feat:, fix:, chore:, docs:, …)."
}
```

For empty input the script emits `workItems: []` with `satisfied: true`. `Commit-Sigil` never emits `tasks`, `work`, broad-envelope fields, or state patches. Routing consumption is configured on the socket (e.g. `consumes: { "from": "Socket-9", "output": "workItems" }`) while edges key on `satisfied` / `not_satisfied` to advance or loop back.

## Profile verification

To verify this machine's profile and bundled defaults use the current utility form:

1. Inspect `config/default.json` and the active profile config (`${PI_MATERIA_PROFILE_DIR:-~/.config}/pi/pi-materia/config.json`, depending on your profile override).
2. Confirm shipped utility materia ids include `Blackbelt-Bootstrap`, `Detect-VCS`, and `Ignore-Artifacts`.
3. Confirm loadout utility sockets reference those ids with `materia`.
4. Run `bun test tests/defaultUtilityMateria.test.ts tests/config.test.ts tests/utilityNative.test.ts` and `npm run pack:dry-run` before publishing or depending on packaged shipped utilities.

## Local testing

Utilities are easy to test without Pi because the command contract is plain JSON over stdin/stdout:

```bash
printf '{"cwd":"%s","runDir":"%s/.pi/pi-materia/test","request":"test","castId":"test","socketId":"ignoreArtifacts","params":{"patterns":[".pi/pi-materia/"]},"state":{},"item":null,"itemKey":null,"itemLabel":null}\n' "$PWD" "$PWD" \
  | python3 scripts/ensure_ignored.py
```

For the extension itself, install Bun and run:

```bash
npm run typecheck
npm test        # bun test
bun test --watch
```
