# Changelog

## Unreleased

### Docs

- added `docs/registry-spec.md` to define the spec-first registry, publish, visibility, auth, and reproducibility contract for future platform work
- added `docs/remote-install-state.md` to define how remote installs extend manifest state and reproducibility without weakening the local lifecycle model
- added `docs/registry-api.md` to define the minimal registry API contract for resolution, metadata, artifact download, publish, tags, and visibility
- added `docs/remote-cli-plan.md` to define the phased CLI implementation sequence for manifest v3, parsing, remote inspect, and remote install
- clarified milestone sequencing so registry definition comes before remote commands or `skillcast login`

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
- added `skillcast publish` and `skillcast unpublish` for direct S3-backed bundle store management
- reduced default CLI output noise; detailed filesystem paths and metadata now require `--verbose` in list/install flows
- improved error messages for ambiguous or incomplete commands such as `list skills`

### Authoring

- documented the human authoring flow in `README.md`: create a bundle, validate it locally, publish it to S3, and unpublish exact versions when needed

### Fixes

- fixed linked `skillcast` and `cast` execution on Windows by resolving real entrypoint paths instead of comparing only raw argv paths
- fixed empty-manifest cleanup so repos do not retain stale `.skillcast` files after full uninstall
- added repo-level `.skillcast.lock` usage and atomic manifest temp-file writes to reduce concurrent mutation corruption

### Tests

- expanded smoke coverage for install, uninstall, uninstall-all, update, local modification conflicts, collisions, diff behavior, installed-skill listing, and manifest migration
