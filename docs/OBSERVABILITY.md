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
| `mempalace_retrieval_latency` | Histogram | Time for semantic search/KG query | > 500ms |
| `groq_api_error_rate` | Counter | 429/5xx errors from Groq API | > 5% |
| `convoy_delivery_failure` | Counter | Messages failing signature/seq check | > 0 (Immediate) |

### Dashboard: Swarm Health Overview

- **Row 1: Throughput & Latency** (Bead completion rate vs. target)
- **Row 2: Agent Status** (Count of Idle vs. Busy vs. Stalled Polecats)
- **Row 3: Quality Control** (Witness approval trend, Safeguard lockdown count)
- **Row 4: Infrastructure** (Groq API health, MemPalace memory usage)

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

### Audit Logging (MemPalace `hall_events`)

Sensitive operations MUST be recorded as permanent audit logs in MemPalace:

- **Safeguard LOCKDOWN**: Pattern found, context, and duration
- **Witness Council Vote**: Individual judge scores and reasoning
- **Model Promotion/Demotion**: KG triple reference and reason
- **Convoy Signature Failure**: Quarantined payload and sender identity

---

## 4. Alerting & SLIs

### Service Level Indicators (SLIs)

- **Availability**: % of successful Groq API calls (Target: 99.9%)
- **Latency**: 95th percentile bead resolution time (Target: < 90s)
- **Integrity**: % of convoys passing signature/seq validation (Target: 100%)

### Alerting Tiers

1. **P0 (Critical)**: `PROVIDER_EXHAUSTED`, `CONVOY_SIGNATURE_FAILURE`, `LOCKDOWN_TRIGGERED`
2. **P1 (High)**: `POLECAT_STALL_RATE > 15%`, `BEAD_LATENCY > 300s`
3. **P2 (Warning)**: `GROQ_API_429_RATE > 10%`, `MEMPALACE_LATENCY > 1s`

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
