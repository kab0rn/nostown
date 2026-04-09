# NOS Town Known Risks Register

This document tracks the known architectural and implementation risks that remain after the current design corrections. Every risk must have an owner, metric, test strategy, review gate, and go/no-go threshold.

---

## Risk Fields

Each risk entry includes:

- **ID**
- **Title**
- **Severity**
- **Owner**
- **Why it remains open**
- **How to detect it**
- **Metric / Alert**
- **Test**
- **Review Gates**
- **Go / No-Go Threshold**
- **Current Status**

---

## Active Risks

### R-001 — MemPalace SQLite Write Ceiling

- **Severity:** High
- **Owner:** Platform / Memory
- **Why it remains open:** Single-writer SQLite behavior may become the dominant bottleneck under concurrent Polecat, Witness, Safeguard, and Historian writes.
- **How to detect it:** Run concurrent writer load tests at 5, 10, 15, and 20 writers.
- **Metric / Alert:** `mempalace_write_latency_ms` p95
- **Test:** `tests/integration/mempalace-write-contention.test.ts`
- **Review Gates:** Gate 1, Gate 4, Gate 8
- **Go / No-Go Threshold:** p95 <= 50ms for expected gate load; >200ms is gate failure
- **Current Status:** Open

### R-002 — Mayor Orphan Workflow Replay Errors

- **Severity:** Critical
- **Owner:** Orchestration
- **Why it remains open:** Replacement Mayor logic may duplicate bead creation or replay stale mailbox state incorrectly.
- **How to detect it:** Kill Mayor after partial dispatch and verify idempotent adoption.
- **Metric / Alert:** `orphan_workflow_count`, duplicate bead IDs, ledger divergence
- **Test:** `tests/integration/mayor-adoption.test.ts`
- **Review Gates:** Gate 2, Gate 8
- **Go / No-Go Threshold:** zero duplicate bead creation; zero unreconciled active convoy on resume
- **Current Status:** Open

### R-003 — Forged Convoy Sender

- **Severity:** Critical
- **Owner:** Transport / Security
- **Why it remains open:** Shared transport MAC plus asymmetric sender keys must be implemented correctly to prevent sender spoofing.
- **How to detect it:** Inject messages signed with the wrong key but valid structure or valid transport MAC.
- **Metric / Alert:** `convoy_authz_denied_total`, quarantine events
- **Test:** `tests/unit/convoy-authn.test.ts`
- **Review Gates:** Gate 3, Gate 8
- **Go / No-Go Threshold:** all spoof attempts rejected
- **Current Status:** Open

### R-004 — Critical Bead Starvation

- **Severity:** High
- **Owner:** Swarm / Scheduling
- **Why it remains open:** Dependency-aware priority may still fail under mixed workloads or queue churn.
- **How to detect it:** Run mixed critical-path and low-priority workloads with inbox pressure.
- **Metric / Alert:** `critical_bead_starvation_count`
- **Test:** `tests/integration/swarm-priority.test.ts`
- **Review Gates:** Gate 3, Gate 7, Gate 8
- **Go / No-Go Threshold:** no sustained starvation for critical predecessors
- **Current Status:** Open

### R-005 — KG Critical Conflict Corruption

- **Severity:** High
- **Owner:** Memory / Routing
- **Why it remains open:** Conflict-class rules may still be implemented inconsistently across writers.
- **How to detect it:** Simulate conflicting critical writes from multiple roles.
- **Metric / Alert:** conflict-pending count, invalidations by class
- **Test:** `tests/unit/kg-critical-conflict.test.ts`
- **Review Gates:** Gate 4, Gate 8
- **Go / No-Go Threshold:** critical conflicts always resolved by precedence or escalated
- **Current Status:** Open

### R-006 — Cross-Rig Tunnel Leakage

- **Severity:** Medium
- **Owner:** Routing / Memory
- **Why it remains open:** Same room names across rigs may cause over-sharing of context or stale advice.
- **How to detect it:** Create same-room rigs with incompatible stacks and verify tunnel safety guards.
- **Metric / Alert:** tunnel advisory downgrade count
- **Test:** `tests/integration/tunnel-safety.test.ts`
- **Review Gates:** Gate 4, Gate 8
- **Go / No-Go Threshold:** incompatible tunnel hits never auto-apply
- **Current Status:** Open

### R-007 — Hook-Triggered Injection

- **Severity:** Critical
- **Owner:** Hooks / Security
- **Why it remains open:** Variable substitution and hook execution can reintroduce shell injection paths.
- **How to detect it:** Fuzz `{{event.*}}` substitutions and command payloads.
- **Metric / Alert:** blocked substitution count, safeguard lockdown count
- **Test:** `tests/security/hook-injection.test.ts`
- **Review Gates:** Gate 5, Gate 8
- **Go / No-Go Threshold:** zero unsafe expansions executed
- **Current Status:** Open

### R-008 — Safeguard Pool Latency Variance

- **Severity:** High
- **Owner:** Security / Runtime
- **Why it remains open:** External model latency spikes can still create write-path bottlenecks even with pooling.
- **How to detect it:** Burst 20–50 concurrent diff scans under degraded provider conditions.
- **Metric / Alert:** `safeguard_queue_depth`, `safeguard_scan_latency_ms`
- **Test:** `tests/integration/safeguard-pool-failover.test.ts`
- **Review Gates:** Gate 6, Gate 8
- **Go / No-Go Threshold:** p95 scan latency within budget; no single-worker dependency
- **Current Status:** Open

### R-009 — Ledger Partition Contention

- **Severity:** High
- **Owner:** Storage / Runtime
- **Why it remains open:** Per-rig partitioning reduces contention but may still bottleneck within a hot rig.
- **How to detect it:** Parallel same-rig and cross-rig append tests.
- **Metric / Alert:** `ledger_lock_wait_ms`
- **Test:** `tests/integration/ledger-partitioning.test.ts`
- **Review Gates:** Gate 6, Gate 8
- **Go / No-Go Threshold:** p95 lock wait <= 25ms under expected rig load
- **Current Status:** Open

### R-010 — Playbook Freshness Drift

- **Severity:** Medium
- **Owner:** Routing / Historian
- **Why it remains open:** High historical success may hide recent regressions or changed environments.
- **How to detect it:** Replay stale playbook scenarios with recent witness rejections and safeguard hits.
- **Metric / Alert:** stale playbook bypass count
- **Test:** `tests/integration/playbook-freshness.test.ts`
- **Review Gates:** Gate 2, Gate 4, Gate 8
- **Go / No-Go Threshold:** stale playbooks are advisory-only
- **Current Status:** Open
