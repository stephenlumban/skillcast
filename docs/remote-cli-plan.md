# Skillcast Remote CLI Plan

This document translates the registry, manifest, and API specs into an implementation sequence for the current CLI codebase.

It is intentionally incremental. The goal is to add remote support without destabilizing the existing local lifecycle behavior already shipped in `0.1.3`.

## Goals

- add remote-capable `inspect` and `install` without regressing local workflows
- evolve the manifest to record remote provenance safely
- isolate remote resolution and fetch logic from local lifecycle mutation logic
- keep `login` and other auth UX out of scope until authenticated operations are implemented

## Current Constraints

Current implementation facts in `packages/cli/src/index.ts`:

- `SourceType` is only `builtin | path`
- `resolveBundleReference()` only resolves built-in catalog names and filesystem paths
- `installBundle()`, `inspectBundle()`, and `diffBundle()` all depend directly on local bundle roots
- manifest handling is embedded in the same file and currently writes version `2`
- lifecycle mutation, rendering, and manifest persistence are tightly coupled

This means remote support should not start by bolting fetch logic directly into existing command handlers. That would make the lifecycle path harder to reason about and harder to test.

## Phase Order

Implementation should happen in this order:

1. extract source resolution and manifest typing seams
2. add manifest v3 support for remote provenance
3. add remote reference parsing and resolution types
4. add remote artifact fetch and local bundle materialization
5. enable remote `inspect`
6. enable remote `install`
7. add publish later
8. add auth UX only when authenticated flows exist

## Phase 1: Create Internal Seams

Before adding behavior, create internal boundaries inside `packages/cli/src/index.ts`.

Suggested first extraction targets:

- manifest types and read/write helpers
- bundle reference parsing and source resolution
- remote-agnostic bundle validation/materialization inputs

Minimum internal abstractions:

```ts
type SourceType = "builtin" | "path" | "registry";

type BundleSourceResolution =
  | {
      sourceType: "builtin" | "path";
      displaySource: string;
      rootPath: string;
    }
  | {
      sourceType: "registry";
      displaySource: string;
      requestedRef: string;
      package: {
        registry: string;
        namespace: string;
        name: string;
      };
      selector: {
        mode: "floating" | "tag" | "version";
        value?: string;
      };
    };
```

Why this is first:

- manifest v3 and remote fetch logic both depend on distinguishing parsed remote references from already-materialized local roots
- existing local callers can keep working while the internals become less monolithic

## Phase 2: Add Manifest v3

Upgrade manifest typing and persistence next.

Required changes:

- change `MANIFEST_VERSION` from `2` to `3`
- extend manifest bundle entries with optional `resolution` metadata
- allow `sourceType: "registry"`
- keep v1 read-time migration working
- add v2 to v3 read-time compatibility for local-only entries

Rules:

- local installs from built-ins and paths must continue to write no `resolution`
- registry entries must require complete `resolution`
- write normalization should preserve sort order and existing installed-skill behavior

Testing needed:

- v2 manifest reads cleanly under v3 code
- v3 local installs serialize without `resolution`
- v3 registry entries fail validation if `resolution` is incomplete

## Phase 3: Parse Remote References

After manifest support exists, add remote reference parsing without network behavior yet.

Required behavior:

- detect `skillcast:<namespace>/<bundle>`
- detect `skillcast:<namespace>/<bundle>@<selector>`
- detect `skillcast://<host>/<namespace>/<bundle>`
- detect `skillcast://<host>/<namespace>/<bundle>@<selector>`
- continue treating existing filesystem paths and built-in names exactly as today

Important rule:

- unresolved local aliases must not silently fall through to remote lookup

Testing needed:

- parse success for floating, tag, and exact-version forms
- parse success for explicit host forms
- local path precedence over remote-looking fallback logic
- built-in pack precedence remains intact

## Phase 4: Add Remote Client And Materialization

Remote behavior should enter through a dedicated client module, not through lifecycle code.

Suggested responsibilities:

- selector resolution against `docs/registry-api.md`
- exact release metadata retrieval
- artifact download
- digest verification
- temporary extraction to a validated local bundle root

Suggested internal type:

```ts
type MaterializedRemoteBundle = {
  sourceType: "registry";
  displaySource: string;
  rootPath: string;
  resolution: RegistryResolution;
};
```

Rules:

- downloaded content must be verified against the registry digest before validation
- extracted content must then pass the same local bundle validation used for path and built-in bundles
- temporary materialization paths must be outside `.skillcast/skills`

## Phase 5: Remote `inspect`

`inspect` is the first remote command to enable because it is read-oriented and lower risk than install.

Implementation shape:

- parse the reference
- if local, keep current behavior
- if remote, resolve and materialize the bundle in a temp directory
- validate and inspect using the same bundle inspection logic
- include requested ref and exact resolved version in output when source type is `registry`

Why this first:

- it proves parsing, resolution, download, digest verification, and validation without mutating `.skillcast`
- it exercises the API and provenance model with lower rollout risk

Testing needed:

- inspect public remote floating ref
- inspect public remote exact version
- inspect failure on digest mismatch
- inspect failure on not found and tag not found

## Phase 6: Remote `install`

Enable remote install only after inspect works end to end.

Implementation shape:

- resolve and materialize remote bundle
- pass validated bundle into the existing install lifecycle path
- persist manifest v3 `resolution`
- keep all existing collision, local modification, and `--force` logic unchanged

Required rule:

- network fetch and resolution can happen before taking `.skillcast.lock`
- final write path must persist the exact resolved version and digest that were verified

Testing needed:

- install floating remote ref writes manifest v3 resolution
- install tag ref writes tag mode plus exact resolved version
- `install --update` on tag or floating ref updates resolution metadata
- exact-version reinstall is stable
- local modification protections still block overwrite

## Phase 7: Remote `diff`

Remote `diff` should come after install, not before.

Reason:

- it depends on both remote materialization and manifest v3 provenance semantics
- there is an unresolved product question around offline behavior and selector movement reporting

Minimum first behavior:

- compare currently resolved remote bundle to installed local state
- show requested ref and exact resolved version

Defer for later:

- separate reporting for "tag moved" versus "installed files differ"
- strict offline diff mode for previously resolved registry installs

## Phase 8: Publish

Publish should be implemented after read flows are stable.

Dependencies:

- remote client write path
- artifact packaging logic
- server validation mapping
- authenticated transport

Do not add `skillcast login` before publish or protected reads exist in real code.

## File-Level Plan

Likely near-term edits:

- `packages/cli/src/index.ts`
  Split types/helpers enough to support registry source parsing and manifest v3.
- `packages/cli/src/test/run-smoke-tests.ts`
  Add manifest v3 migration coverage and remote-resolution tests around pure parsing/typing first.

Likely new modules once refactoring starts:

- `packages/cli/src/manifest.ts`
- `packages/cli/src/source-resolution.ts`
- `packages/cli/src/registry-client.ts`
- `packages/cli/src/materialize-remote-bundle.ts`

These do not all need to be created at once, but the implementation should move in that direction.

## Recommended First Code PR

The first implementation PR should stay narrow:

1. introduce manifest v3 types and migration
2. extend `SourceType` with `registry`
3. add remote reference parsing utilities
4. add tests for parsing and manifest compatibility

It should explicitly not:

- perform network requests
- change install behavior
- add `login`
- add publish

This gives a safe foundation for the next PR to implement remote inspect.

## Acceptance Criteria For The Foundation PR

- existing local smoke tests still pass
- manifest v1 and v2 remain readable
- local installs still write valid manifest state
- remote references parse deterministically into typed structures
- no CLI command attempts network access yet

## Open Questions

- whether to split `index.ts` before or alongside manifest v3 work
- whether remote inspect should land behind an internal flag for the first networked PR
- whether exact-version remote installs should reuse `bundleVersion` display as-is or later expose a separate resolved-version line consistently in CLI output
