# pi-materia

A Pi extension for configurable, materia-themed agent pipelines.

## Running from another project

During development, run this extension against a target repository without copying it into that repository:

```bash
cd /path/to/target-project
pi -e /path/to/pi-materia/src/index.ts
```

Then start a cast:

```text
/materia run implement the next small feature
```

## Configuration

pi-materia resolves its loadout/config in this order:

1. `--materia-config /path/to/config.json`
2. `MATERIA_CONFIG=/path/to/config.json`
3. target project `.pi/pi-materia.json`
4. bundled default loadout at `config/default.json`

Example:

```bash
pi -e /path/to/pi-materia/src/index.ts --materia-config ./my-loadout.json
```

Runtime artifacts are written to `.pi/pi-materia/<timestamp>/` by default. Override with:

```json
{
  "artifactDir": ".pi/my-materia-runs"
}
```

## Publishing to npm

One-time setup:

```bash
npm adduser
```

Before publishing:

```bash
npm run typecheck
npm run pack:dry-run
```

Publish the package:

```bash
npm publish --access public
```

After publishing, users can install it in Pi with:

```bash
pi install npm:@rpollard00/pi-materia
```

Or test without installing permanently:

```bash
pi -e npm:@rpollard00/pi-materia
```

For future releases, bump the version first:

```bash
npm version patch
npm publish --access public
```

