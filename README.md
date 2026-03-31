# Skillcast

Skillcast is a CLI and open format for reusable agent skill bundles.

## v0 Commands

```bash
skillcast list packs [path] [--verbose]
skillcast list installed [--verbose]
skillcast list skills <bundle-path-or-pack-name>
skillcast list skills -i
skillcast validate <bundle-path-or-pack-name>
skillcast inspect <bundle-path-or-pack-name> [--installed]
skillcast diff <bundle-path-or-pack-name>
skillcast install <bundle-path-or-pack-name> [--update] [--force] [--dry-run] [--verbose]
skillcast uninstall <bundle-or-skill>
skillcast uninstall <bundle-or-skill> --dry-run
skillcast uninstall --all
skillcast repair [--write]
skillcast init [path]
```

Alias support is shipped through the same CLI binary:

```bash
cast list packs [path] [--verbose]
cast list installed [--verbose]
cast list skills <bundle-path-or-pack-name>
cast list skills -i
cast validate <bundle-path-or-pack-name>
cast inspect <bundle-path-or-pack-name> [--installed]
cast diff <bundle-path-or-pack-name>
cast install <bundle-path-or-pack-name> [--update] [--force] [--dry-run] [--verbose]
cast uninstall <bundle-or-skill>
cast uninstall <bundle-or-skill> --dry-run
cast uninstall --all
cast repair [--write]
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

The local lifecycle is now versioned and safe to evolve:

- `skillcast uninstall <bundle-or-skill>` removes installed skills without deleting outside `.skillcast/skills`
- `skillcast uninstall --all` removes all installed bundles and cleans `.skillcast/`
- `skillcast install <bundle> --update` refreshes existing installs
- repo-level locking and atomic manifest writes reduce concurrent mutation risk
- `skillcast repair` reports missing and orphaned install state and can safely prune missing manifest entries with `--write`
- manifest version `2` stores stable skill IDs, ownership, hashes, install timestamps, and update timestamps
- update and uninstall flows detect locally modified installed files
- collisions warn by default and require `--force` for explicit overwrite paths

## Platform Boundary

The next phase is registry and publish-contract definition, not new platform commands.

- remote distribution semantics are defined in `docs/registry-spec.md`
- remote provenance and manifest evolution are defined in `docs/remote-install-state.md`
- registry read/write transport expectations are defined in `docs/registry-api.md`
- CLI sequencing for remote work is defined in `docs/remote-cli-plan.md`
- local lifecycle safety remains the baseline for any future remote install flow
- `skillcast login` stays out of scope until authenticated remote registry behavior actually exists

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
node packages/cli/dist/index.js diff pr-workflow-pack
node packages/cli/dist/index.js list installed
```

See [Lifecycle Milestones](./docs/milestones.md) for the current implementation boundary and [Registry Spec](./docs/registry-spec.md) for the next platform-facing contract.
