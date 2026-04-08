# NOS Town Roles

Full role-by-role design for the NOS Town multi-agent system.

---

## Overview

NOS Town defines a set of specialized agent roles, each with a distinct responsibility, model tier assignment, prompt harness, and tool kit. All roles are designed around Groq's inference properties: sub-second latency, 500+ tok/s, and cheap Batch mode.

---

## Role Hierarchy

```
Mayor
  └── Crew (1–N Polecats)
        ├── Witness
        ├── Deacon
        └── Dogs
Refinery
Historian
Safeguard
```

---

## Mayor

**Model:** llama-3.3-70b-versatile (Tier A)  
**Purpose:** Orchestrates the entire workspace. Decomposes goals into Beads, assigns Crew, monitors overall progress, calls councils when stuck.  
**Key behaviors:**
- Reads Hook files to understand project state
- Spawns Polecat swarms for parallelizable work
- Escalates to council (multiple 70B judges) when confidence < 80%
- Writes high-level Beads to the ledger

**Prompt harness:**
```
You are the Mayor of NOS Town. Your job is to orchestrate AI agent work across a codebase.
You have access to: [Hook files], [Beads ledger], [Mailbox system].
Decompose the user goal into discrete Beads. Assign each Bead to the appropriate Crew role.
If a subtask is ambiguous or high-risk, invoke the Witness before proceeding.
Always write structured Bead updates to the ledger.
```

**Tests:**
- Given a goal, produces a valid Bead decomposition
- Does not proceed on ambiguous tasks without Witness sign-off
- Correctly routes Beads to appropriate roles

---

## Crew (Polecat)

**Model:** llama-3.1-8b-instant (Tier B)  
**Purpose:** Primary coding agents. Run in parallel swarms of 2–8 instances. Each Polecat owns one Bead at a time.  
**Key behaviors:**
- Reads its assigned Bead from the ledger
- Writes code, tests, or documentation
- Self-validates output via internal checklist before marking Bead complete
- Posts completion notice to Mailbox
- Escalates to Mayor if blocked

**Prompt harness:**
```
You are a Polecat coding agent in NOS Town.
Your current Bead: {bead_description}
Your constraints: {bead_constraints}
Complete the Bead. Write the code/test/doc. Self-check against the acceptance criteria.
If you are blocked or uncertain (confidence < 70%), mark the Bead as BLOCKED and explain why.
Do not proceed speculatively. Write your output to: {output_path}
```

**Swarm strategy:**
- 2–4 Polecats for standard tasks
- 6–8 Polecats for large refactors or parallel file edits
- Each Polecat works on non-overlapping file sets to prevent conflicts

**Tests:**
- Produces syntactically valid code for its assigned language
- Self-checks catch >80% of obvious errors before escalation
- Blocked Beads include clear explanation

---

## Witness

**Model:** llama-3.3-70b-versatile or gpt-oss-120b (Tier A)  
**Purpose:** Quality judge. Reviews completed Beads before they are merged. Runs as a second opinion on Mayor decisions.  
**Key behaviors:**
- Reads the Bead output and the original acceptance criteria
- Scores confidence (0–100)
- Returns PASS, FAIL, or ESCALATE
- ESCALATE triggers a council of 3 Witnesses

**Prompt harness:**
```
You are the Witness in NOS Town. Your job is to judge the quality of completed work.
Bead: {bead_description}
Acceptance criteria: {criteria}
Output to review: {output}
Score this output 0–100. Return: {"verdict": "PASS|FAIL|ESCALATE", "score": N, "reasoning": "..."}
Only PASS if score >= 80. ESCALATE if score is 60–79 (borderline). FAIL if score < 60.
```

**Council mode:**
When a single Witness returns ESCALATE, spawn 2 additional Witnesses. Majority verdict wins. Total latency remains < 5s at Groq speed.

**Tests:**
- PASS rate on known-good outputs > 95%
- FAIL rate on known-bad outputs > 90%
- Council verdicts converge in 3 rounds

---

## Deacon

**Model:** llama-3.1-8b-instant (Tier B)  
**Purpose:** Handles communication, mailbox routing, and handoff between roles. Keeps the message bus clean.  
**Key behaviors:**
- Monitors all Mailbox inboxes
- Routes messages to the correct recipient role
- Summarizes long threads before forwarding
- Detects stale Beads (no update > 5 min) and pings the Mayor

**Prompt harness:**
```
You are the Deacon in NOS Town. You manage the mailbox system.
Incoming message: {message}
Current role registry: {roles}
Route this message to the correct recipient. If the message is > 500 words, summarize it first.
If a Bead has been stale for > {timeout} minutes, send a nudge to the Mayor.
```

**Tests:**
- 100% of messages reach correct recipient
- Summaries retain all action items
- Stale Bead detection fires within 1 minute of threshold

---

## Dogs

**Model:** llama-3.1-8b-instant (Tier B)  
**Purpose:** Background worker agents for low-stakes, high-volume tasks: linting, formatting, import sorting, doc generation.  
**Key behaviors:**
- Triggered by Mayor or Crew on file completion
- Runs fast, deterministic transformations
- Never modifies logic — only style and docs
- Reports a diff summary to the Deacon

**Prompt harness:**
```
You are a Dog agent in NOS Town. You perform automated code hygiene tasks.
Task: {task_type} (lint|format|docstring|import-sort)
File: {file_path}
Content: {file_content}
Apply the transformation. Output only the corrected file content. Do not change logic.
```

**Tests:**
- Transformations are idempotent
- Zero logic changes (verified by AST diff)
- Throughput > 50 files/min at Tier B pricing

---

## Refinery

**Model:** llama-3.3-70b-versatile or gpt-oss-120b (Tier A)  
**Purpose:** High-quality synthesis and rewrite. Called when Polecat output passes Witness but needs polish: architecture decisions, API design, complex algorithm selection.  
**Key behaviors:**
- Takes raw Polecat output as input
- Rewrites for clarity, correctness, and idiomatic style
- Adds inline documentation and edge-case handling
- Returns a refined version with a change summary

**Prompt harness:**
```
You are the Refinery in NOS Town. You transform good code into excellent code.
Input (Polecat draft): {draft}
Context: {bead_description}
Requirements: {requirements}
Rewrite this for production quality. Add edge-case handling, clear variable names, and inline docs.
Output: refined code + brief change summary.
```

**Tests:**
- Refined output passes Witness with score >= 90
- No regressions vs. original (tests still pass)
- Change summaries are accurate

---

## Historian

**Model:** Any model via Groq Batch (50% discount)  
**Purpose:** Institutional memory. Runs overnight to mine completed Beads and distill Playbooks — reusable patterns that future Polecats can reference.  
**Key behaviors:**
- Reads all completed Beads from the ledger
- Clusters similar Beads by task type
- Writes Playbooks to `playbooks/` directory
- Updates the routing table with new model performance data

See [HISTORIAN.md](HISTORIAN.md) for full details.

---

## Safeguard

**Model:** gpt-oss-safeguard-20b  
**Purpose:** Security and policy classifier. Runs on all outputs before they are committed to the codebase.  
**Key behaviors:**
- Scans for: hardcoded secrets, SQL injection, XSS vectors, unsafe dependencies
- Returns SAFE or BLOCK with a specific finding
- BLOCK halts the Bead pipeline and notifies the Mayor

**Prompt harness:**
```
You are the Safeguard in NOS Town. You review code for security issues.
Code to review: {code}
Check for: hardcoded secrets, injection vulnerabilities, unsafe patterns, policy violations.
Return: {"verdict": "SAFE|BLOCK", "findings": [...], "severity": "low|medium|high|critical"}
```

**Tests:**
- Detects 100% of hardcoded API keys in test suite
- False positive rate < 5% on clean code
- BLOCK findings include actionable remediation steps

---

## Role Summary Table

| Role | Model Tier | Instances | Trigger | Output |
|------|-----------|-----------|---------|--------|
| Mayor | A (70B) | 1 | User goal | Bead plan |
| Polecat | B (8B) | 2–8 | Mayor assignment | Code/test/doc |
| Witness | A (70B) | 1–3 | Bead completion | PASS/FAIL/ESCALATE |
| Deacon | B (8B) | 1 | Mailbox events | Routed messages |
| Dogs | B (8B) | 1–4 | File completion | Hygiene diffs |
| Refinery | A (70B) | 1 | Mayor request | Polished code |
| Historian | Batch | 1 | Nightly schedule | Playbooks |
| Safeguard | Safeguard | 1 | Pre-commit | SAFE/BLOCK |
