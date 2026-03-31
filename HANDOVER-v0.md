# Skillcast v0 Handover

This document summarizes the current state of Skillcast after the initial v0 implementation and follow-up packaging/runtime changes.

## What Was Built

Skillcast now ships as a publishable CLI package:

- package name: `@stephenlumban/skillcast`
- repository: `git@github.com:stephenlumban/skillcast.git`

Core CLI commands implemented:

- `skillcast list packs [path]`
- `skillcast list installed`
- `skillcast list skills <bundle-path-or-pack-name>`
- `skillcast validate <bundle-path-or-pack-name>`
- `skillcast inspect <bundle-path-or-pack-name>`
- `skillcast install <bundle-path-or-pack-name>`
- `skillcast init [path]`

## Current Product Model

### Canonical Source

Bundles remain the platform/distribution concept.

Built-in bundles live in:

- `examples/bundles/`
- `examples/bundles/catalog.json`

The published package also embeds the curated built-ins into:

- `packages/cli/dist/builtin/`

### Repo Install Model

Default install no longer vendors whole bundles into the repo.

Installed repos now receive:

```text
.skillcast/
  manifest.json
  skills/
    <skill-name>/
      SKILL.md
```

This means:

- repos store only the skills they actually use
- bundle provenance is tracked in the manifest
- `SKILL.md` naming/structure is followed inside `.skillcast`
- there is no longer a default `.claude/skills` projection
- there is no longer a default `.skillcast/bundles` copy of the full bundle

## Manifest Model

Manifest entries now record:

- `bundle`
- `bundleVersion`
- `source`
- `sourceType`
- `installedSkills`
- `installedAt`
- `skillDir`

That allows Skillcast to preserve platform-level provenance without copying the whole bundle into each repo.

## Bundles Added

Curated built-in packs:

- `repo-onboarding-pack`
- `pr-workflow-pack`
- `debug-triage-pack`
- `pr-review-pack`

Non-curated scaffold/example:

- `sample-pack`

Research note for pack selection:

- `docs/pack-research.md`

## Important Files

Main CLI implementation:

- `packages/cli/src/index.ts`

Build pipeline for published package:

- `packages/cli/scripts/build.mjs`

Smoke tests:

- `packages/cli/src/test/run-smoke-tests.ts`

Package docs:

- `README.md`
- `packages/cli/README.md`
- `MAINTAINING.md`

Specs:

- `docs/spec/bundle-spec.md`
- `docs/spec/skill-spec.md`

## Publishing Notes

Build and tests:

```bash
npm run build
npm run test
```

Publish workflow:

```bash
npm version patch --workspace @stephenlumban/skillcast
npm publish --workspace @stephenlumban/skillcast
```

Push repo:

```bash
git push -u origin main
```

## Verified Behavior

The following have been verified locally during this implementation:

- build succeeds
- smoke tests pass
- built-in packs are listed from packaged catalog
- built-in pack inspection works
- install projects skills into `.skillcast/skills/<skill>/SKILL.md`
- installed bundle provenance appears in `.skillcast/manifest.json`
- `npm pack` produces a tarball with built-in bundle assets included

## Design Decisions Finalized

1. Skillcast bundle format remains the canonical source format.
2. Built-in packs are curated via `catalog.json`.
3. Repos install only skills, not full vendored bundles, by default.
4. Installed skill files follow `SKILL.md` naming.
5. Bundle provenance is retained in manifest rather than by copying bundle source.

## Good Next Branches

Useful next work for new branches:

- `uninstall` command for removing installed skills and updating manifest
- update/install upgrade flow for already-installed bundles
- runtime-specific exports as optional commands instead of default install behavior
- richer metadata in catalog and inspect output
- remote registry/platform flows
- filtering/searching packs by tags/category
- tests beyond smoke coverage

## Recommended Branching Approach

Keep `main` as the stable v0 baseline.

Start new work in focused branches such as:

- `feature/uninstall`
- `feature/registry`
- `feature/runtime-exports`
- `feature/catalog-search`
