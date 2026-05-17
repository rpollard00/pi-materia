# Utility Materia

Utility sockets are deterministic Materia pipeline sockets that run configured local utilities instead of starting a Pi agent/LLM turn. Use them for setup, discovery, code generation, checks, or other repeatable steps that should be visible in the loadout and removable by editing config.

Agent sockets still render prompts and wait for Pi assistant output. Utility sockets skip the agent turn, write artifacts, optionally parse their output, apply `assign`, choose `edges`/`next`, participate in `foreach`, and update the same manifest/event log as agent sockets.

## Utility schema

Canonical utility sockets reference reusable top-level utility materia; executable behavior lives on the materia definition:

```ts
// socket
{ "type": "utility", "materia": "ensureArtifactsIgnored", "edges"?: [{ "when"?: string, "to": string }] }

// materia
{
  "type": "utility",
  "label"?: string,
  "description"?: string,
  "group"?: string,
  "color"?: string,
  "command"?: string[],         // explicit local command and args
  "params"?: object,            // JSON-serializable utility parameters
  "parse"?: "text" | "json",    // default/text preserves stdout; json parses stdout
  "assign"?: { [target: string]: string },
  "timeoutMs"?: number,
  "generator"?: boolean
}
```

A utility materia must configure either `command` or, for legacy compatibility only, `utility`. Commands are string arrays only; pi-materia does not invoke a shell and does not auto-discover project scripts. Built-in aliases `project.ensureIgnored` and `vcs.detect` are retained only so old inline utility sockets can migrate/load; new and saved configs should use command-backed utility materia.

Relative command script paths from loaded config files are resolved from the directory containing the owning config file, while the spawned process cwd remains the target project directory. Bundled defaults use this rule to call packaged scripts in `config/utilities/` without requiring target projects to have those files.

Common mechanics:

- `parse: "json"` parses stdout into `lastJson`; `parse: "text"` or omitted keeps stdout as `lastOutput`.
- `assign` copies values into generic cast state, for example `{ "vcs": "$" }` or `{ "kind": "$.kind" }`.
- `edges` evaluate against parsed output (`$`) and state (`state.foo`), then route to `to`; `next` is the fallback.
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
{ "ok": true, "message": "HELLO WORLD" }
```

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
          "type": "utility",
          "materia": "helloUtility",
          "next": "end"
        }
      }
    }
  },
  "materia": {
    "helloUtility": {
      "type": "utility",
      "label": "Hello Utility",
      "command": ["python3", "-c", "import json,sys; ctx=json.load(sys.stdin); print(json.dumps({'ok': True, 'message': ctx['params']['message']}))"],
      "params": { "message": "HELLO WORLD" },
      "parse": "json",
      "assign": { "hello": "$" }
    }
  }
}
```

Expected result: the cast writes utility input/stdout/stderr/metadata under `.pi/pi-materia/<cast-id>/sockets/hello/` (legacy-stable artifact path, keyed by socket id), assigns `state.hello`, and ends without asking a model to respond.

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
    "ok": True,
    "file": str(ignore_file),
    "changed": bool(added),
    "added": added
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
          "type": "utility",
          "materia": "ensureArtifactsIgnored",
          "next": "end"
        }
      }
    }
  },
  "materia": {
    "ensureArtifactsIgnored": {
      "type": "utility",
      "label": "Ensure artifacts ignored",
      "command": ["python3", "scripts/ensure_ignored.py"],
      "params": {
        "file": ".gitignore",
        "patterns": [".pi/pi-materia/"]
      },
      "parse": "json",
      "assign": { "artifactIgnore": "$" }
    }
  }
}
```

Legacy configs may still contain an inline socket such as `{ "type": "utility", "utility": "project.ensureIgnored" }`. That shape is accepted only by migration/normalization code, which hoists behavior into top-level utility materia and saves canonical socket references. Do not author new loadouts with inline `utility`, `command`, `params`, `parse`, `assign`, or `timeoutMs` on utility sockets.

## Routing from JSON output

Utility JSON output can choose the next socket with edges:

```json
{
  "type": "utility",
  "materia": "detectVcs",
  "edges": [
    { "when": "$.kind == \"jj\"", "to": "Maintain" },
    { "when": "$.kind == \"git\"", "to": "GitMaintain" },
    { "when": "$.kind == \"none\"", "to": "initVcs" }
  ],
  "next": "Socket-3"
}
```

The referenced `detectVcs` utility materia owns `parse: "json"` and `assign: { "vcs": "$" }`, so sockets can focus on graph placement and routing.

## Utility generators

A utility materia may set `generator: true` when a deterministic script should produce the same canonical handoff envelope as a planning agent. Generator utility output is normalized to `parse: "json"` and must expose `workItems` from stdout JSON so loop regions can consume it with `consumes: { "from": "Socket-N", "output": "workItems" }`. Preserve the canonical envelope field names (`summary`, `workItems`, `guidance`, `decisions`, `risks`, `satisfied`, `feedback`, `missing`) and do not use legacy generated-output aliases such as `tasks`.

## Bundled utility scripts

The default config defines `ensureArtifactsIgnored` and `detectVcs` as command-backed utility materia that run `config/utilities/ensure-ignored.mjs` and `config/utilities/detect-vcs.mjs`. These scripts use only Node standard APIs, stdin JSON, stdout JSON, and stderr diagnostics. They are packaged with pi-materia and resolve relative to the bundled config file, while their cwd remains the target project.

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
