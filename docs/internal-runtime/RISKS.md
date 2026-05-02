# NOS Town Known Risks Register

> Internal runway note: these risks include legacy/future role-runtime concerns.
> Bridge-path risks should be read against the current Queen + Gas City adapter
> product surface.

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

### R-002 — Mayor Orphan Workflow Replay Errors

- **Severity:** Critical
- **Owner:** Orchestration
- **Why it remains open:** Replacement Mayor logic may duplicate bead creation or replay stale mailbox state incorrectly.
- **How to detect it:** Kill Mayor after partial dispatch and verify idempotent adoption.
- **Metric / Alert:** `orphan_workflow_count`, duplicate bead IDs, ledger divergence
- **Test:** `tests/integration/mayor-adoption.test.ts`
- **Review Gates:** Gate 2, Gate 8
- **Go / No-Go Threshold:** zero duplicate bead creation; zero unreconciled active convoy on resume
- **Current Status:** MITIGATED — startup() reads existing Ledger beads (`rigs/<rig>/beads/current.jsonl`) and logs adoption without re-writing; idempotency verified by reading bead IDs before and after adoption (5 tests). MAYOR_ADOPTION audit event emitted and verified. Replacement Mayor can orchestrate new goals after adoption.

### R-003 — Forged Convoy Sender

- **Severity:** Critical
- **Owner:** Transport / Security
- **Why it remains open:** Shared transport MAC plus asymmetric sender keys must be implemented correctly to prevent sender spoofing.
- **How to detect it:** Inject messages signed with the wrong key but valid structure or valid transport MAC.
- **Metric / Alert:** `convoy_authz_denied_total`, quarantine events
- **Test:** `tests/unit/convoy-authn.test.ts`
- **Review Gates:** Gate 3, Gate 8
- **Go / No-Go Threshold:** all spoof attempts rejected
- **Current Status:** MITIGATED — Ed25519 per-role keys implemented; wrong-key signatures rejected; valid-HMAC + wrong Ed25519 key rejected; AUTHZ_MATRIX denies unauthorized payload types. Convoy quarantine and audit log wired.

### R-004 — Critical Bead Starvation

- **Severity:** High
- **Owner:** Swarm / Scheduling
- **Why it remains open:** Dependency-aware priority may still fail under mixed workloads or queue churn.
- **How to detect it:** Run mixed critical-path and low-priority workloads with inbox pressure.
- **Metric / Alert:** `critical_bead_starvation_count`
- **Test:** `tests/integration/swarm-priority.test.ts`
- **Review Gates:** Gate 3, Gate 7, Gate 8
- **Go / No-Go Threshold:** no sustained starvation for critical predecessors
- **Current Status:** MITIGATED — ConvoyBus priority-aware draining: critical_path(+100k) > fan_out_weight(*100) > priority > FIFO. 4 integration tests verify: critical before low, high fan-out before low, combined critical+high-fan leads queue, FIFO preserved within equal class.

### R-005 — KG Critical Conflict Corruption

- **Severity:** High
- **Owner:** Memory / Routing
- **Why it remains open:** Conflict-class rules may still be implemented inconsistently across writers.
- **How to detect it:** Simulate conflicting critical writes from multiple roles.
- **Metric / Alert:** conflict-pending count, invalidations by class
- **Test:** `tests/unit/kg-critical-conflict.test.ts`
- **Review Gates:** Gate 4, Gate 8
- **Go / No-Go Threshold:** critical conflicts always resolved by precedence or escalated
- **Current Status:** MITIGATED — KnowledgeGraph.resolveConflict() is class-aware: critical→role precedence, advisory→MIM, historical→append-only. KGSyncMonitor.mergeTriple() now delegates to KG.resolveConflict() (no longer applies MIM unconditionally). Verified by kg-critical-conflict.test.ts + playbook-freshness integration tests.

### R-006 — Cross-Rig Tunnel Leakage

- **Severity:** Medium
- **Owner:** Routing / Memory
- **Why it remains open:** Same room names across rigs may cause over-sharing of context or stale advice.
- **How to detect it:** Create same-room rigs with incompatible stacks and verify tunnel safety guards.
- **Metric / Alert:** tunnel advisory downgrade count
- **Test:** `tests/integration/tunnel-safety.test.ts`
- **Review Gates:** Gate 4, Gate 8
- **Go / No-Go Threshold:** incompatible tunnel hits never auto-apply
- **Current Status:** MITIGATED — checkTunnelSafety() enforces: room name match, isolation flag (hard block), stack family compatibility (advisory block), freshness window. detectStackFamily() + areStacksCompatible() verified for typescript/python/go/rust incompatibility. Integration tests: 11 assertions covering all four safety conditions.

### R-007 — Hook-Triggered Injection

- **Severity:** Critical
- **Owner:** Hooks / Security
- **Why it remains open:** Variable substitution and hook execution can reintroduce shell injection paths.
- **How to detect it:** Fuzz `{{event.*}}` substitutions and command payloads.
- **Metric / Alert:** blocked substitution count, safeguard lockdown count
- **Test:** `tests/security/hook-injection.test.ts`
- **Review Gates:** Gate 5, Gate 8
- **Go / No-Go Threshold:** zero unsafe expansions executed
- **Current Status:** MITIGATED — End-to-end pipeline: allow-list (5 paths) → sanitizeHookValue() blocks 9+ dangerous patterns → blocked values become empty string in executor. 30 fuzz tests (unit) + end-to-end security tests verify full pipeline. Zero unsafe expansions reach ActionExecutor.

### R-008 — Safeguard Pool Latency Variance

- **Severity:** High
- **Owner:** Security / Runtime
- **Why it remains open:** External model latency spikes can still create write-path bottlenecks even with pooling.
- **How to detect it:** Burst 20–50 concurrent diff scans under degraded provider conditions.
- **Metric / Alert:** `safeguard_queue_depth`, `safeguard_scan_latency_ms`
- **Test:** `tests/integration/safeguard-pool-failover.test.ts`
- **Review Gates:** Gate 6, Gate 8
- **Go / No-Go Threshold:** p95 scan latency within budget; no single-worker dependency
- **Current Status:** MITIGATED — Safeguard pool with configurable size (min 2 dev, 4 staging/prod); shared in-process ruleset cache across workers (module-level); scan latency tracked as `safeguard_scan_latency_ms` histogram; queue depth as `safeguard_queue_depth` gauge. Integration tests verify pool continues after worker loss.

### R-009 — Ledger Partition Contention

- **Severity:** High
- **Owner:** Storage / Runtime
- **Why it remains open:** Per-rig partitioning reduces contention but may still bottleneck within a hot rig.
- **How to detect it:** Parallel same-rig and cross-rig append tests.
- **Metric / Alert:** `ledger_lock_wait_ms`
- **Test:** `tests/integration/ledger-partitioning.test.ts`
- **Review Gates:** Gate 6, Gate 8
- **Go / No-Go Threshold:** p95 lock wait <= 25ms under expected rig load
- **Current Status:** MITIGATED — Per-rig ledger partitioning: separate JSONL file per rig, mutex scoped per-rig. `ledger_lock_wait_ms` histogram wired. Cross-rig writes verified non-blocking in integration tests.

### R-010 — Playbook Freshness Drift

- **Severity:** Medium
- **Owner:** Routing / Historian
- **Why it remains open:** High historical success may hide recent regressions or changed environments.
- **How to detect it:** Replay stale playbook scenarios with recent witness rejections and safeguard hits.
- **Metric / Alert:** stale playbook bypass count
- **Test:** `tests/integration/playbook-freshness.test.ts`
- **Review Gates:** Gate 2, Gate 4, Gate 8
- **Go / No-Go Threshold:** stale playbooks are advisory-only
- **Current Status:** MITIGATED — Mayor.orchestrate() checks freshness (sample_size >= 20, no recent Witness rejections, no active Safeguard lockdown) before using playbook as route-lock. KG routing locks via RoutingDispatcher verified end-to-end. Integration tests cover: KG lock, demotion, playbook shortcut, complexity fallback, DCR class-awareness.

### R-011 — Safeguard Pattern Cache Lost on Restart

- **Severity:** Low
- **Owner:** Security / Runtime
- **Why it remains open:** The Safeguard in-process pattern cache is session-local and is not persisted across process restarts. Vulnerability patterns discovered during a session are not carried to the next session.
- **How to detect it:** Restart the process after a session that triggered new pattern learning; verify next session starts from an empty cache.
- **Metric / Alert:** `safeguard_learned_patterns_count` drops to 0 on restart
- **Test:** `tests/unit/safeguard-patterns.test.ts` (`_resetPatternCacheForTesting` documents this behavior)
- **Review Gates:** Gate 6, Gate 8
- **Go / No-Go Threshold:** Acceptable — by design. The static ruleset (`src/hardening/safeguard-rules.jsonl`) covers all known critical patterns. Session-learned patterns improve recall within a session but are not relied upon for baseline safety.
- **Current Status:** ACCEPTED — Session-local cache is the intended design. If cross-session pattern persistence becomes a requirement, the mitigation is to write learned patterns to the KG at LOCKDOWN time (already done via `lockdown_{id} triggered_by {vuln_type}` triple) and reload them at startup via a KG query. Not implemented; filed here for future consideration.
