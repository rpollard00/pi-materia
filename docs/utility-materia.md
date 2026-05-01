# Utility Materia Nodes

> Design draft: this feature is planned and not fully implemented yet.

Utility Materia nodes are deterministic Materia slots. Use them when a workflow step should run a known local program instead of asking an LLM agent to decide what to do.

Examples:

- ensure `.pi/pi-materia/` is ignored by VCS
- detect whether a project uses `jj`, `git`, or no VCS
- generate files from a schema
- run a formatter/checker and route on the result
- checkpoint work with a configured command

The key rule is that utility behavior is explicit in the loadout. The Materia engine should not secretly hardcode project bootstrap, VCS, or checkpoint policy.

## Minimal utility node

```json
{
  "pipeline": {
    "entry": "hello",
    "nodes": {
      "hello": {
        "type": "utility",
        "command": ["python3", ".pi/materia/hello.py"],
        "params": {
          "message": "HELLO WORLD"
        },
        "assign": {
          "hello": "$"
        },
        "next": "end"
      }
    }
  },
  "roles": {}
}
```

## JSON process protocol

pi-materia runs the configured command and sends a JSON context object on stdin.

Example input:

```json
{
  "cwd": "/path/to/project",
  "runDir": "/path/to/project/.pi/pi-materia/20260430-120000",
  "request": "build auth",
  "castId": "20260430-120000",
  "nodeId": "hello",
  "params": {
    "message": "HELLO WORLD"
  },
  "state": {},
  "item": null,
  "itemKey": null,
  "itemLabel": null
}
```

The utility writes its result to stdout as JSON:

```json
{
  "ok": true,
  "message": "HELLO WORLD"
}
```

Rules:

- stdout is the node result.
- stderr is diagnostic output and should be captured in artifacts.
- exit code `0` means success.
- non-zero exit code fails the node/cast with diagnostics.
- invalid JSON fails the node when the node is in JSON parse mode.
- commands are never auto-loaded; they must be explicitly configured.

## Python example: ensure ignored patterns

```python
#!/usr/bin/env python3
import json
import sys
from pathlib import Path

ctx = json.load(sys.stdin)
cwd = Path(ctx["cwd"])
patterns = ctx.get("params", {}).get("patterns", [])

gitignore = cwd / ".gitignore"
existing = gitignore.read_text() if gitignore.exists() else ""
lines = existing.splitlines()

added = []
for pattern in patterns:
    if pattern not in lines:
        added.append(pattern)

if added:
    with gitignore.open("a") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        for pattern in added:
            f.write(pattern + "\n")

print(json.dumps({
    "ok": True,
    "changed": bool(added),
    "added": added
}))
```

Loadout snippet:

```json
{
  "type": "utility",
  "command": ["python3", ".pi/materia/ensure_ignored.py"],
  "params": {
    "patterns": [".pi/pi-materia/"]
  },
  "assign": {
    "ignoreBootstrap": "$"
  },
  "next": "planner"
}
```

## Routing from utility output

Utility output can drive edges the same way agent JSON output can:

```json
{
  "type": "utility",
  "command": ["python3", ".pi/materia/detect_vcs.py"],
  "assign": {
    "vcs": "$"
  },
  "edges": [
    { "when": "$.kind == \"jj\"", "to": "jjCheckpoint" },
    { "when": "$.kind == \"git\"", "to": "gitCheckpoint" },
    { "when": "$.kind == \"none\"", "to": "initVcs" }
  ]
}
```

## Security model

Utility commands are arbitrary local code. Treat them like scripts you run in your shell:

- only use utilities from trusted projects/packages
- inspect project-local utility scripts before enabling a loadout
- prefer explicit command paths over auto-discovery
- use timeouts and small outputs for predictable behavior

## Testing utilities outside Pi

Because utilities use stdin/stdout JSON, they can be tested directly:

```bash
printf '{"cwd":"%s","params":{"patterns":[".pi/pi-materia/"]}}' "$PWD" \
  | python3 .pi/materia/ensure_ignored.py
```
