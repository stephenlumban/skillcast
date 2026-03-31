# Changelog

## Unreleased

### Local lifecycle

- added `skillcast uninstall <bundle-or-skill>` for bundle and single-skill removal
- added `skillcast uninstall --all` to remove all installed bundles and clean `.skillcast/`
- added `skillcast uninstall --dry-run` to preview removals without mutating files or manifest state
- added `skillcast install <bundle> --update` with overwrite protection for locally modified files
- added file hashing for installed skills so update, diff, and uninstall can detect local edits
- added collision handling for duplicate skill ownership, with explicit overwrite through `--force`
- evolved the manifest to version `2` with stable skill IDs, ownership, hashes, install timestamps, and update timestamps
- added manifest v1 read-time migration for backward compatibility

### CLI UX

- added `skillcast diff <bundle>` to compare source bundles against installed state
- added `skillcast inspect <bundle> --installed` to show installed-state changes during inspection
- added `cast list skills -i` and `cast list skills --installed` to list repo-local installed skills
- added `skillcast repair` to report missing and orphaned install state, with `--write` for safe manifest cleanup
- reduced default CLI output noise; detailed filesystem paths and metadata now require `--verbose` in list/install flows
- improved error messages for ambiguous or incomplete commands such as `list skills`

### Fixes

- fixed linked `skillcast` and `cast` execution on Windows by resolving real entrypoint paths instead of comparing only raw argv paths
- fixed empty-manifest cleanup so repos do not retain stale `.skillcast` files after full uninstall
- added repo-level `.skillcast.lock` usage and atomic manifest temp-file writes to reduce concurrent mutation corruption

### Tests

- expanded smoke coverage for install, uninstall, uninstall-all, update, local modification conflicts, collisions, diff behavior, installed-skill listing, and manifest migration
