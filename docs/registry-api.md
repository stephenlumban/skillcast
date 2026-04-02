# Skillcast Registry API

This document defines the minimal remote API surface needed to support the registry model in `docs/registry-spec.md` and the local provenance model in `docs/remote-install-state.md`.

It is transport-oriented, not product-UI-oriented. The goal is to define the read and write contract the CLI depends on before implementing remote commands.

## Goals

- define the minimal API needed for remote install, inspect, and publish
- keep responses aligned with canonical package identity and exact release provenance
- support anonymous reads for public packages and authenticated access for protected operations
- keep artifact integrity and version immutability first-class

## Non-goals

- defining exact HTTP paths for every hosting product
- defining web console UX
- defining token issuance or `skillcast login`
- defining registry-side search or recommendation systems

## Principles

- package identity is `registry host + namespace + bundle name`
- exact versions are immutable
- tags are mutable pointers
- clients must be able to resolve a selector to an exact version plus digest
- clients must be able to fetch release content by exact identity

## Objects

### Package

Represents the bundle package lineage.

Minimum fields:

```yaml
registry: registry.skillcast.dev
namespace: acme
name: repo-onboarding
visibility: public
defaultTag: latest
```

### Release

Represents one immutable published version.

Minimum fields:

```yaml
registry: registry.skillcast.dev
namespace: acme
name: repo-onboarding
version: 1.4.2
digest: sha256:...
visibility: public
publishedAt: 2026-03-31T08:00:00Z
artifactUrl: https://registry.skillcast.dev/v0/artifacts/sha256:...
skills:
  - id: acme.repo.repo-map
    name: repo-map
    version: 1.4.2
```

### Resolution

Represents the result of turning a client selector into an exact release.

Minimum fields:

```yaml
requestedRef: skillcast:acme/repo-onboarding@stable
mode: tag
tag: stable
package:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
resolvedVersion: 1.4.2
digest: sha256:...
publishedAt: 2026-03-31T08:00:00Z
artifactUrl: https://registry.skillcast.dev/v0/artifacts/sha256:...
```

## Read API

### 1. Get Package Metadata

Purpose:

- confirm the package exists
- return canonical identity and visibility metadata
- expose package-level defaults such as default tag

Logical request:

- input: `registry`, `namespace`, `name`

Logical response:

```yaml
package:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
  visibility: public
  defaultTag: latest
```

Errors:

- `not_found`
- `access_denied`

### 2. Resolve Selector To Exact Release

Purpose:

- support floating, tag, and exact-version installs
- return enough data for manifest `resolution` state

Logical request:

```yaml
package:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
selector:
  mode: tag
  value: stable
```

Logical response:

```yaml
resolution:
  requestedRef: skillcast:acme/repo-onboarding@stable
  mode: tag
  tag: stable
  package:
    registry: registry.skillcast.dev
    namespace: acme
    name: repo-onboarding
  resolvedVersion: 1.4.2
  digest: sha256:abc123
  publishedAt: 2026-03-31T08:00:00Z
  artifactUrl: https://registry.skillcast.dev/v0/artifacts/sha256:abc123
```

Rules:

- exact-version selectors still return a full resolution object
- `digest` must correspond to the release artifact bytes
- the registry must not resolve to a hidden mutable internal revision of the same version

Errors:

- `not_found`
- `version_not_found`
- `tag_not_found`
- `access_denied`

### 3. Get Release Metadata By Exact Version

Purpose:

- allow inspect, reproducible reinstall, and rollback by exact version

Logical request:

- input: `registry`, `namespace`, `name`, `version`

Logical response:

```yaml
release:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
  version: 1.4.2
  digest: sha256:abc123
  visibility: public
  publishedAt: 2026-03-31T08:00:00Z
  artifactUrl: https://registry.skillcast.dev/v0/artifacts/sha256:abc123
  skills:
    - id: acme.repo.repo-map
      name: repo-map
      version: 1.4.2
```

Errors:

- `not_found`
- `version_not_found`
- `access_denied`

### 4. Download Release Artifact

Purpose:

- retrieve the immutable bundle content the CLI will validate and materialize

Logical request:

- input: exact artifact URL or exact package identity plus exact version

Logical response:

- raw bundle artifact bytes

Headers or equivalent metadata should include:

- content digest
- content length
- content type

Rules:

- the downloaded bytes must match the digest returned by resolution or release metadata
- artifact downloads by digest are preferred because they align directly with reproducibility
- registries may use signed URLs or redirect flows as long as the client still validates digest locally

Errors:

- `not_found`
- `access_denied`
- `digest_mismatch`

## Write API

### 5. Publish Release

Purpose:

- create a new immutable release for a bundle package

Logical request:

```yaml
package:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
release:
  version: 1.5.0
  digest: sha256:def456
visibility: public
artifact:
  upload: <bundle bytes or upload handle>
```

Logical response:

```yaml
release:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
  version: 1.5.0
  digest: sha256:def456
  visibility: public
  publishedAt: 2026-03-31T09:30:00Z
  artifactUrl: https://registry.skillcast.dev/v0/artifacts/sha256:def456
```

Rules:

- publish is authenticated
- the registry validates bundle structure and `skill.id` uniqueness before finalizing the release
- the registry must reject attempts to overwrite an existing version
- once acknowledged, release metadata must remain stable

Errors:

- `access_denied`
- `version_exists`
- `invalid_bundle`
- `digest_mismatch`
- `validation_failed`

### 6. Manage Tags

Purpose:

- move mutable selectors such as `latest` or `stable`

Logical request:

```yaml
package:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
tag:
  name: stable
  targetVersion: 1.5.0
```

Logical response:

```yaml
tag:
  name: stable
  targetVersion: 1.5.0
  updatedAt: 2026-03-31T09:31:00Z
```

Rules:

- tag updates are authenticated
- tag names are package-scoped
- moving a tag does not mutate any release object

Errors:

- `access_denied`
- `version_not_found`
- `validation_failed`

### 7. Update Visibility

Purpose:

- change package read scope without changing package identity

Logical request:

```yaml
package:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
visibility: org
```

Logical response:

```yaml
package:
  registry: registry.skillcast.dev
  namespace: acme
  name: repo-onboarding
  visibility: org
```

Rules:

- visibility updates are authenticated
- visibility is package-scoped, not release-scoped
- registries may enforce policy restrictions on transitions such as `public` to `private`

Errors:

- `access_denied`
- `validation_failed`

## Authentication Boundary

Authenticated operations:

- publish release
- manage tags
- update visibility
- read protected package metadata, release metadata, resolution data, or artifacts

Unauthenticated operations:

- public package metadata
- public selector resolution
- public release metadata
- public artifact download

This API document intentionally leaves token acquisition and session UX out of scope.

## Artifact Format Contract

The registry does not change the bundle format itself.

Rules:

- release artifacts must expand to a valid Skillcast bundle as defined by `docs/spec/bundle-spec.md`
- the CLI validates the expanded bundle after download, just as it validates local bundles
- digest verification happens before install state is written

This keeps remote distribution separate from bundle authoring rules.

## Error Model

The transport can choose status codes or equivalent, but the logical errors should map cleanly to CLI behavior.

Suggested logical error codes:

- `not_found`
- `version_not_found`
- `tag_not_found`
- `access_denied`
- `version_exists`
- `invalid_bundle`
- `validation_failed`
- `digest_mismatch`
- `rate_limited`
- `temporary_unavailable`

CLI implications:

- `not_found`, `version_not_found`, and `tag_not_found` should produce precise user-facing resolution errors
- `access_denied` should not imply login UX unless an authenticated flow actually exists
- `temporary_unavailable` and `rate_limited` should be retryable
- `digest_mismatch` is a hard integrity failure

## Minimal CLI Mapping

The first remote-capable CLI iteration should map onto the API like this:

1. Parse `skillcast:` or `skillcast://` reference.
2. Resolve selector to exact release.
3. Download artifact and verify digest.
4. Validate bundle contents locally.
5. Install through the existing lifecycle pipeline.
6. Persist manifest v3 `resolution` metadata.

For exact-version reinstall:

1. Read `resolution.package`, `resolution.resolvedVersion`, and `resolution.digest` from manifest.
2. Fetch exact release metadata or artifact.
3. Refuse to continue if returned digest differs.

## Open Questions

- whether artifact downloads should be exclusively by digest URL or also by version URL
- whether the registry should expose a separate lightweight endpoint for tag lookup versus full selector resolution
- whether package creation is implicit on first successful publish or requires an explicit create operation
