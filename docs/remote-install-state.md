# Skillcast Remote Install State

This document defines how remote registry installs extend the current local lifecycle state.

It builds on:

- `docs/state-model.md` for current local install semantics
- `docs/registry-spec.md` for remote package identity, resolution, and publish rules

The goal is to add remote provenance without weakening current guarantees around manifest integrity, modification detection, collision handling, or reproducibility.

## Goals

- preserve the current local install/update/uninstall safety model
- record enough remote provenance to reproduce a previously resolved install
- distinguish what the user requested from what the registry actually resolved
- keep read-time migration practical from manifest version `2`
- avoid requiring remote access for local uninstall, diff, or repair

## Non-goals

- defining registry HTTP endpoints
- defining `skillcast login`
- changing installed file layout under `.skillcast/skills/`
- replacing the existing local manifest with a remote-only lockfile

## Current Baseline

Today each installed bundle entry stores:

- local bundle identity: `bundle`, `bundleVersion`
- source display data: `source`, `sourceType`
- timestamps: `installedAt`, `updatedAt`
- skill ownership and per-skill hashes

This is enough for local and built-in sources, but it is not enough for remote installs because it does not distinguish:

- requested reference vs exact resolved release
- remote package identity vs human-readable source string
- mutable selectors such as tags vs immutable release versions
- reproducible reinstall metadata vs display-only provenance

## Design Principle

Remote install state should be recorded at the bundle-entry level, not repeated independently on every skill record.

Per-skill records should continue to answer:

- what local file was installed
- what content hash was installed
- what bundle owns this skill locally

Bundle records should answer:

- what source the user asked for
- what remote package was resolved
- what exact release bytes were installed

## Manifest Evolution

Introduce manifest version `3` when remote provenance is added.

Version `3` should be a strict superset of version `2` for existing local installs.

Expected top-level shape:

```yaml
manifestVersion: 3
bundles:
  - bundle: repo-onboarding
    bundleVersion: 1.4.2
    source: skillcast:acme/repo-onboarding
    sourceType: registry
    installedSkills:
      - repo-map
    installedAt: 2026-03-31T09:00:00Z
    updatedAt: 2026-03-31T09:00:00Z
    skillDir: .skillcast/skills
    resolution:
      requestedRef: skillcast:acme/repo-onboarding
      mode: floating
      resolvedVersion: 1.4.2
      digest: sha256:...
      package:
        registry: registry.skillcast.dev
        namespace: acme
        name: repo-onboarding
      resolvedAt: 2026-03-31T09:00:00Z
    skills:
      - id: acme.repo.repo-map
        name: repo-map
        version: 1.4.2
        relativePath: .skillcast/skills/repo-map/SKILL.md
        fileHash: ...
        sourceHash: ...
        installedAt: 2026-03-31T09:00:00Z
        updatedAt: 2026-03-31T09:00:00Z
        ownership:
          bundle: repo-onboarding
          source: skillcast:acme/repo-onboarding
          sourceType: registry
```

## Source Type Evolution

Current source types are:

- `builtin`
- `path`

Add:

- `registry`

Rules:

- `source` remains a display-oriented value and may remain user-facing
- `sourceType` determines whether `resolution` is required
- `resolution` is required for `registry` entries
- `resolution` must be absent for `builtin` and `path` entries in v3 to keep semantics crisp

## Resolution Record

Add a `resolution` object on manifest bundle entries for remote installs.

Required fields:

- `requestedRef`: the exact remote reference the user asked for
- `mode`: one of `floating`, `tag`, `version`
- `resolvedVersion`: the exact immutable version that was installed
- `digest`: the immutable content digest returned by the registry
- `package.registry`: canonical registry host
- `package.namespace`: canonical namespace
- `package.name`: canonical bundle name
- `resolvedAt`: timestamp when the install resolved this release

Optional fields:

- `tag`: required when `mode` is `tag`
- `channel`: optional registry-defined release channel label if product later distinguishes channel from tag

Rules:

- `requestedRef` preserves user intent
- `resolvedVersion` and `digest` preserve reproducibility
- package identity must reflect canonical server response, not only client input
- a mutable selector such as `@stable` is never sufficient by itself for reinstall or repair decisions

## Why Bundle-Level Resolution Is Enough

The install pipeline already treats a bundle release as the source-of-truth unit for rendered installed skills.

Because of that:

- one remote resolution record can describe all skills installed from that bundle release
- per-skill remote fields would duplicate data and increase migration complexity
- local modification detection still belongs to per-skill `fileHash` and `sourceHash`

## Locking Strategy

Do not replace the repo-level `.skillcast.lock`.

Rules:

- remote installs still acquire the same local lock before mutating `.skillcast`
- network resolution and download may happen before taking the write lock, but the final write path must revalidate that the resolved release being written is the one recorded
- manifest writes remain atomic temp-file replacement

This keeps the current corruption-prevention model intact while allowing remote fetch work outside the critical section.

## Install Semantics For Remote Sources

A remote install should record both source intent and resolved provenance.

For `skillcast install skillcast:acme/repo-onboarding@stable`:

- `source` should remain `skillcast:acme/repo-onboarding@stable`
- `sourceType` should be `registry`
- `bundleVersion` should be the resolved exact version, for example `1.4.2`
- `resolution.mode` should be `tag`
- `resolution.tag` should be `stable`
- `resolution.resolvedVersion` should be `1.4.2`
- `resolution.digest` should be the immutable artifact digest

For exact-version installs:

- `bundleVersion` and `resolution.resolvedVersion` should match exactly
- reinstall does not need to consult tag or floating resolution behavior

## Update Semantics

Remote update behavior should compare against the recorded resolution metadata first.

Expected rules:

- `install --update <same floating ref>` may resolve to a newer exact version
- `install --update <same tag ref>` may resolve to a different exact version if the tag moved
- `install --update <exact version ref>` should normally be a no-op unless local files diverged or content digest verification fails
- current local modification checks still apply before overwriting files

When a remote update succeeds:

- `updatedAt` changes
- `bundleVersion` changes if a different exact version was resolved
- `resolution.resolvedVersion`, `resolution.digest`, and `resolution.resolvedAt` change to the new resolved release
- `installedAt` stays stable for the bundle lineage already installed locally

## Diff And Inspect Semantics

`diff` and `inspect --installed` need two comparison layers for remote bundles:

- local comparison against the installed manifest record
- optional remote comparison against the current resolution target

Minimum requirement for the first remote-capable implementation:

- if the exact resolved release is available locally or can be re-fetched, compare current bundle source to installed `sourceHash` as today
- surface the requested ref and exact resolved version in output

Future enhancement:

- distinguish "selector moved remotely" from "installed exact release differs from current local files"

## Repair Semantics

`repair` should stay conservative and local-first.

Rules:

- `repair` must not require network access
- `repair --write` may prune missing manifest-backed entries exactly as it does today
- `repair` must preserve `resolution` metadata for surviving entries unchanged
- `repair` must not attempt implicit re-download of missing remote content

This preserves the current design principle that `repair` fixes safe local state only.

## Uninstall Semantics

Uninstall does not need remote access.

Rules:

- bundle and skill uninstall behavior remains local-manifest-driven
- `resolution` metadata is removed only when its owning bundle entry is removed
- per-skill uninstall inside a remote-installed bundle keeps the same ambiguity tradeoff as today: the remaining bundle entry is still the local owner of the surviving installed skills

## Migration From Manifest v2

Migration should be read-time and additive, following the v1 to v2 pattern.

Rules:

- existing `builtin` and `path` entries migrate to v3 without `resolution`
- `bundleVersion`, timestamps, hashes, and ownership remain unchanged
- no synthetic remote metadata should be invented for legacy local installs

For early registry prototypes created before v3 is finalized:

- if `sourceType` is `registry` but `resolution` is missing, the manifest should be treated as incomplete and the CLI should fail with a repairable upgrade error rather than guessing

## Suggested Types

Suggested bundle-entry additions:

```ts
type RegistryResolution = {
  requestedRef: string;
  mode: "floating" | "tag" | "version";
  resolvedVersion: string;
  digest: string;
  package: {
    registry: string;
    namespace: string;
    name: string;
  };
  resolvedAt: string;
  tag?: string;
};
```

And:

```ts
type SourceType = "builtin" | "path" | "registry";
```

## Failure Cases To Preserve

The remote state model should not weaken existing safety checks.

Still reject or stop on:

- local file collision with unmanaged content unless `--force`
- overwrite of locally modified installed files unless `--force`
- manifest entries whose recorded remote digest does not match fetched content
- remote manifest entries missing required `resolution` metadata

## Open Questions

- whether the exact release artifact digest should also be duplicated into a future repo-level lockfile in addition to manifest storage
- whether `diff` should support a strict offline mode for previously remote-installed bundles that cannot be re-fetched
- whether partial uninstall from a remote bundle should eventually mark the bundle entry as locally diverged from the resolved release
