# NOS Town Groq Integration — Performance Engine

Groq API configuration, Batch processing, and model selection for the NOS Town multi-agent system.

---

## Overview

NOS Town is built to exploit the **sub-second inference** and **extreme throughput** of Groq's LPU™ architecture. This document provides the technical blueprints for integrating the Groq SDK, managing high-concurrency agent swarms, and utilizing the Batch API for offline synthesis.

---

## The Groq Advantage

| Feature | Groq (NOS Town) | Conventional API | System Impact |
|---------|-----------------|-----------------|---------------|
| **Latency** | ~250ms (T-TFT) | 1.5s - 3s | Enables 3-judge councils in < 5s |
| **Throughput** | 500+ tok/s | 50-80 tok/s | Rapid 8B/70B context ingestion |
| **Concurrently**| 100+ streams | 5-10 streams | Massive 32+ agent swarms |
| **Batch Cost**  | 50% Discount | 10-20% | Cheap nightly "Historian" runs |

---

## SDK Configuration (Node.js)

NOS Town uses the `groq-sdk` with a custom provider wrapper to handle **Escalation Logic** and **Rate Limit Management**.

```javascript
import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/**
 * Standard request with exponential backoff and 
 * automatic model escalation on 429/500 errors.
 */
export async function executeInference(params) {
  const { model, messages, temperature = 0.1 } = params;
  
  try {
    return await groq.chat.completions.create({
      model,
      messages,
      temperature,
      response_format: { type: 'json_object' } // Enforced for all roles
    });
  } catch (err) {
    if (err.status === 429) return handleRateLimit(params);
    throw err;
  }
}
```

---

## Model Selection Matrix

Surgical model selection is core to NOS Town's cost-efficiency.

| Tier | Model ID | Primary Use | Context Window |
|------|----------|-------------|----------------|
| **A** | `llama-3.3-70b-versatile` | Mayor, Witness, Complex Logic | 128k |
| **B** | `llama-3.1-8b-instant` | Polecat Swarms, Deacon, Dogs | 128k |
| **S** | `gpt-oss-120b` | Refinery, Critical Architecture | 128k |
| **G** | `gpt-oss-safeguard-20b` | Security/Policy Enforcement | 32k |

---

## Batch API Implementation

The **Historian** uses the Batch API to process thousands of Beads for pattern mining at half the retail cost.

### 1. Job Creation
```bash
# Upload beads_log.jsonl
curl https://api.groq.com/openai/v1/batches \
  -X POST \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -F input_file_id="file-892" \
  -F endpoint="/v1/chat/completions" \
  -F completion_window="24h"
```

### 2. Result Distillation
Once complete, the Historian pulls the output JSONL and runs a 70B-powered synthesis pass to update the Playbook Index.

---

## High-Concurrency Swarm Tactics

To manage 32+ agents (Polecats) simultaneously:

1. **Token Quotas:** Each Polecat is limited to 2,000 output tokens to prevent "runaway" inference cost.
2. **Priority Queuing:** Mayor and Witness requests skip the line; Dogs (formatting/linting) are queued for off-peak windows.
3. **Regional Routing:** NOS Town can rotate between Groq regions to maximize available TPM (Tokens Per Minute).

---

## Error Handling & Reliability

- **429 (Rate Limit):** NOS Town implements a `Wait-and-Retry` loop based on the `retry-after` header.
- **Context Blowout:** If a file exceeds 100k tokens, the Deacon is triggered to "Summarize & Prune" before the Polecat begins work.
- **Model Divergence:** If an 8B model produces malformed JSON, the system retries once with `temperature: 0` before escalating to 70B.
