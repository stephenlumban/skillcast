# Pack Research

This note captures why the first non-trivial Skillcast bundles should focus on onboarding, pull request work, and debugging.

## Findings

### Repo Onboarding Pack

This pack has the strongest "first run" value because official agent products repeatedly highlight codebase understanding as a primary workflow.

- Anthropic positions Claude Code as a tool to "navigate any codebase" and answer questions about project structure and behavior. Source: [Claude Code overview](https://docs.anthropic.com/en/docs/claude-code/overview)
- GitHub documents a dedicated workflow for using Copilot to explore a codebase, including understanding directories, files, symbols, and commits. Source: [Using GitHub Copilot to explore a codebase](https://docs.github.com/copilot/tutorials/using-copilot-to-explore-a-codebase)
- OpenAI describes Codex as useful for "answering questions about your codebase" and highlights "code understanding" as one of its daily internal use cases. Sources: [Introducing Codex](https://openai.com/index/introducing-codex/), [How OpenAI uses Codex](https://openai.com/business/guides-and-resources/how-openai-uses-codex/)

Recommended skills:

- `repo-map`
- `architecture-explainer`
- `local-dev-setup-check`
- `conventions-finder`
- `change-impact-scan`

### PR Workflow Pack

PR-centric work is a safe mainstream bundle because both GitHub and OpenAI explicitly frame review and PR iteration as core agent tasks.

- GitHub Copilot coding agent can open pull requests, iterate from PR comments, and request user review. Sources: [GitHub Copilot coding agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent), [Reviewing a pull request created by GitHub Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/review-copilot-prs)
- GitHub also has a separate Copilot code review feature focused on PR feedback and suggested fixes. Source: [About GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review)
- OpenAI documents Codex automatic GitHub review and positions it as a tool to write, review, and ship code faster. Sources: [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540), [Codex](https://openai.com/codex)

Recommended skills:

- `pr-review`
- `pr-summary`
- `commit-message`
- `review-fix-pass`
- `risk-check`

### Debug & Triage Pack

Debugging is broadly supported across official agent documentation and is one of the most reliable pain-relief categories to package.

- Anthropic says Claude Code can "debug and fix issues" and its software-development research analyzes large volumes of coding interactions including debugging-oriented work. Sources: [Claude Code overview](https://docs.anthropic.com/en/docs/claude-code/overview), [Anthropic Economic Index: AI's impact on software development](https://www.anthropic.com/news/impact-software-development)
- GitHub Copilot coding agent is explicitly described as being able to fix bugs. Source: [About GitHub Copilot coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
- Gemini CLI publishes dedicated troubleshooting and sandbox-debug documentation, reinforcing debugging and diagnosis as core terminal-agent workflows. Sources: [Troubleshooting guide](https://google-gemini.github.io/gemini-cli/docs/troubleshooting.html), [Sandboxing in the Gemini CLI](https://google-gemini.github.io/gemini-cli/docs/cli/sandbox.html)
- OpenAI positions Codex for fixing bugs, incident response, and alert monitoring. Sources: [Introducing Codex](https://openai.com/index/introducing-codex/), [Codex](https://openai.com/codex)

Recommended skills:

- `bug-triage`
- `log-investigation`
- `failing-test-diagnosis`
- `minimal-repro-plan`
- `fix-verification`

## Conclusion

If the goal is to make Skillcast immediately legible, these three packs are the right first expansion set:

1. `repo-onboarding-pack` for immediate codebase understanding
2. `pr-workflow-pack` for repeatable daily engineering tasks
3. `debug-triage-pack` for high-value troubleshooting work
