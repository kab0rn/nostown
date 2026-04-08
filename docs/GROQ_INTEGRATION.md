# NOS Town Groq Integration

Groq API, Batch processing, and model selection for NOS Town.

---

## Overview

NOS Town runs entirely on Groq's inference infrastructure. This document covers the Groq API integration patterns, Batch API usage, model selection rationale, and configuration reference.

---

## Why Groq

Groq's inference properties make NOS Town's architecture viable in ways that are impractical with other providers:

| Property | Groq | Typical Alternative | NOS Town Impact |
|----------|------|--------------------|-----------------|
| Latency | ~200ms | 1–3s | Councils complete in <5s |
| Throughput | 500+ tok/s | 50–100 tok/s | 20–50 parallel agents |
| Cost (8B) | ~$0.05/M tok | ~$0.20/M tok | 4× cheaper Polecats |
| Batch discount | 50% off | 10–25% | Historian runs at half cost |
| Model diversity | llama + Mistral + gpt-oss | Usually 1–2 families | Full routing table possible |
| OpenAI compat | Yes | Varies | Drop-in SDK usage |

---

## API Setup

### Installation

```bash
npm install groq-sdk
# or
pip install groq
```

### Environment

```bash
# .env
GROQ_API_KEY=gsk_...
GROQ_DEFAULT_MODEL=llama-3.3-70b-versatile
GROQ_BATCH_ENABLED=true
```

### Basic client (Node.js)

```javascript
import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function callGroq({ model, messages, maxTokens = 2048, temperature = 0.3 }) {
  const response = await groq.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  });
  return response.choices[0].message.content;
}
```

---

## Model Reference

### Tier A — High Quality

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| `llama-3.3-70b-versatile` | 128k | ~280 tok/s | Mayor, Witness, Refinery, complex Beads |
| `gpt-oss-120b` | 128k | ~180 tok/s | Architecture decisions, max quality council |

### Tier B — Fast & Cheap

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| `llama-3.1-8b-instant` | 128k | ~750 tok/s | Polecats, Deacon, Dogs, boilerplate |
| `llama-3.2-3b-preview` | 8k | ~1200 tok/s | Routing decisions, quick classifiers |

### Safeguard

| Model | Context | Best For |
|-------|---------|----------|
| `gpt-oss-safeguard-20b` | 32k | Security and policy classification |

### Batch-eligible
Any model above can be used with the Batch API. Batch jobs accept the same request format but are processed asynchronously with a 50% cost discount.

---

## Batch API Usage

The Historian and offline eval system use Groq Batch exclusively.

### Submitting a batch job

```javascript
import fs from 'fs';
import Groq from 'groq-sdk';

const groq = new Groq();

// 1. Prepare JSONL file with requests
const requests = beads.map((bead, i) => ({
  custom_id: `bead_${bead.id}`,
  method: 'POST',
  url: '/v1/chat/completions',
  body: {
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: HISTORIAN_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(bead) }
    ],
    max_tokens: 1024,
  }
}));

const jsonl = requests.map(r => JSON.stringify(r)).join('\n');
fs.writeFileSync('batch_input.jsonl', jsonl);

// 2. Upload the file
const uploadedFile = await groq.files.create({
  file: fs.createReadStream('batch_input.jsonl'),
  purpose: 'batch',
});

// 3. Create the batch job
const batch = await groq.batches.create({
  input_file_id: uploadedFile.id,
  endpoint: '/v1/chat/completions',
  completion_window: '24h',
});

console.log('Batch ID:', batch.id);
```

### Polling for completion

```javascript
async function waitForBatch(batchId) {
  while (true) {
    const batch = await groq.batches.retrieve(batchId);
    
    if (batch.status === 'completed') {
      return await downloadBatchResults(batch.output_file_id);
    }
    
    if (batch.status === 'failed') {
      throw new Error(`Batch failed: ${batch.errors}`);
    }
    
    console.log(`Batch ${batchId}: ${batch.status} (${batch.request_counts.completed}/${batch.request_counts.total})`);
    await new Promise(r => setTimeout(r, 60_000));  // poll every minute
  }
}

async function downloadBatchResults(outputFileId) {
  const fileContent = await groq.files.content(outputFileId);
  const lines = (await fileContent.text()).trim().split('\n');
  return lines.map(line => JSON.parse(line));
}
```

---

## Parallel Agent Execution

NOS Town runs multiple agents concurrently. Groq's rate limits are generous enough to support 20–50 parallel Polecats.

```javascript
// Run a swarm of Polecats in parallel
async function runPoliceCatSwarm(beads) {
  const CONCURRENCY = 8;  // max parallel agents
  const results = [];
  
  // Process in batches of CONCURRENCY
  for (let i = 0; i < beads.length; i += CONCURRENCY) {
    const batch = beads.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(bead => runPolecat(bead))
    );
    results.push(...batchResults);
  }
  
  return results;
}

async function runPolecat(bead) {
  const model = routingTable.getModel(bead.type);
  const response = await callGroq({
    model,
    messages: [
      { role: 'system', content: POLECAT_SYSTEM_PROMPT },
      { role: 'user', content: formatBeadPrompt(bead) }
    ],
    maxTokens: 4096,
    temperature: 0.2,
  });
  
  return {
    bead_id: bead.id,
    output: response,
    model_used: model,
    completed_at: new Date().toISOString(),
  };
}
```

---

## Rate Limit Management

Groq rate limits (as of 2025) for pay-as-you-go:

| Model | RPM | TPM |
|-------|-----|-----|
| llama-3.1-8b-instant | 30,000 | 131,072,000 |
| llama-3.3-70b-versatile | 6,000 | 12,288,000 |
| gpt-oss-120b | 1,000 | 6,000,000 |

### Retry logic

```javascript
async function callGroqWithRetry(params, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callGroq(params);
    } catch (error) {
      if (error.status === 429) {
        const retryAfter = parseInt(error.headers?.['retry-after'] ?? '5');
        console.log(`Rate limited. Waiting ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
      } else if (attempt === maxRetries - 1) {
        throw error;
      } else {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
}
```

---

## Structured Output

All NOS Town role responses use structured JSON output to enable reliable parsing.

```javascript
// Witness verdict — structured output
const witnessResponse = await groq.chat.completions.create({
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: witnessPrompt }],
  response_format: { type: 'json_object' },
  max_tokens: 512,
});

const verdict = JSON.parse(witnessResponse.choices[0].message.content);
// { verdict: "PASS", score: 88, reasoning: "..." }
```

---

## Cost Tracking

NOS Town tracks inference cost per Bead to feed the Historian's routing optimization.

```javascript
function calculateCost(model, usage) {
  const PRICES = {
    'llama-3.1-8b-instant':       { input: 0.05, output: 0.08 },
    'llama-3.3-70b-versatile':    { input: 0.59, output: 0.79 },
    'gpt-oss-120b':               { input: 0.90, output: 1.20 },
    'gpt-oss-safeguard-20b':      { input: 0.20, output: 0.20 },
  };
  
  const price = PRICES[model] ?? PRICES['llama-3.3-70b-versatile'];
  const inputCost = (usage.prompt_tokens / 1_000_000) * price.input;
  const outputCost = (usage.completion_tokens / 1_000_000) * price.output;
  
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    cost_usd: inputCost + outputCost,
  };
}
```

---

## Configuration Reference

```javascript
// config/groq.js
export const GROQ_CONFIG = {
  models: {
    mayor:     'llama-3.3-70b-versatile',
    polecat:   'llama-3.1-8b-instant',
    witness:   'llama-3.3-70b-versatile',
    refinery:  'gpt-oss-120b',
    deacon:    'llama-3.1-8b-instant',
    dogs:      'llama-3.1-8b-instant',
    historian: 'llama-3.3-70b-versatile',  // run via Batch
    safeguard: 'gpt-oss-safeguard-20b',
  },
  
  defaults: {
    temperature: 0.2,
    max_tokens: 4096,
    timeout_ms: 30_000,
  },
  
  batch: {
    enabled: true,
    completion_window: '24h',
    max_requests_per_file: 50_000,
  },
  
  swarm: {
    max_parallel_polecats: 8,
    concurrency_limit: 20,
  },
};
```
