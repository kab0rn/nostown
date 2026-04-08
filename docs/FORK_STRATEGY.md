# NOS Town Fork Strategy

How NOS Town syncs with Gas Town upstream.

---

## Overview

NOS Town is a fork of [Gas Town](https://github.com/gastownhall/gastown) by Steve Yegge. Gas Town defines the core architectural primitives — Hooks, Beads, Convoys, Mayor/Witness/Deacon roles, and the mailbox system. NOS Town extends these with Groq-native runtime, multi-model routing, and swarm/council patterns.

This document describes how NOS Town tracks upstream Gas Town changes, what it accepts, and what it deliberately diverges from.

---

## Relationship to Gas Town

| Aspect | Gas Town | NOS Town |
|--------|----------|----------|
| Runtime | Claude Code (Anthropic) | Groq API (open models) |
| Model strategy | Single frontier model per agent | Multi-model routing (8B/70B/120B) |
| Primary inference | Claude 3.5/3.7 Sonnet | llama-3.x, Mistral, gpt-oss family |
| Agent parallelism | Limited by Claude cost | 20–50 agents at Groq speeds |
| Quality assurance | Single-model judgment | Witness councils (multi-judge) |
| Institutional memory | Per-session | Persistent Playbooks via Historian |
| Cost model | Expensive frontier | Cheap B + expensive A only when needed |

---

## What NOS Town Inherits from Gas Town

### Core data structures (inherited, unchanged)
- **Hook files** — persistent project state files read by every agent on startup
- **Beads ledger** — structured work unit tracking with status, output, and metadata
- **Convoy protocol** — ordered sequence of Beads that must run serially
- **Mailbox system** — role-to-role communication via structured message files

### Role concepts (inherited, adapted)
- **Mayor** — orchestrator role (NOS Town uses 70B vs. Claude)
- **Witness** — quality judge role (NOS Town adds council mode)
- **Deacon** — message router role (NOS Town uses 8B)
- **Dogs** — background worker role (NOS Town uses 8B swarm)

### Workflow principles (inherited)
- Agents must read Hook files before starting work
- Agents must write Bead updates atomically
- No agent modifies another agent's file without a handoff Bead
- Mayor is the single source of truth for task decomposition

---

## What NOS Town Diverges From

### 1. Model layer
Gas Town is designed for Claude Code's IDE-integrated, single-model-per-agent approach. NOS Town replaces this entirely with Groq's multi-model, API-first architecture. There is no compatibility layer — these are fundamentally different execution environments.

### 2. Agent count
Gas Town targets 4–10 agents. NOS Town is designed for 20–50 agents running in parallel, enabled by Groq's low cost and high throughput.

### 3. Quality pipeline
Gas Town relies on Claude's inherent quality. NOS Town adds an explicit Witness layer (with council escalation) because open models have higher variance and require more structured quality gates.

### 4. Institutional memory
Gas Town has no cross-session memory system. NOS Town's Historian is a NOS Town original — it has no Gas Town equivalent.

### 5. Model routing
Gas Town uses one model for everything. NOS Town's routing table, escalation ladder, and A/B testing system are NOS Town originals.

---

## Upstream Sync Process

### When to sync
Sync with Gas Town upstream when:
1. Gas Town adds a new role or significantly redesigns an existing one
2. Gas Town changes the Beads ledger schema
3. Gas Town changes the Hook file format
4. Gas Town changes the mailbox protocol

### When NOT to sync
Do not sync Gas Town changes that:
- Reference Claude Code APIs or Anthropic-specific behavior
- Assume a single model for all roles
- Reduce agent parallelism
- Remove quality gate hooks

### Sync procedure

```bash
# 1. Add Gas Town as upstream remote (one-time setup)
git remote add upstream https://github.com/gastownhall/gastown.git

# 2. Fetch upstream changes
git fetch upstream

# 3. Review what changed
git log upstream/main --oneline --since="last sync date"
git diff main upstream/main -- docs/ hooks/ ledger/

# 4. Cherry-pick relevant structural changes
git checkout -b sync/gastown-upstream-YYYY-MM-DD
git cherry-pick <commit-hash>  # only commits relevant to NOS Town

# 5. Adapt to NOS Town conventions
# - Replace Claude model references with Groq equivalents
# - Update role prompts to NOS Town harness format
# - Preserve NOS Town routing and council additions

# 6. PR + Mayor review before merging
```

### Sync log

Maintain a `SYNC_LOG.md` in the repo root tracking:
- Date of last upstream sync
- Gas Town commit hash synced from
- Summary of what was adopted vs. rejected
- NOS Town adaptations made

---

## Gas Town Compatibility Layer

For users migrating from Gas Town to NOS Town, a compatibility shim is planned:

```javascript
// compat/gastown-shim.js
// Translates Gas Town Claude-format Beads to NOS Town Groq-format Beads

export function adaptBeadFromGasTown(gasBeadJson) {
  return {
    ...gasBeadJson,
    model_used: mapClaudeModelToGroq(gasBeadJson.model),
    routing_tier: inferTierFromModel(gasBeadJson.model),
    witness_required: gasBeadJson.risk_level === 'high',
  };
}

function mapClaudeModelToGroq(claudeModel) {
  const map = {
    'claude-3-5-sonnet': 'llama-3.3-70b-versatile',
    'claude-3-haiku': 'llama-3.1-8b-instant',
    'claude-3-opus': 'gpt-oss-120b',
  };
  return map[claudeModel] ?? 'llama-3.3-70b-versatile';
}
```

---

## Contribution Guidelines

When contributing to NOS Town, distinguish between:

1. **Core changes** — changes to the Beads/Hook/Mailbox data structures. These should be proposed upstream to Gas Town first if they improve the base architecture.
2. **Groq-specific changes** — routing, council, Historian, model selection. These are NOS Town originals and do not need Gas Town review.
3. **Compatibility changes** — anything that affects the Gas Town migration path. Requires careful review to avoid breaking imports.
