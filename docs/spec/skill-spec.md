# Skill Spec v0

A Skillcast skill is a directory described by `skill.yaml`.

## `skill.yaml`

```yaml
id: org.core.code-review.basic
name: code-review
version: 0.1.0
description: Reviews code diffs

entry:
  instructions: ./instructions.md

inputs:
  - name: diff
    type: string
    required: true

outputs:
  - name: review_summary
    type: string

compatibility:
  runtimes:
    - generic-agent
```

## Field Rules

- `id`: canonical skill identifier
- `name`: human-readable skill name
- `version`: skill version
- `description`: short summary
- `entry.instructions`: relative path to the Markdown instructions file
- `inputs`: declared input contract
- `outputs`: declared output contract
- `compatibility.runtimes`: runtimes that can consume the skill

## Validation Rules

- `skill.yaml` must exist
- `entry.instructions` must point to an existing file
- `name` should match the name referenced from `bundle.yaml`
- every runtime required by the bundle must appear in `compatibility.runtimes`
