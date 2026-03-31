# Bundle Spec v0

A Skillcast bundle is a directory with a `bundle.yaml` file and one or more skill directories.

## Required Files

- `bundle.yaml`
- one `skill.yaml` for each declared skill
- one instructions file for each skill entrypoint

## `bundle.yaml`

```yaml
name: pr-review-pack
version: 0.1.0
description: PR review workflow bundle

skills:
  - name: code-review
    path: ./skills/code-review

targets:
  - generic-agent
```

## Field Rules

- `name`: bundle identifier and install directory name
- `version`: human-readable bundle version
- `description`: short summary of bundle purpose
- `skills`: list of included skills with relative paths
- `targets`: runtimes every skill in the bundle must support

## Validation Rules

- `bundle.yaml` must exist at the bundle root
- every skill path must exist
- every skill path must contain `skill.yaml`
- every bundle target must be listed in every skill's compatibility runtimes
