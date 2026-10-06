# CLAUDE.md

@AGENTS.md

AGENTS.md is the source of truth for repository rules, architecture, compatibility, git/PR conventions, and workflow. Claude Code must follow it.

## Claude Code Agent Use

- Use Claude Opus 5.5 (`claude-opus-5-5`) for orchestration, scoping, reasoning, review, and final validation.
- Use Claude Sonnet 5.5 (`claude-sonnet-5-5`) sub-agents for scoped implementation tasks. This satisfies the sub-agent implementation requirement in AGENTS.md for Claude Code; the GPT-6 Luna / GPT-6.1 Sol model guidance in AGENTS.md applies to Codex only.
- Give implementation sub-agents relevant paths, constraints, and acceptance criteria rather than full conversation history. Parallelize only independent, non-overlapping tasks.
- Opus reviews the sub-agent's diff and focused evidence before reporting completion.
