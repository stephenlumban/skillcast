# Skillcast State Model

Skillcast treats installed skills as having three comparable forms:

- source version: the currently resolved bundle definition rendered into the expected installed `SKILL.md`
- installed version: the manifest record saved during install or update
- local version: the current `SKILL.md` file on disk inside `.skillcast/skills/`

## Identity

- primary identity is `skill.id`
- `skill.name` remains a compatibility/display field
- bundle ownership is single-owner today; collisions transfer ownership only with explicit `--force`

## States

- `installed (clean)`: manifest entry exists and local file hash matches installed hash
- `installed (source-changed)`: manifest entry exists, local file is unchanged, and the current bundle render differs from the stored source hash
- `installed (modified)`: manifest entry exists and local file hash differs from the stored installed hash
- `conflict`: both the current bundle render and local file differ from the stored installed state
- `missing`: manifest entry exists but the installed `SKILL.md` file is gone
- `orphaned`: a `SKILL.md` file exists under `.skillcast/skills/` but no manifest entry owns it
- `removed`: a manifest-owned skill existed previously but is no longer present in the current bundle source during diff/update

## Operational rules

- install/update/uninstall mutate state only while holding the repo-level `.skillcast.lock`
- manifest writes are atomic temp-file moves inside `.skillcast/`
- uninstall removes files only inside `.skillcast/skills/`
- `repair` can remove safe missing-file manifest entries, but does not delete orphaned files automatically
