# Skillcast Registry Spec v0

This document defines the platform-facing distribution contract for Skillcast bundles.

It is intentionally spec-first. It defines identity, resolution, publishing, visibility, and reproducibility rules before any authenticated remote CLI flows are introduced.

## Goals

- make remote bundle installs resolvable without changing the local lifecycle model
- define what makes two remote bundles the same package across versions and registries
- preserve stable skill identity across publish, install, update, and rollback
- support reproducible installs for both public and authenticated sources
- keep authentication outside local-only commands until remote behavior exists

## Non-goals

- defining `skillcast login` UX
- defining hosted web product behavior beyond registry API boundaries
- changing local manifest ownership or local collision rules
- defining runtime execution or platform-side skill invocation

## Terms

- registry: a remote source of published Skillcast bundles
- publisher: the actor allowed to publish new versions for a bundle package
- bundle package: the remote package lineage that owns a sequence of published bundle versions
- bundle release: one immutable published bundle package version
- source reference: the user-facing bundle locator passed to install or inspect flows
- resolved release: the exact bundle package version selected after source resolution

## Remote Bundle Reference Syntax

Skillcast should distinguish explicit remote references from local paths.

Supported v0 source reference forms:

- `skillcast:<namespace>/<bundle>`
- `skillcast:<namespace>/<bundle>@<version>`
- `skillcast:<namespace>/<bundle>@<tag>`
- `skillcast://<registry-host>/<namespace>/<bundle>`
- `skillcast://<registry-host>/<namespace>/<bundle>@<version>`

Examples:

- `skillcast:acme/repo-onboarding`
- `skillcast:acme/repo-onboarding@1.4.2`
- `skillcast:acme/repo-onboarding@stable`
- `skillcast://registry.skillcast.dev/acme/repo-onboarding`
- `skillcast://registry.internal.acme.local/platform/repo-onboarding@2.0.0`

Rules:

- plain filesystem paths remain local bundle references
- bare names such as `repo-onboarding-pack` may continue to resolve through the local built-in catalog, not the registry
- `skillcast:` uses the default configured registry host
- `skillcast://` bypasses the default host and targets an explicit registry
- a remote reference must identify exactly one bundle package lineage before version resolution runs

## Package Identity

A remote bundle package is identified by the tuple:

- `registry host`
- `namespace`
- `bundle name`

This tuple is the canonical remote identity for "same bundle."

Implications:

- the same `namespace/bundle` on two registry hosts is not the same bundle package
- renaming `namespace` or `bundle name` creates a new bundle package identity
- transferring package ownership does not change bundle identity if the registry preserves the same tuple

Registry records should expose a stable machine identifier, but CLI and lockfile semantics should treat the tuple above as the interoperable identity surface.

## Skill Identity Within Remote Bundles

Remote publication does not redefine skill identity.

The canonical identity for "same skill" remains `skill.id`, as already established by the local lifecycle model.

Rules:

- a published bundle release may change skill contents without changing `skill.id`
- removing a skill from a later bundle release does not delete the historical identity of that skill in earlier releases
- changing a skill's `name` does not change its identity
- introducing a different behavior under an existing `skill.id` is allowed only as a versioned evolution of the same skill lineage
- publishing two different skills with the same `skill.id` in one bundle release is invalid

## Source Resolution Rules

Resolution should happen in this order:

1. If the input is an existing local path, treat it as a local bundle.
2. If the input matches a configured local catalog alias, resolve it locally.
3. If the input uses `skillcast:` or `skillcast://`, treat it as a remote bundle reference.
4. Do not silently reinterpret unresolved local aliases as remote packages.

For remote resolution:

1. Determine registry host from the reference.
2. Resolve the bundle package by `namespace` and `bundle name`.
3. Resolve version selector:
   - no selector means the package's default release channel, initially `latest`
   - exact semver selects that immutable release
   - tag selects the registry-managed tag pointer
4. Retrieve immutable release metadata and content digest.
5. Materialize the resolved bundle as the source input to the existing local install pipeline.

Resolution failures should be explicit:

- package not found
- version not found
- tag not found
- access denied
- digest mismatch

## Version Pinning Rules

The v0 contract should support three resolution modes:

- floating: `skillcast:acme/repo-onboarding`
- tag-pinned: `skillcast:acme/repo-onboarding@stable`
- version-pinned: `skillcast:acme/repo-onboarding@1.4.2`

Rules:

- bundle releases use semver-compatible version strings
- published versions are immutable once visible to any client
- tags are mutable pointers maintained by the registry
- only exact versions are considered reproducible without extra lock metadata
- floating and tag-based installs must record the exact resolved version and digest into local install state

Expected lock behavior:

- install state should store the originally requested remote reference
- install state should also store the resolved package identity, exact version, and content digest
- reinstall or repair should prefer the exact resolved release when reproducibility is required

## Publish Contract

Publishing creates a new immutable bundle release under an existing or newly created bundle package.

A publish request must provide:

- target registry host
- target `namespace`
- target `bundle name`
- bundle version
- bundle manifest and skill contents
- content digest for the upload payload
- publisher credentials when required by the registry

A registry must reject publish when:

- the publisher is not authorized for the target package
- the version already exists
- the uploaded bundle is invalid
- the declared digest does not match uploaded bytes
- two skills in the release collide on `skill.id`

A successful publish must return release metadata that includes:

- canonical package identity
- exact published version
- immutable release digest
- publish timestamp
- visibility level

## Ownership Semantics

Ownership for remote publish authorization is package-scoped, not skill-scoped.

Rules:

- one bundle package has one authoritative publisher set at a time
- a publisher may be an individual user, an organization, or a service principal
- skill IDs inside a bundle do not independently grant publish rights
- moving a skill between bundle packages is a breaking ownership event and should be treated as a new package lineage unless product policy later defines an explicit transfer protocol

This keeps remote authorization simpler than any future multi-owner local uninstall model.

## Auth Boundary

Authentication is required only for remote registry operations that need identity.

Authenticated operations:

- publish
- install or inspect from private or org-scoped packages
- tag management
- package visibility changes

Unauthenticated operations:

- local bundle validation
- local install, diff, uninstall, and repair
- install or inspect from public packages, if the registry permits anonymous reads

`skillcast login` stays out of scope until the CLI actually performs authenticated remote operations against a concrete registry contract.

## Visibility Model

Each bundle package has one visibility mode:

- public: discoverable and readable by anyone
- private: readable only by explicitly authorized principals
- org: readable by members of a specific organization or workspace boundary

Rules:

- visibility is package-level, not per-release
- changing visibility does not change package identity
- registries may allow stricter publish permissions than read permissions
- public metadata and public artifact downloadability should move together by default to avoid split-brain access semantics

## Reproducibility And Rollback

The registry contract must support deterministic reinstall of an already resolved release.

Requirements:

- every published release is immutable
- every release exposes a content digest
- registries must allow fetching an exact version by package identity and version
- clients must record exact resolved version and digest after non-exact installs

Rollback expectations:

- rolling back means installing a previously published exact version
- registries do not mutate or overwrite old versions to implement rollback
- mutable tags may be moved back to older versions, but that is not a substitute for exact-version reproducibility

If a release is yanked for policy reasons, the registry may hide it from default discovery while still preserving integrity of already locked installs according to registry retention policy.

## Minimal Remote Metadata Shape

Remote release metadata should be sufficient to drive install, inspect, and future lockfile evolution.

Suggested minimum fields:

```yaml
registry: registry.skillcast.dev
namespace: acme
bundle: repo-onboarding
version: 1.4.2
digest: sha256:...
visibility: public
publishedAt: 2026-03-31T08:00:00Z
skills:
  - id: acme.repo.code-review
    name: code-review
    version: 1.4.2
```

The exact transport format can vary, but these semantics should not.

## CLI Consequences

This spec implies future commands may add remote-capable inputs without changing local lifecycle semantics:

- `skillcast install skillcast:acme/repo-onboarding`
- `skillcast inspect skillcast:acme/repo-onboarding@1.4.2`
- `skillcast publish`

It does not imply that those commands should be implemented yet.

Implementation order should be:

1. finalize registry read/write contract
2. extend install state to persist resolved remote provenance
3. add remote install and inspect
4. add publish
5. add authentication UX such as `skillcast login` only when needed by real remote flows

## Open Questions

- whether the default public registry should reserve global namespaces or support first-publish creation
- whether tags such as `latest` and `stable` are system-managed, publisher-managed, or both
- whether org visibility maps to one organization type or multiple workspace concepts
- what retention guarantees apply to yanked private releases needed for locked reinstall
