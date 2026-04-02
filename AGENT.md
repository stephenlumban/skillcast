# AGENT

Read this first when starting fresh in this repo.

## What Skillcast Is

Skillcast is a CLI and open format for reusable agent skill bundles.

Current package:

- `@stephenlumban/skillcast`

Repository:

- `git@github.com:stephenlumban/skillcast.git`

## Current Product Model

### Canonical Distribution Model

- Bundles are a platform/distribution concept.
- Built-in bundles are curated in `examples/bundles/catalog.json`.
- Built-in bundle source lives under `examples/bundles/`.
- The published package embeds built-ins into `packages/cli/dist/builtin/` during build.

### Repo Install Model

Default install should not vendor full bundles into a repo.

Installed repos should receive only:

```text
.skillcast/
  manifest.json
  skills/
    <skill-name>/
      SKILL.md
```

Important:

- `.skillcast/skills/<skill>/SKILL.md` is the repo-local installed runtime format.
- The repo should not depend on `.claude/skills`.
- Full bundle copies are not the default install model anymore.

## Main Commands

Implemented CLI commands:

- `skillcast list packs [path]`
- `skillcast list installed`
- `skillcast list skills <bundle-path-or-pack-name>`
- `skillcast validate <bundle-path-or-pack-name>`
- `skillcast inspect <bundle-path-or-pack-name>`
- `skillcast install <bundle-path-or-pack-name>`
- `skillcast init [path]`

## Important Files

Primary implementation:

- `packages/cli/src/index.ts`

Build pipeline:

- `packages/cli/scripts/build.mjs`

Smoke tests:

- `packages/cli/src/test/run-smoke-tests.ts`

Docs:

- `README.md`
- `MAINTAINING.md`
- `HANDOVER-v0.md`

Specs:

- `docs/spec/bundle-spec.md`
- `docs/spec/skill-spec.md`

## Build And Test

Run from repo root:

```bash
npm run build
npm run test
```

Manual check:

```bash
node packages/cli/dist/index.js list packs
node packages/cli/dist/index.js inspect repo-onboarding-pack
node packages/cli/dist/index.js install repo-onboarding-pack
node packages/cli/dist/index.js list installed
```

## Publishing Notes

Package version lives in:

- `packages/cli/package.json`

Workspace root is private:

- `package.json`

Publish command:

```bash
npm publish --workspace @stephenlumban/skillcast
```

Important:

- This environment previously published to `https://npm.pkg.github.com`, not necessarily npmjs.com.
- Check npm registry config before assuming the destination registry.

## Generated State

Do not treat generated install state as source files:

- `.skillcast/`
- package tarballs like `*.tgz`

## Current Design Decisions

These are intentional unless explicitly changed:

1. Skillcast bundle format is the canonical source format.
2. Built-in packs are curated through `catalog.json`.
3. Repo installs project only skills, not whole bundles.
4. Installed skill files use `SKILL.md`.
5. Bundle provenance lives in `.skillcast/manifest.json`.

## Good Next Work

Likely future branches:

- uninstall command
- upgrade/update flow for installed bundles
- richer catalog metadata and search
- optional runtime-specific exports
- remote registry/platform workflows
- stronger automated test coverage

## Working Style For Future Agents

- Read `AGENT.md`, `README.md`, and `HANDOVER-v0.md` first.
- Check `packages/cli/src/index.ts` before making assumptions about install behavior.
- Preserve the distinction between platform bundles and repo-installed skills.
- Prefer updating smoke tests when install/runtime behavior changes.
