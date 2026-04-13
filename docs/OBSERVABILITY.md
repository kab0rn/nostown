# NOS Town Observability & Metrics

To ensure the reliability and performance of the NOS Town multi-agent system, we implement a comprehensive observability strategy based on the three pillars: Metrics, Tracing, and Logging.

## 1. Metrics Strategy

NOS Town agents and infrastructure components export metrics via OpenTelemetry (OTel) to a centralized Prometheus/Grafana stack.

### Key Performance Indicators (KPIs)

| Metric | Type | Description | Alert Threshold |
|---|---|---|---|
| `bead_throughput` | Counter | Total beads resolved per minute | < 5 (sustained) |
| `bead_latency_ms` | Histogram | Time from assignment to resolution | > 60s (P95) |
| `polecat_stall_rate` | Gauge | % of Polecats in stalled state | > 10% |
| `witness_approval_rate` | Gauge | % of PRs approved by Witness council | < 70% |
| `kg_retrieval_latency` | Histogram | Time for KG query | > 500ms |
| `kg_write_latency_ms` | Histogram | Time for KG triple write | > 50ms (P95) |
| `groq_api_error_rate` | Counter | 429/5xx errors from Groq API | > 5% |
| `convoy_delivery_failure` | Counter | Messages failing signature/seq check | > 0 (Immediate) |
| `convoy_authz_denied_total` | Counter | Signed messages rejected by sender/type authorization | > 0 (Immediate) |
| `mayor_heartbeat_gap_ms` | Gauge | Time since last Mayor heartbeat | > 180000 |
| `orphan_workflow_count` | Gauge | Workflows with active beads and no Mayor heartbeat | > 0 (Immediate) |
| `safeguard_queue_depth` | Gauge | Pending diff scans waiting for a Safeguard worker | > 20 |
| `safeguard_scan_latency_ms` | Histogram | Time to scan and return verdict for a diff | > 1000ms (P95) |
| `ledger_lock_wait_ms` | Histogram | Time waiting on per-rig ledger lock | > 25ms (P95) |
| `critical_bead_starvation_count` | Counter | Critical-path beads repeatedly bypassed under load | > 0 (Sustained) |

### Dashboard: Swarm Health Overview

- **Row 1: Throughput & Latency** (Bead completion rate vs. target)
- **Row 2: Agent Status** (Count of Idle vs. Busy vs. Stalled Polecats)
- **Row 3: Quality Control** (Witness approval trend, Safeguard lockdown count)
- **Row 4: Infrastructure** (Groq API health, KG SQLite size)
- **Row 5: Control Plane** (Mayor heartbeat gap, orphan workflows, convoy authz failures)
- **Row 6: Write Path** (KG write latency, Safeguard queue depth, ledger lock wait)

---

## 2. Distributed Tracing

We use OpenTelemetry tracing to track the lifecycle of a **Convoy** as it flows through multiple agents.

### Trace Context Propagation

Every convoy carries a `trace_id` and `span_id` in its header:

```json
{
  "header": {
    "sender_id": "mayor_01",
    "trace_id": "8e42...f2a",
    "parent_span_id": "0f2a...12b"
  },
  "payload": { ... }
}
```

### Trace Stages

1. **Mayor Plan**: Root span for a task decomposition
2. **Convoy Dispatch**: Span for message transport
3. **Polecat Execution**: Child span for Micro-Bead resolution
4. **Witness Review**: Child span for council deliberation
5. **Historian Mine**: Final span for pattern classification

---

## 3. Logging & Audit Trails

### Structured Logging

All agents MUST log in JSON format to `stdout`, which is then captured by the NOS Town logging sidecar.

```json
{
  "timestamp": "2026-04-09T01:23:45.678Z",
  "level": "INFO",
  "role": "Polecat",
  "agent_id": "polecat_7f3b",
  "trace_id": "8e42...f2a",
  "event": "BEAD_STARTED",
  "bead_id": "bead_xyz",
  "message": "Starting refactor of auth-migration"
}
```

### Audit Logging (KG `historical` triples + audit dir)

Sensitive operations MUST be recorded as permanent audit logs — either as KG `historical` triples (for queryable events) or as append-only JSON files in `nos/audit/`:

- **Safeguard LOCKDOWN**: Pattern found, context, and duration
- **Witness Council Vote**: Individual judge scores and reasoning
- **Model Promotion/Demotion**: KG triple reference and reason
- **Convoy Signature Failure**: Quarantined payload and sender identity
- **Convoy Authorization Failure**: Signed payload type denied for sender role
- **Mayor Adoption Event**: orphan workflow adoption, prior checkpoint, replay outcome

---

## 4. Alerting & SLIs

### Service Level Indicators (SLIs)

- **Availability**: % of successful Groq API calls (Target: 99.9%)
- **Latency**: 95th percentile bead resolution time (Target: < 90s)
- **Integrity**: % of convoys passing signature/seq validation (Target: 100%)
- **Control-plane continuity**: % of active workflows with a live Mayor owner (Target: 100%)
- **Write-path health**: % of KG + ledger writes under latency budget (Target: 99%)

### Alerting Tiers

1. **P0 (Critical)**: `PROVIDER_EXHAUSTED`, `CONVOY_SIGNATURE_FAILURE`, `CONVOY_AUTHZ_DENIED`, `LOCKDOWN_TRIGGERED`, `ORPHAN_WORKFLOW_COUNT > 0`
2. **P1 (High)**: `POLECAT_STALL_RATE > 15%`, `BEAD_LATENCY > 300s`, `KG_WRITE_LATENCY_MS P95 > 200`, `SAFEGUARD_QUEUE_DEPTH > 50`
3. **P2 (Warning)**: `GROQ_API_429_RATE > 10%`, `KG_RETRIEVAL_LATENCY > 1s`, `LEDGER_LOCK_WAIT_MS P95 > 25`, `CRITICAL_BEAD_STARVATION_COUNT > 0`

---

## 5. Setup & Instrumentation

### OTel Collector Configuration

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:

exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
  logging:
    loglevel: debug

service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheus, logging]
```

### Agent Instrumentation (Node.js)

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('nos-town-agent');
const beadCounter = meter.createCounter('bead_throughput');

export function logBeadCompletion(role: string) {
  beadCounter.add(1, { role });
}
```
