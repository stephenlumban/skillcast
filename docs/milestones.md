# Skillcast Milestones

## Completed Now

### Phase 1: Local Lifecycle

- `uninstall` implemented for bundles and individual skills
- `install --update` implemented with manifest-safe refresh behavior
- file hashing added for installed skill state and local change detection
- collision handling enforced for duplicate names and ownership conflicts

### Phase 2: Identity Model

- stable skill IDs are required and validated per bundle
- manifest schema evolved to version `2`
- manifest now tracks skill IDs, hashes, ownership, install timestamps, and update timestamps
- legacy manifest version `1` is migrated on read

### Phase 3: Developer Experience

- `diff <bundle>` added for source vs installed comparison
- `inspect <bundle> --installed` added for installed-state visibility
- `repair` added for missing/orphaned state inspection with safe manifest cleanup
- CLI output now surfaces warnings and explicit next-step guidance for update and collision flows
- lifecycle smoke tests cover install, uninstall, dry-run uninstall, uninstall-all, update, conflicts, collisions, diff behavior, repair, and legacy manifest migration

### Reliability hardening

- repo-level `.skillcast.lock` added around mutating lifecycle operations
- manifest writes now use atomic temp-file replacement
- lifecycle state model is documented in `docs/state-model.md`

## Next Milestones

### Phase 4: Registry Boundary Definition

- define the remote registry model in `docs/registry-spec.md`
- define manifest and lock evolution for remote provenance in `docs/remote-install-state.md`
- define the registry read/write API contract in `docs/registry-api.md`
- define the CLI implementation sequence in `docs/remote-cli-plan.md`
- define remote bundle identity as `registry host + namespace + bundle name`
- define source resolution and version pinning rules before any remote install implementation
- define publish authorization, visibility, and reproducibility expectations
- keep `skillcast login` out of scope until authenticated remote behavior exists

### Later Platform Work

- remote bundle sources implemented against the registry contract
- alias resolution beyond the current binary alias
- execution/runtime layer for running installed skills directly
- hosted registry and platform services

These remain future milestones because they require product and protocol decisions beyond the local lifecycle model that is now in place. The registry contract is the next prerequisite.
