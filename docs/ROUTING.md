# NOS Town Routing

Model routing table and council patterns for NOS Town.

---

## Overview

NOS Town uses a heterogeneous routing strategy: tasks are assigned to different model tiers based on complexity, risk level, and cost sensitivity. The routing table is a living document — the Historian updates it nightly based on empirical Bead performance data.

---

## Routing Principles

1. **Default cheap, escalate on failure.** Every Bead starts at the cheapest viable tier (B = 8B). If it fails tests twice, auto-promote to Tier A (70B).
2. **Risk-proportionate judgment.** High-risk Beads (auth, payments, data deletion) skip Tier B and go directly to Tier A + Witness review.
3. **Batch for latency-insensitive work.** Historian, offline evals, and background analysis always use Groq Batch for 50% cost savings.
4. **Council for uncertainty.** Single-judge Witness confidence < 80% triggers a 3-judge council. Majority rules.

---

## Routing Table

| Bead Type | Default Model | Escalation Model | Safeguard | Witness Required |
|-----------|--------------|-----------------|-----------|------------------|
| Boilerplate code | llama-3.1-8b-instant | llama-3.3-70b-versatile | No | No |
| Business logic | llama-3.3-70b-versatile | gpt-oss-120b | No | Yes |
| Auth / security code | llama-3.3-70b-versatile | gpt-oss-120b | Yes | Yes (council) |
| API design | llama-3.3-70b-versatile | gpt-oss-120b | No | Yes |
| Tests | llama-3.1-8b-instant | llama-3.3-70b-versatile | No | No |
| Documentation | llama-3.1-8b-instant | llama-3.3-70b-versatile | No | No |
| Data migration | llama-3.3-70b-versatile | gpt-oss-120b | Yes | Yes (council) |
| Linting/formatting | llama-3.1-8b-instant | — | No | No |
| Architecture decisions | gpt-oss-120b | Council (3x 120B) | No | Yes (council) |
| Offline eval / analysis | Batch (any model) | — | No | No |

---

## Escalation Ladder

```
Tier B (8B)  →  fail ×2  →  Tier A (70B)  →  fail ×1  →  Council (3× 70B)
                                                        →  Mayor notified
```

### Escalation rules

1. A Polecat (8B) runs the Bead.
2. If the Bead's tests fail, retry once with temperature=0.
3. If it fails a second time, escalate: re-run with 70B model.
4. If the 70B model fails, summon a council of 3 × 70B instances. Majority output wins.
5. If council fails, the Bead is marked BLOCKED and the Mayor is notified.

---

## Witness Council Protocol

A **Witness Council** is invoked when:
- A single Witness returns ESCALATE (confidence 60–79)
- A Bead is tagged `high-risk`
- The Mayor explicitly requests council review

### Council process

```
1. Spawn 3 Witness instances (all llama-3.3-70b-versatile or gpt-oss-120b)
2. Each reviews the Bead independently
3. Each returns: {verdict: PASS|FAIL, score: 0-100, reasoning: "..."}
4. Aggregate: majority verdict wins
5. If 2-1 split: include minority reasoning in Bead notes
6. If 3-way tie (impossible with 3 judges): escalate to Mayor
```

### Council latency budget

At Groq speeds (500+ tok/s), a 3-judge council for a 2000-token output completes in ~4 seconds total (parallel). This makes just-in-time councils economically viable.

---

## A/B Routing

NOS Town supports A/B routing to continuously evaluate new models.

```yaml
# routing_config.yaml
ab_routing:
  enabled: true
  experimental_model: llama-3.4-70b  # candidate
  baseline_model: llama-3.3-70b-versatile  # current default
  split: 0.10  # 10% of Beads go to experimental
  metrics:
    - tests_passed_rate
    - witness_approval_rate
    - latency_p95
  promote_threshold: 0.05  # experimental must beat baseline by 5%
  evaluation_window: 500  # Beads
```

If the experimental model beats baseline across all metrics after 500 Beads, the Historian auto-promotes it to the default routing table.

---

## Continuous Background Evals

Every night, the Historian re-runs a random sample of the last 1000 completed Beads against the current default models via Groq Batch. This detects:

- **Model regressions:** A new model version underperforms vs. the old one
- **Prompt drift:** Prompts that worked 30 days ago now fail
- **Task distribution shift:** New Bead types that the routing table doesn't handle well

Results are written to `playbooks/eval_report_{date}.md` and surfaced to the Mayor on next startup.

---

## Cost Routing

Cost estimates per 1M tokens (approximate, 2025):

| Model | Input | Output | Use when |
|-------|-------|--------|----------|
| llama-3.1-8b-instant | $0.05 | $0.08 | Default for all Tier B work |
| llama-3.3-70b-versatile | $0.59 | $0.79 | Mayor, Witness, Refinery, complex Beads |
| gpt-oss-120b | $0.90 | $1.20 | Architecture, council, max quality |
| gpt-oss-safeguard-20b | $0.20 | $0.20 | All security checks |
| Groq Batch (any) | 50% off | 50% off | Historian, offline evals |

### Cost optimization rules

1. Never use 70B for linting, formatting, or boilerplate.
2. Always use Batch for work that can tolerate a 1–8 hour turnaround.
3. Set `max_tokens` tightly per Bead type to prevent runaway outputs.
4. Cache Witness verdicts for identical (hash-matched) outputs.

---

## Dynamic Routing Updates

The routing table is stored in `config/routing_table.json` and versioned in git. The Historian is the only role authorized to propose routing table updates (via PR). Updates require Mayor approval before taking effect.

```json
{
  "version": "1.0.0",
  "updated_at": "2025-01-01",
  "updated_by": "historian",
  "routes": {
    "boilerplate": {
      "default": "llama-3.1-8b-instant",
      "escalation": "llama-3.3-70b-versatile",
      "safeguard": false,
      "witness": false
    },
    "auth": {
      "default": "llama-3.3-70b-versatile",
      "escalation": "gpt-oss-120b",
      "safeguard": true,
      "witness": "council"
    }
  }
}
```
