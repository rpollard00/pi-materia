# Release workflow

pi-materia uses [Release Please](https://github.com/googleapis/release-please) to automate versioning, changelogs, and npm publishing with [trusted publishing](https://docs.npmjs.com/generating-provenance-statements) (provenance).

## Overview

```
PR merge → CI checks → main push → Release Please
                                      ├─ opens/updates release PR
                                      └─ on release PR merge:
                                           ├─ creates GitHub release + tag
                                           └─ triggers npm publish (trusted publishing)
```

## Conventional Commit conventions

All commits to `main` should follow the [Conventional Commits](https://www.conventionalcommits.org/) format. Release Please reads commit messages to determine the next version bump:

| Commit type | Version bump |
|---|---|
| `feat:` | Minor (features) |
| `fix:` | Patch (bug fixes) |
| `feat!:` / `fix!:` / `refactor!:` | Major (breaking changes) |
| `build:`, `chore:`, `ci:`, `docs:`, `refactor:`, `style:`, `test:`, `perf:` | No bump (patch if `!`, hidden in changelog by default) |

## CI checks

Every PR and push to `main` runs the CI workflow (`.github/workflows/ci.yml`):

1. `npm run typecheck`
2. `npm test` (Bun test suite)
3. `npm run test:webui` (Vitest client tests)
4. `npm run build:webui`
5. `npm run pack:dry-run` — verifies package contents without publishing

All checks must pass before merging a PR.

## Release Please automation

The Release Please workflow (`.github/workflows/release-please.yml`) runs on every push to `main`:

- **Release PR**: Release Please opens or updates a PR tracking the next version. The PR body includes the generated changelog. The branch name is `release-please--branches--main`.
- **Release creation**: When the release PR is merged, Release Please creates a GitHub release, tags the version (e.g. `v0.1.3`), and sets the `release_created` output.
- **Publish job**: The `publish` job runs only when `release_created` is `true`. It publishes to npm with provenance.

## Trusted publishing (npm provenance)

This package uses **npm trusted publishing** instead of an `NPM_TOKEN` secret. Trusted publishing creates a trust relationship between the GitHub repository and the npm package so that GitHub Actions can obtain short-lived OIDC tokens for publishing — no long-lived token to rotate or leak.

### What was configured in this repo

- **Workflow permissions**: The `publish` job has `id-token: write` (required for OIDC token exchange) and `contents: read`.
- **Provenance flag**: `npm publish --provenance --access public` generates and attaches a signed build provenance attestation to the published package.
- **No NPM_TOKEN**: Trusted publishing does not use `NPM_TOKEN`. The `setup-node` action's `registry-url` is set, but authentication happens via the OIDC token exchanged at publish time.
- **Public access**: `package.json` declares `publishConfig.access: "public"` so the scoped package (`@rpollard00/pi-materia`) is published publicly.

### Required npm trusted publisher setup (manual, one-time)

Trusted publishing must also be enabled on the npm package side. A maintainer with publish access to `@rpollard00/pi-materia` on npm must configure the trust relationship:

1. Go to [npmjs.com/package/@rpollard00/pi-materia](https://www.npmjs.com/package/@rpollard00/pi-materia)
2. Navigate to **Settings → Access Control** (or **Settings → Trusted Publishers**)
3. Click **Add Trusted Publisher**
4. Fill in:
   - **Registry**: `https://registry.npmjs.org` (default)
   - **Owner (org or user)**: `rpollard00`
   - **Repository**: `pi-materia`
   - **Workflow**: `.github/workflows/release-please.yml`
   - **Environment** (optional): leave empty unless using deployment environments
5. Click **Add**

Once configured, the next release PR merge will publish automatically. No additional GitHub secrets are needed.

> **Note**: If the repository is later transferred, renamed, or the workflow file is renamed, the trusted publisher configuration in npm must be updated to match.

### Verifying provenance

After a successful publish, you can verify the provenance attestation:

```bash
npm view @rpollard00/pi-materia --json | jq '.provenance'
```

Or visit the package page on npmjs.com — published versions with provenance display a "Provenance" badge with a link to the signed attestation.

## Maintainer flow

1. Work on feature branches; use Conventional Commit titles for all commits.
2. Open a PR. CI must pass all checks.
3. Merge the PR to `main`.
4. Release Please opens or updates the release PR on `main`. Review the changelog and version bump in the PR.
5. When ready to release, merge the Release Please PR.
6. The publish job runs automatically. Confirm the package appears on npm with provenance.

## Troubleshooting

### Release Please PR not appearing

- Ensure the push is to `main`. Release Please only triggers on `workflow_dispatch` or pushes to `main`.
- Check the workflow run logs for errors. The `googleapis/release-please-action@v4` action must have `contents: write` and `pull-requests: write`.

### Publish job fails with 403 / E403

Likely causes:

- **Trusted publisher not configured**: Confirm the npm package has the trusted publisher record pointing to `rpollard00/pi-materia` with workflow `.github/workflows/release-please.yml`.
- **Workflow file moved or renamed**: Update the trusted publisher record on npm to match the new workflow path.
- **OIDC token not issued**: Ensure the `publish` job has `permissions: id-token: write`. Without this, GitHub Actions cannot exchange an OIDC token for an npm token.

### Publish job fails with 404

The package may not exist yet on npm. Run `npm publish --access public` manually the first time (or configure the trusted publisher on the package's settings page after creating it through the npm website).

### npm pack dry-run fails in CI

CI includes `npm run pack:dry-run` to catch packaging regressions. Make sure the `files` field in `package.json` covers all published content. Run `npm pack --dry-run` locally to debug.

### Provenance missing after publish

- Ensure the `publish` step uses the `--provenance` flag.
- Check that the npm package has trusted publishing configured (not an `NPM_TOKEN` fallback). Provenance is only generated with OIDC-based authentication.
