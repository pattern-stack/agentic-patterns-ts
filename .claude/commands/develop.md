---
description: Full SDLC loop from idea to merged code
argument-hint: [idea or description]
---

# /develop

Run the full SDLC loop: Understand -> Plan -> Spec -> Implement -> Validate.

Uses **TeamCreate + named teammates** for split-panel visibility and coordinated task management.

## Configuration

Read `.claude/sdlc.yml` for project config. Load primitives:
- `.claude/primitives/language/typescript.md`
- `.claude/primitives/quality/strict.md`
- `.claude/primitives/commit/conventional.md`

## Usage

```
/develop Add a new gate type for cost limits       # Full loop from idea
/develop --from=spec <spec-path>                   # Jump to spec phase
/develop --from=implement <spec-path>              # Jump to implementation
```

## The Loop

```
  ARCHITECT                              BUILDER         VALIDATOR
  ---------                              -------         ---------
  Understand --[gate]--> Plan --[gate]--> Spec --[gate]--> Implement --> Validate --[gate]
                                                            (agentic)
```

Human gates after understand, plan, spec, and validate. Implementation is agentic (no gate).

## Setup

### 1. Create Team

```
TeamCreate(team_name: "develop-{slug}")
```

### 2. Create Tasks

Create one task per phase, with dependencies:

| Task | Subject | Blocked By |
|------|---------|------------|
| #1 | Understand the problem | -- |
| #2 | Plan the work breakdown | #1 |
| #3 | Write implementation spec | #2 |
| #4 | Implement the code | #3 |
| #5 | Validate the implementation | #4 |

---

## Phase 1: Understand

**Spawn teammate:**
```
Agent(
  name: "architect",
  team_name: "develop-{slug}",
  subagent_type: "general-purpose",
  mode: "bypassPermissions",
  prompt: <architect system prompt from .claude/agents/team/architect.md>
         + "Mode: understand"
         + <idea context>
)
```

**Mission:** Demonstrate working knowledge of the problem, codebase, and layers involved.
- Input: User's idea/request ($ARGUMENTS)
- Output: Understanding artifact (context tree + framing statement)
- Constraint: Don't propose solutions -- just prove understanding

**Human Gate:** "Did I get this right?"

---

## Phase 2: Plan

**Spawn teammate:** Same as Phase 1 but with mode: plan and the approved understanding as input.

**Mission:** Break understood concept into PR-sized work items with dependencies.
- Input: Approved understanding artifact
- Output: Work breakdown with dependencies and execution order
- Constraint: Items sized for single-PR review

**Human Gate:** "Is this the right breakdown?"

---

## Phase 3: Spec

**Spawn teammate:** Same architect agent, mode: spec.

**Mission:** Convert work item into implementation spec.
- Input: Work item description
- Output: Spec file at `.claude/specs/{date}-{slug}.md`
- Constraint: Pseudocode + file list + interfaces, not actual code

**Human Gate:** "Is this the right approach?"

---

## Phase 4: Implement

**Spawn teammate:**
```
Agent(
  name: "builder",
  team_name: "develop-{slug}",
  subagent_type: "general-purpose",
  mode: "bypassPermissions",
  prompt: <builder system prompt from .claude/agents/team/builder.md>
         + <spec file path>
)
```

**Mission:** Write code following the approved spec.
- Input: Approved spec file
- Constraint: Follow spec exactly, TDD, run `bun run check` before done
- Output: Working code on feature branch

**No Human Gate:** Implementation is agentic. Validation provides the checkpoint.

---

## Phase 5: Validate

**Spawn teammate:**
```
Agent(
  name: "validator",
  team_name: "develop-{slug}",
  subagent_type: "general-purpose",
  mode: "bypassPermissions",
  prompt: <validator system prompt from .claude/agents/team/validator.md>
         + <branch name and changed files context>
)
```

**Mission:** Prove the implementation works and meets standards.
- Input: Completed branch from builder
- Output: Validation report (gates, architecture, tests, recommendation)

**Human Gate:** "Ready to merge?"

---

## Retry Loop

If validation returns REQUEST_CHANGES:
1. Spawn a new builder with the failure context
2. Builder fixes issues
3. Spawn a new validator
4. Max 3 retries before escalating to human

---

## Team Agents

| Agent | Phases | Capability | Agent Definition |
|-------|--------|------------|-----------------|
| `architect` | Understand, Plan, Spec | Read-only. Explores, plans, specs. | `.claude/agents/team/architect.md` |
| `builder` | Implement | Read-write. Writes code, runs tests. | `.claude/agents/team/builder.md` |
| `validator` | Validate | Runs gates, produces reports. | `.claude/agents/team/validator.md` |
