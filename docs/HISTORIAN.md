# NOS Town Historian

Playbook mining and institutional memory for NOS Town.

---

## Overview

The Historian is NOS Town's institutional memory system. It runs as a nightly batch job, mining the completed Beads ledger to extract reusable patterns, measure model performance, and update the routing table. The Historian is what prevents NOS Town from repeating the same mistakes — and from missing opportunities to exploit what works.

---

## Core Concepts

### Beads Ledger

Every unit of work in NOS Town is a **Bead** — a structured record with:
```json
{
  "id": "bead_abc123",
  "type": "business_logic",
  "description": "Add rate limiting to /api/auth endpoint",
  "assigned_to": "polecat_3",
  "model_used": "llama-3.3-70b-versatile",
  "created_at": "2025-01-15T10:00:00Z",
  "completed_at": "2025-01-15T10:02:30Z",
  "tests_passed": true,
  "witness_score": 88,
  "witness_verdict": "PASS",
  "escalations": 0,
  "output_hash": "sha256:abc...",
  "tokens_used": {"input": 1200, "output": 800},
  "cost_usd": 0.0018
}
```

### Playbooks

A **Playbook** is a distilled pattern extracted from multiple similar Beads. It gives future Polecats a head start on common tasks:

```markdown
# Playbook: Rate Limiting Middleware (Node.js/Express)

## Pattern
When asked to add rate limiting to an Express route:
1. Use `express-rate-limit` package
2. Configure per-IP limits with sliding window
3. Return 429 with Retry-After header
4. Add to `middleware/rateLimiter.js`
5. Import and apply in route file

## Example Bead IDs
bead_abc123, bead_def456, bead_ghi789

## Success rate: 94% (17/18 Beads passed Witness)
## Avg tokens: 950 input, 620 output
## Recommended model: llama-3.1-8b-instant
```

---

## Historian Pipeline

```
[Nightly Trigger]
       ↓
[Load last N Beads from ledger]
       ↓
[Cluster by task type + semantic similarity]
       ↓
[For each cluster with >= 5 Beads]
    ├─ Extract common patterns
    ├─ Measure model performance
    ├─ Identify failure modes
    └─ Write / update Playbook
       ↓
[Update routing table with performance data]
       ↓
[Write eval report to playbooks/]
       ↓
[Commit changes via PR]
       ↓
[Notify Mayor on next startup]
```

---

## Implementation

### Trigger

The Historian runs via cron at 2 AM local time (or whenever the workspace is idle). It uses Groq Batch API for all inference, achieving a 50% cost reduction vs. real-time.

```yaml
# .github/workflows/historian.yml
name: Historian Nightly Run
on:
  schedule:
    - cron: '0 6 * * *'  # 2 AM EDT = 6 AM UTC
  workflow_dispatch:  # manual trigger
jobs:
  historian:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Historian
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
        run: node scripts/historian.js
```

### Clustering

The Historian clusters Beads using a lightweight semantic grouping approach:

1. Generate embeddings for each Bead description (using llama-3.1-8b-instant via Batch)
2. K-means cluster with k = sqrt(N/5) where N = number of Beads
3. Label each cluster with the dominant Bead type tag
4. Discard clusters with < 5 members (too sparse for patterns)

### Playbook Extraction Prompt

```
You are the Historian in NOS Town. Your job is to extract reusable patterns from completed work.

Cluster of similar Beads:
{bead_summaries}

For this cluster, extract:
1. A reusable implementation pattern (step-by-step)
2. Common pitfalls observed in failed Beads
3. Recommended model tier and typical token usage
4. A confidence score (0-100) for the pattern's reliability

Format as a Markdown Playbook.
```

---

## Playbook Directory

```
playbooks/
  ├── auth/
  │   ├── rate_limiting.md
  │   ├── jwt_middleware.md
  │   └── session_management.md
  ├── api/
  │   ├── rest_endpoint_pattern.md
  │   └── input_validation.md
  ├── database/
  │   ├── migration_pattern.md
  │   └── query_optimization.md
  ├── testing/
  │   ├── unit_test_pattern.md
  │   └── integration_test_pattern.md
  └── eval_reports/
      ├── eval_report_2025-01-15.md
      └── eval_report_2025-01-16.md
```

---

## Eval Reports

Nightly eval reports include:

```markdown
# NOS Town Eval Report: 2025-01-15

## Summary
- Beads processed: 847
- Playbooks updated: 12
- Playbooks created: 3
- Routing table changes proposed: 2

## Model Performance
| Model | Beads | Pass Rate | Avg Score | Avg Tokens | Cost/Bead |
|-------|-------|-----------|-----------|------------|-----------|
| llama-3.1-8b-instant | 612 | 87% | 82.3 | 1,840 | $0.00015 |
| llama-3.3-70b-versatile | 201 | 96% | 91.7 | 2,210 | $0.00180 |
| gpt-oss-120b | 34 | 98% | 94.2 | 2,650 | $0.00290 |

## Routing Recommendations
1. PROMOTE: llama-3.1-8b-instant for `api_documentation` tasks (pass rate jumped to 94% after Playbook update)
2. ESCALATE: `database_migration` tasks should default to 70B, not 8B (fail rate was 31% at 8B)

## Top Failure Modes
1. Missing error handling in async functions (8B, 23% of failures)
2. Incorrect TypeScript types in generic functions (8B, 18% of failures)
3. SQL injection in dynamic queries (caught by Safeguard, never merged)
```

---

## Playbook Injection

When a Mayor spawns a Polecat for a new Bead, it first queries the Playbook index:

```javascript
// Before assigning a Bead to a Polecat:
const relevantPlaybooks = await queryPlaybookIndex(bead.description);
if (relevantPlaybooks.length > 0) {
  bead.context += `\n\n## Relevant Playbooks\n${relevantPlaybooks.map(p => p.content).join('\n---\n')}`;
}
```

This gives the Polecat institutional context without requiring it to re-learn from scratch.

---

## Retention Policy

- Raw Beads older than 90 days are archived to `ledger/archive/`
- Playbooks are never deleted — only superseded (old versions kept with `_deprecated` suffix)
- Eval reports are kept for 365 days
- Routing table changes are version-controlled in git with full history
