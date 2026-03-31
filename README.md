# Skillcast

Skillcast is a CLI and open format for reusable agent skill bundles.

## v0 Commands

```bash
skillcast list packs [path]
skillcast list installed
skillcast list skills <bundle-path-or-pack-name>
skillcast validate <bundle-path-or-pack-name>
skillcast inspect <bundle-path-or-pack-name>
skillcast install <bundle-path-or-pack-name>
skillcast init [path]
```

Alias support is shipped through the same CLI binary:

```bash
cast list packs [path]
cast list installed
cast list skills <bundle-path-or-pack-name>
cast validate <bundle-path-or-pack-name>
cast inspect <bundle-path-or-pack-name>
cast install <bundle-path-or-pack-name>
```

## Project Layout

```text
packages/cli/                TypeScript CLI
examples/bundles/            Built-in pack catalog and example bundles
docs/spec/                   v0 bundle and skill specs
```

## Install Behavior

`skillcast install <pack>` now installs only the repo-local skills that the agent actually uses:

- `.skillcast/skills/<skill-name>/SKILL.md`
- `.skillcast/manifest.json`

Bundles remain a platform-level distribution concept. The repo stores installed skills plus manifest provenance, not vendored bundle source.

## Example Bundles

- `pr-review-pack`: minimal v0 example from the original handover
- `repo-onboarding-pack`: repo mapping, architecture, setup, conventions, and change impact
- `pr-workflow-pack`: review, summary, commit message, review fixes, and risk scan
- `debug-triage-pack`: bug triage, log analysis, failing test diagnosis, repro planning, and fix verification

Research notes for why these packs were chosen live in `docs/pack-research.md`.
The curated built-in pack catalog lives in `examples/bundles/catalog.json`.

## Local Demo

```bash
npm install
npm run build
npm run test
node packages/cli/dist/index.js list packs
node packages/cli/dist/index.js inspect repo-onboarding-pack
node packages/cli/dist/index.js install pr-workflow-pack
node packages/cli/dist/index.js list installed
```
