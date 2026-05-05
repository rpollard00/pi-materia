# Utility Materia

Utility nodes are deterministic Materia pipeline nodes that run configured local utilities instead of starting a Pi agent/LLM turn. Use them for setup, discovery, code generation, checks, or other repeatable steps that should be visible in the loadout and removable by editing config.

Agent nodes still render prompts and wait for Pi assistant output. Utility nodes skip the agent turn, write artifacts, optionally parse their output, apply `assign`, choose `edges`/`next`, participate in `foreach`, and update the same manifest/event log as agent nodes.

## Utility node schema

A pipeline node with `type: "utility"` supports:

```ts
{
  "type": "utility",
  "utility"?: string,           // built-in alias, e.g. "project.ensureIgnored"
  "command"?: string[],         // explicit local command and args
  "params"?: object,            // JSON-serializable utility parameters
  "parse"?: "text" | "json",    // default/text preserves stdout; json parses stdout
  "assign"?: { [target: string]: string },
  "next"?: string,
  "edges"?: [{ "when"?: string, "to": string, "maxTraversals"?: number }],
  "foreach"?: { "items": string, "as"?: string, "cursor"?: string, "done"?: string },
  "advance"?: { "cursor": string, "items": string, "done"?: string },
  "limits"?: { "maxVisits"?: number, "maxEdgeTraversals"?: number, "maxOutputBytes"?: number },
  "timeoutMs"?: number
}
```

A utility node must configure either `command` or `utility`. Commands are string arrays only; pi-materia does not invoke a shell and does not auto-discover project scripts. Built-in aliases currently include `project.ensureIgnored` and `vcs.detect`.

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
  "nodeId": "hello",
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
- Non-zero exit codes fail the utility node and cast; the diagnostic includes the command, exit code or signal, stderr summary, and artifact paths.
- stderr is captured as diagnostics in a separate artifact and never replaces stdout as the result.
- Invalid JSON fails the node when `parse` is `"json"`.
- `timeoutMs` overrides the default 30 second timeout. Timed-out processes are terminated and the node/cast fails.
- Captured stdout and stderr are bounded (currently 1 MiB each). Truncation is recorded in command metadata artifacts.

## Security and trust model

Utility commands are arbitrary local code with the same practical authority as running a script in your shell from the project directory. Only enable loadouts and scripts you trust. Prefer explicit command paths checked into or reviewed with the project, inspect scripts before running casts, avoid shell wrappers unless needed, and set reasonable timeouts/output sizes for predictable behavior.

pi-materia only runs commands or built-in aliases that are explicitly configured in the loadout. Removing a utility node removes that behavior.

## Complete HELLO WORLD utility loadout

This loadout completes without an LLM turn by using an explicit command utility. Save it as `hello-utility.json`, then run pi-materia with `--materia-config ./hello-utility.json`.

```json
{
  "artifactDir": ".pi/pi-materia",
  "activeLoadout": "Hello Utility",
  "loadouts": {
    "Hello Utility": {
      "entry": "hello",
      "nodes": {
        "hello": {
          "type": "utility",
          "command": ["python3", "-c", "import json,sys; ctx=json.load(sys.stdin); print(json.dumps({'ok': True, 'message': ctx['params']['message']}))"],
          "params": { "message": "HELLO WORLD" },
          "parse": "json",
          "assign": { "hello": "$" },
          "next": "end"
        }
      }
    }
  },
  "roles": {}
}
```

Expected result: the cast writes utility input/stdout/stderr/metadata under `.pi/pi-materia/<cast-id>/nodes/hello/`, assigns `state.hello`, and ends without asking a model to respond.

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
      "nodes": {
        "ignoreArtifacts": {
          "type": "utility",
          "command": ["python3", "scripts/ensure_ignored.py"],
          "params": {
            "file": ".gitignore",
            "patterns": [".pi/pi-materia/"]
          },
          "parse": "json",
          "assign": { "artifactIgnore": "$" },
          "next": "end"
        }
      }
    }
  },
  "roles": {}
}
```

The bundled built-in alias can express the same hygiene directly in config:

```json
{
  "type": "utility",
  "utility": "project.ensureIgnored",
  "params": { "patterns": [".pi/pi-materia/"] },
  "parse": "json",
  "assign": { "artifactIgnore": "$" },
  "next": "planner"
}
```

## Routing from JSON output

Utility JSON output can choose the next node with edges:

```json
{
  "type": "utility",
  "utility": "vcs.detect",
  "parse": "json",
  "assign": { "vcs": "$" },
  "edges": [
    { "when": "$.kind == \"jj\"", "to": "Maintain" },
    { "when": "$.kind == \"git\"", "to": "GitMaintain" },
    { "when": "$.kind == \"none\"", "to": "initVcs" }
  ],
  "next": "planner"
}
```

## Local testing

Utilities are easy to test without Pi because the command contract is plain JSON over stdin/stdout:

```bash
printf '{"cwd":"%s","runDir":"%s/.pi/pi-materia/test","request":"test","castId":"test","nodeId":"ignoreArtifacts","params":{"patterns":[".pi/pi-materia/"]},"state":{},"item":null,"itemKey":null,"itemLabel":null}\n' "$PWD" "$PWD" \
  | python3 scripts/ensure_ignored.py
```

For the extension itself, install Bun and run:

```bash
npm run typecheck
npm test        # bun test
bun test --watch
```
