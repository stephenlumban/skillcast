# Maintaining Skillcast

This guide covers the normal workflow for adding a feature, testing it, committing it, and publishing the CLI package.

## Project Model

- Skillcast bundles are a platform/distribution concept.
- Repo installs project usable skills into `.skillcast/skills/<skill>/SKILL.md`.
- Published package name: `@stephenlumban/skillcast`.

## Add A Feature

1. Create or update code in [packages/cli/src/index.ts](C:/Users/Admin/Documents/skillcast/packages/cli/src/index.ts) or related package files.
2. If the feature affects built-in packs, update:
   - [examples/bundles/catalog.json](C:/Users/Admin/Documents/skillcast/examples/bundles/catalog.json)
   - relevant bundle files under [examples/bundles](C:/Users/Admin/Documents/skillcast/examples/bundles)
3. If behavior changes, update:
   - [README.md](C:/Users/Admin/Documents/skillcast/README.md)
   - [packages/cli/README.md](C:/Users/Admin/Documents/skillcast/packages/cli/README.md) if publish/install docs change
4. If the change affects install/runtime behavior, update the smoke tests in [packages/cli/src/test/run-smoke-tests.ts](C:/Users/Admin/Documents/skillcast/packages/cli/src/test/run-smoke-tests.ts).

## Build And Test

Run these from the repo root:

```bash
npm install
npm run build
npm run test
```

What they do:

- `npm run build`: compiles the CLI and packages built-in bundles into `packages/cli/dist/builtin`
- `npm run test`: runs smoke tests against the built output

## Quick Manual Test

From the repo root:

```bash
node packages/cli/dist/index.js list packs
node packages/cli/dist/index.js inspect repo-onboarding-pack
node packages/cli/dist/index.js install repo-onboarding-pack
node packages/cli/dist/index.js list installed
```

Expected result after install:

```text
.skillcast/
  manifest.json
  skills/
    repo-map/
      SKILL.md
    architecture-explainer/
      SKILL.md
    local-dev-setup-check/
      SKILL.md
    conventions-finder/
      SKILL.md
    change-impact-scan/
      SKILL.md
```

## Commit Changes

From the repo root:

```bash
git status
git add .
git commit -m "Describe the change"
```

Use a commit message that reflects the actual user-visible change. Examples:

- `Add uninstall command for installed skills`
- `Bundle built-in packs in published CLI`
- `Project installed skills into .skillcast/skills`

## Push To GitHub

The repo remote is:

```bash
git@github.com:stephenlumban/skillcast.git
```

Push the current branch:

```bash
git push -u origin main
```

## Publish The Package

Package:

```bash
@stephenlumban/skillcast
```

Before publishing:

1. make sure `npm run build` and `npm run test` both pass
2. bump the package version
3. publish from the workspace

Commands:

```bash
npm version patch --workspace @stephenlumban/skillcast
npm publish --workspace @stephenlumban/skillcast
```

If the change is larger, use `minor` instead of `patch`.

## Verify Published Package

Install globally:

```bash
npm install -g @stephenlumban/skillcast
```

Then test:

```bash
skillcast --version
skillcast list packs
skillcast inspect repo-onboarding-pack
skillcast install repo-onboarding-pack
skillcast list installed
```

## Notes

- Built-in packs are bundled into the published CLI during the build step.
- If install behavior changes, republish the package before testing the global binary.
- `.skillcast/` is repo-local generated state and should not be committed.
