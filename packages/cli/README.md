# Skillcast CLI

Skillcast is a CLI and open format for reusable agent skill bundles.

## Install

```bash
npm install -g @stephenlumban/skillcast
```

## Commands

```bash
skillcast list packs
skillcast list packs --verbose
skillcast list installed --verbose
skillcast list skills repo-onboarding-pack
skillcast list skills -i
skillcast inspect repo-onboarding-pack --installed
skillcast diff repo-onboarding-pack
skillcast install pr-workflow-pack
skillcast install pr-workflow-pack --update --verbose
skillcast uninstall pr-workflow-pack --dry-run
skillcast uninstall pr-workflow-pack
skillcast uninstall --all
skillcast repair
```

The CLI now supports the full local lifecycle:

- safe uninstall for bundles and individual skills
- `uninstall --all` to clear all installs and remove `.skillcast`
- update with `--update`, conflict detection, and explicit `--force`
- `uninstall --dry-run` and `repair` for safer lifecycle maintenance
- concise default output with `--verbose` for detailed fields
- manifest version `2` with stable skill IDs, hashes, ownership, and timestamps
- source vs installed comparison with `diff`

## Repository

[github.com/stephenlumban/skillcast](https://github.com/stephenlumban/skillcast)
