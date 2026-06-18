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

Utility JSON output may also include an optional `event` array for structured runtime event emission. The `event` field is a side-channel processed and stripped before state extraction — it does not affect `state.*` patches, routing, or handoff semantics. See [Runtime Eventing Contract](runtime-eventing.md).

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

The default config defines `Ignore-Artifacts`, `Detect-VCS`, `Blackbelt-Bootstrap`, `Blackbelt-Maintain`, `Blackbelt-GH-PR`, and `Commit-Sigil` as shipped-script utility materia that run profile-resolved copies of their scripts. These scripts use only Node standard APIs, stdin JSON, stdout JSON, and stderr diagnostics. Current ids `ensureArtifactsIgnored` and `detectVcs`, current aliases `project.ensureIgnored` and `vcs.detect`, and generated ids such as `currentUtilityVcsDetect...` are obsolete input, not canonical shipped ids.

### Blackbelt-Bootstrap

`Blackbelt-Bootstrap` is the deterministic replacement for planner-created VCS setup tasks in bootstrap flows. It requires `jj` on `PATH`; if `jj` is missing, the utility hard-fails and writes a `state.blackbeltBootstrap` failure payload. When run in a directory that is not already a jj repository, it runs `jj git init` from the current project directory, including when a plain Git repository already exists, and does not use colocated mode. After detecting or initializing the jj repository, it checks whether the current jj commit is empty with `jj diff --summary`. If the current commit has content, it runs `jj new` so downstream Blackbelt-Maintain work starts from a fresh empty working commit. If the directory is already a jj repository with an empty current commit, it exits successfully without changing repository state.

The utility writes deterministic state under `state.blackbeltBootstrap` (including `ok`, `root`, `available`, `initialized`, `newWorkingCommit`, `emptyHead`, and `bookmarkName` on success). The `bookmarkName` is a deterministic git-ref-safe name under the `blackbelt/` prefix shaped like `blackbelt/<noun>-<verb>-<short-hash>` (for example, `blackbelt/crystal-casts-1a2b3c4d5e`) that `Blackbelt-Maintain` reads to advance the bookmark with each checkpoint. Naming priority: explicit sanitized `params.bookmarkName` override, otherwise a SHA-256-derived noun/verb/hash name seeded by `input.castId`; `runDir` and `cwd` are used only as last-resort seeds when `castId` is absent. Generated names do not expose timestamps or raw cast ids. This utility state patch is separate from agent-authored handoff JSON; do not ask planners, builders, or maintainers to emit those fields as agent JSON.

### Blackbelt-Maintain

`Blackbelt-Maintain` is the deterministic replacement for agent-authored maintain/checkpoint tasks. It is **jj-only** — there is no git fallback. If `jj` is unavailable or no jj repository is detected, the utility returns `satisfied: false` with context telling the user to run `Blackbelt-Bootstrap` first.

For each invocation, the utility:
1. Reads the current work item title from `input.item.title`.
2. Resolves the bookmark name from `state.blackbeltBootstrap.bookmarkName`; if that bootstrap state is absent, returns `satisfied: false` with actionable context to run `Blackbelt-Bootstrap` instead of generating a replacement bookmark.
3. Checks for dirty changes with `jj diff --summary`. If the working commit is clean, it returns `satisfied: true` as a no-op (no empty checkpoints).
4. If dirty, runs `jj describe -m <title>`, moves the session bookmark to the described commit (before `jj new` so a post-new failure cannot leave a stale bookmark), then runs `jj new` to open a fresh empty working commit for the next task.

Result context includes the bookmark name in brackets (e.g. `[bookmark: blackbelt/...]`) for all paths: no-title, no-jj/no-root, clean no-op, checkpoint success, and command failure.

`Blackbelt-Maintain` writes only a top-level `satisfied` / `context` result. Bookmark state lives under the bootstrap-owned `state.blackbeltBootstrap.bookmarkName` and is not re-emitted or partially overwritten by maintain. This utility state is separate from agent-authored handoff JSON.

### Commit-Sigil

`Commit-Sigil` is a pass-through generator validator. It is `generator: true` because it produces canonical top-level `workItems` for downstream generator and loop-region semantics — downstream loop regions consume `workItems` from the Commit-Sigil socket. It does **not** rewrite, filter, or transform titles; it echoes the input `workItems` array unchanged while validating each title against Conventional Commit format (`type: description` or `type(scope): description`, with optional `!` for breaking changes).

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

### Blackbelt-GH-PR

`Blackbelt-GH-PR` is a deterministic **jj-only** utility in the blackbelt family (no git fallback). It pushes a specified or inferred jj bookmark to a GitHub remote and creates a pull request through the GitHub API. If `jj` is unavailable, no jj repository is detected, or git is suggested as a fallback, the utility hard-fails with a clear diagnostic.

#### Parameters

| Parameter | Default | Description |
|---|---|---|
| `bookmark` | `state.blackbeltBootstrap.bookmarkName` | Explicit bookmark name to push. Falls back to bootstrap-owned bookmark when absent. |
| `revision` | the bookmark itself or `@` | Revision to push. When provided, the utility validates resolution, sets the bookmark to that revision, then pushes. When absent, the utility verifies the bookmark exists and pushes its current target. |
| `base` | inferred from remote HEAD | PR base branch. Falls back to the remote's default branch via the GitHub API (`main` when unresolvable). |
| `remote` | `"origin"` | Git remote name used for push and remote URL resolution. |
| `repo` | parsed from remote URL | Explicit `owner/repo` for the GitHub API. Parsed from https/ssh remote URLs when absent. |
| `title` | inferred (see below) | PR title override. |
| `body` | none | PR body text. Omits the `body` field from the API payload when absent. |
| `draft` | `false` | When `true`, creates the PR as a draft. |
| `authEnv` | `"GITHUB_TOKEN"` | Environment variable name that contains the GitHub personal access token. |
| `apiBaseUrl` | `"https://api.github.com"` | GitHub API base URL. Supports GitHub Enterprise Server and testing overrides. Respects `GITHUB_API_URL` env var when not explicitly set. |

#### PR title inference order

The utility resolves the PR title from the first available source:

1. **`params.title`** — explicit override; used as-is when present.
2. **First line of the revision's `jj` description** — when `params.revision` is provided, reads the description of that revision; when only a bookmark is used, reads the bookmark's description. If the revision was explicitly provided and its description cannot be read (after the revision was already validated), the utility fails instead of silently falling back.
3. **Bookmark name** — final fallback when no explicit title and no description are available.

#### Push and PR creation

1. Resolves bookmark name from `params.bookmark` or bootstrap state.
2. If `params.revision` is provided: validates the revision with `jj log -r <rev>`, sets the bookmark to that revision with `jj bookmark set`, then pushes the bookmark. Fails clearly on unresolvable revisions or bookmark-set errors.
3. If no revision: verifies the bookmark exists with exact-match parsing of `jj bookmark list` (partial/substring matches are rejected).
4. Resolves the remote URL from `jj git remote list` and parses the GitHub owner/repo.
5. Pushes the bookmark with `jj git push --bookmark <name> --remote <remote>`.
6. Resolves the base branch from the GitHub API (or `params.base`).
7. Creates the PR via `POST /repos/:owner/:repo/pulls`.

#### Output contract

On success, writes deterministic state under `state.blackbeltGhPr`:

```json
{
  "state": {
    "blackbeltGhPr": {
      "ok": true,
      "prUrl": "https://github.com/owner/repo/pull/42",
      "prNumber": 42,
      "bookmarkName": "blackbelt/crystal-casts-1a2b3c4d5e",
      "revision": "abc123def456",
      "remote": "origin",
      "repo": "owner/repo",
      "base": "main",
      "draft": false,
      "title": "feat: example PR title"
    }
  }
}
```

On failure, writes a failure payload with `ok: false` and diagnostic details under the same `state.blackbeltGhPr` key. Failure payloads include specific boolean flags (`available.jj`, `hasJjRepo`, `bookmarkExists`, `revisionResolved`, `bookmarkSetOk`, `remoteResolved`, `repoResolved`, `tokenFound`, `pushOk`, `prOk`, `apiStatus`) so downstream routing can distinguish failure modes without parsing error strings. Non-zero exit codes signal failure to pi-materia.

#### Auth setup

Authentication is parameterized, not hard-coded:

- **Default**: reads the token from the `GITHUB_TOKEN` environment variable.
- **Custom**: set `params.authEnv` to any environment variable name (e.g. `"GH_PAT"`, `"MY_ORG_BOT_TOKEN"`).
- **Missing auth**: the utility fails immediately with a diagnostic naming the expected environment variable (`tokenFound: false`), before any push or API call is attempted.
- **No token values in artifacts**: the utility never logs, prints, or writes the token value to stdout, stderr, or artifact files. Only the environment variable *name* appears in diagnostics.

This pattern follows the external integration utility rules documented in [External integration utilities](#external-integration-utilities).

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

## External integration utilities

Utility materia that integrate with external services (GitHub, GitLab, CI/CD platforms, artifact registries, package registries, issue trackers, etc.) must follow additional rules beyond the base utility contract. These rules make utilities safe for enterprise and autonomous-agent workflows where secrets, auditability, and deterministic failure reporting matter.

### Authentication

#### Parameterized credentials — no secret literals

External service credentials must **never** appear as literal values in loadout config, utility parameters, plans, prompts, logs, or artifacts. Instead, utilities must accept credentials through one of these indirections:

1. **Named environment variable** (canonical): the utility reads a token or key from `process.env[varName]` where `varName` is a configurable parameter (defaulting to a conventional name like `GITHUB_TOKEN`, `NPM_TOKEN`, or `DOCKER_REGISTRY_PASSWORD`). This is the preferred pattern because environment variables are external to the loadout and never serialized into config files.

2. **Explicit configured parameter reference**: the utility accepts a parameter that names the environment variable to use (e.g. `params.authEnv`). This allows a single utility to support multiple credential sources without code changes and keeps the indirection explicit in loadout configuration.

Both patterns keep the credential *value* outside the loadout and artifact system. The credential *name* may appear in config/params because it is not a secret.

#### No token values in diagnostics

Utilities must never emit credential values to:

- **stdout** (the main output stream parsed by pi-materia)
- **stderr** (captured as diagnostic artifacts)
- **Log files** or artifact files written by the utility
- **API URLs or query strings** visible in error messages

When reporting auth failures, the utility must name the *expected environment variable* (e.g. `"GITHUB_TOKEN"`) but never include the token value or any prefix/suffix of it. HTTP 401/403 responses from external APIs must be reported with the status code and a generic message, not with the failing token header.

#### Clear failure on missing credentials

When a required credential is not available, the utility must fail **before** any external call is attempted. The failure payload must include:

- An explicit identification of what is missing (the environment variable name)
- A boolean diagnostic flag (e.g. `tokenFound: false`) for programmatic routing
- A human-readable error message suitable for plan/log review

Example failure payload:

```json
{
  "state": {
    "myService": {
      "ok": false,
      "error": "My-Utility: GitHub token not found in environment variable \"GITHUB_TOKEN\". Set GITHUB_TOKEN or configure params.authEnv.",
      "authEnv": "GITHUB_TOKEN",
      "tokenFound": false
    }
  }
}
```

Do not silently degrade to unauthenticated mode, swallow missing-credential errors into a generic failure, or attempt the external call without credentials. Pre-flight checks must be deterministic: fail fast, fail clearly.

### External API calls

Utilities that make outbound HTTP calls to external APIs must:

- Use deterministic timeouts (either the utility-level `timeoutMs` or a reasonable built-in default such as 30 seconds).
- Treat non-2xx API responses as failures with structured diagnostics, including the HTTP status code, the API-supplied error message (which is *not* a secret), and a boolean flag for programmatic routing.
- Handle network errors (DNS failures, connection refused, TLS errors, timeouts) as distinct failure modes with clear context.
- Avoid retry logic in the utility itself; pi-materia routing/loop semantics handle retry at the cast level. Utilities should be single-attempt deterministic producers.

### Deterministic state output

#### Own your state key

Each external integration utility must write its results under a single top-level key inside the `state` object that is unique to that utility (e.g. `state.blackbeltGhPr`, `state.releasePlease`, `state.containerRegistry`). Never write directly into a shared namespace or into fields owned by another utility.

#### Include diagnostic booleans

Failure payloads must include specific boolean flags that describe which step failed, so downstream routing can act on structured data rather than parsing error strings. Examples:

- `tokenFound: false` — auth credential missing
- `pushOk: false` — push to external service failed
- `apiStatus: 422` — the API rejected the request
- `remoteResolved: false` — could not resolve the remote endpoint

Success payloads should include the stable outcome fields needed by downstream consumers.

### Separation from agent handoff JSON

Utility state is **not** agent-authored handoff JSON. The two contracts are distinct:

| Aspect | Utility state | Agent handoff |
|---|---|---|
| Top-level fields | `state: { utilityName: {...} }` | `workItems`, `satisfied`, `context` |
| Authorship | Deterministic script | LLM/model response |
| Routing fields | None (state only) | `satisfied` (boolean) |
| Persistence | Shallow-merged into runtime state | Parsed, assigned, and routed |

External integration utilities must **never** emit `workItems`, `satisfied`, or `context` at the top level of their stdout JSON. Those fields are reserved for agent-authored handoffs and utility generators (which follow a separate contract — see [Utility generators](#utility-generators)).

When an integration utility needs to expose structured data for downstream consumption, the data belongs under a utility-owned `state` key. Sockets that consume that data should use explicit `assign` paths into generic cast state.

Do not mix utility state patches into agent-authored JSON. Agents must not emit `state.myUtility` fields when producing their `workItems`/`satisfied`/`context` handoff. If an agent needs integration utility results, the socket adapter should supply them through prompt context assembly, not by asking the agent to repeat or re-emit utility state.

### Testing external integration utilities

Test external integration utilities by mocking the external service at the HTTP level (not by mocking credential resolution). The blackbelt-gh-pr test suite demonstrates this pattern:

- Start a local HTTP server that responds to expected API endpoints.
- Inject the server URL via a utility parameter (`apiBaseUrl`).
- Simulate auth success (valid token in env), auth failures (missing/expired tokens, 401 responses), and API errors (422, 404, 5xx).
- Assert on structured `state.utilityName` payloads and exit codes.
- Never include real credentials in test fixtures or mock setup.

This keeps tests fast, deterministic, and free of external network dependencies while exercising the full utility execution path.
