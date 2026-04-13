Load project context for this session.

Run these commands and internalize the results:

1. Read the root CLAUDE.md: `cat CLAUDE.md`
2. Read SDLC config: `cat .claude/sdlc.yml`
3. List packages and their structure: `ls packages/*/src/`
4. Check current branch and recent commits: `git log --oneline -20`
5. Check for any uncommitted work: `git status`
6. Check package build status: `pnpm build 2>&1 | tail -5`

## Skills & Commands Inventory

After loading project context, also catalog what's available:

7. List available commands: `ls .claude/commands/*.md`
8. List available agents: `ls .claude/agents/team/*.md`

## Summary

After loading, provide a brief summary:
- Current branch and recent activity
- Any uncommitted changes
- Package health (builds passing?)
- Key architectural notes from CLAUDE.md and sdlc.yml
- Available commands and agents

Keep the summary to 10-15 lines. You are now primed and ready to work.
