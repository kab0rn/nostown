# NOS Town — Remaining Implementation Plan

> Internal runway note: this plan covers deeper legacy/future runtime wiring.
> It does not redefine the current public surface. The active product spine is
> `nt` Queen UX, `nt gascity ...` JSON bridge adapter, and static Gas City
> integration through `city.toml` only.

Derived from the gap analysis against the product vision (see `docs/` specs). Items are ordered by priority: operational blockers first, then architectural violations, then polish. Each item states current state, exact change required, and acceptance criteria.

**Baseline:** 494 tests passing, typecheck clean, all hardening invariants have green tests. The infrastructure layer (Ledger, KG, Groq failover, Convoy signing, Safeguard pool, Heartbeat, Hooks, Swarm) is complete. The gaps are in runtime wiring and the Historian→Mayor feedback loop.

---

## P1 — Agent Worker Loop (`src/index.ts`)

### Current state

`Mayor.orchestrate()` decomposes tasks and writes `BEAD_DISPATCH` convoys to `rigs/{rig}/mailboxes/polecat/inbox/` via `ConvoyBus.send()`. Nothing reads those mailboxes. Polecats, Witnesses, and the Safeguard pool are never instantiated at runtime. The full execution pipeline exists as tested components with no runtime glue.

### What to build

A `WorkerRuntime` class (new file: `src/runtime/worker-loop.ts`) that:

1. Instantiates a `SafeguardPool` (size from `SAFEGUARD_POOL_SIZE` env, default 2)
2. Instantiates N `Polecat` workers (size from `NOS_POLECAT_COUNT` env, default 4), each wired to the SafeguardPool
3. Instantiates a `Witness` instance
4. Runs a polling loop (interval from `NOS_POLL_INTERVAL_MS` env, default `500`) calling `ConvoyBus.processInbox()` for `polecat`, `witness`, `safeguard`, and `mayor` roles
5. Routes processed convoys to handlers:

```typescript
// src/runtime/worker-loop.ts

export interface WorkerRuntimeConfig {
  rigName: string;
  groqApiKey?: string;
  kgPath?: string;
  polecatCount?: number;       // default: 4
  safeguardPoolSize?: number;  // default: 2
  pollIntervalMs?: number;     // default: 500
  onEvent?: (event: HeartbeatEvent) => void;
}

export class WorkerRuntime {
  async start(): Promise<void>;
  async stop(): Promise<void>;
  // processOnce() — single poll cycle, for testing
  async processOnce(): Promise<{ polecatProcessed: number; mayorProcessed: number }>;
}
```

**Convoy routing in the handler:**

| `convoy.payload.type` | Handler |
|---|---|
| `BEAD_DISPATCH` | Pick a free Polecat, call `polecat.execute(bead, context)` |
| `BEAD_STATUS` | Write bead status update to Ledger |
| `PATCH_READY` | Route to Witness if `bead.witness_required`, else mark SUCCESS |
| `REVIEW_VERDICT` | If rejected and threshold met, call `Mayor.escalateToRefinery()` |
| `SECURITY_VIOLATION` | Mark bead failed, emit `LOCKDOWN_BROADCAST` to mayor inbox |
| `WRITE_APPROVED` | Mark bead done, append SUCCESS to Ledger |
| `WRITE_REJECTED` | Mark bead failed, append FAILURE to Ledger |

**Polecat worker pool** — maintain a free/busy set. If all polecats are busy, leave the BEAD_DISPATCH convoy in the inbox (it will be processed on the next poll). The `ConvoyBus.inboxCount()` backpressure check in `Mayor.orchestrate()` already handles this.

**Wire into `src/index.ts`:**

```typescript
// In main(), after Mayor is constructed:
const runtime = new WorkerRuntime({
  rigName: RIG_NAME,
  groqApiKey: GROQ_API_KEY,
  polecatCount: Number(process.env.NOS_POLECAT_COUNT ?? 4),
  safeguardPoolSize: Number(process.env.SAFEGUARD_POOL_SIZE ?? 2),
  onEvent: heartbeatHandler,
});
await runtime.start();
// ... in finally: await runtime.stop();
```

### Acceptance criteria

- New integration test: `tests/integration/worker-loop.test.ts`
  - Mayor orchestrates a task → runtime processes it → Ledger shows bead `done`/`failed`
  - SECURITY_VIOLATION from Safeguard flows back to Mayor and marks bead failed
  - If all polecats busy, convoy remains in inbox until next poll

---

## P2 — Mayor Queries KG for Playbooks Before Decompose

### Current state

`Mayor.orchestrate()` calls `decompose(task, '', '', undefined)` at `mayor.ts:154`. The `RoutingDispatcher.dispatch()` checks `ctx.playbookHit?.model_hint` at `dispatch.ts:83` but `playbookHit` is always `undefined`. The Historian correctly writes `has_playbook` triples but they are never consumed. The Freshness Guard from ROUTING.md §Playbook Freshness Guard is not enforced anywhere.

### What to build

**Step 1 — KG playbook query.** Add to `KnowledgeGraph` (`src/kg/index.ts`):

```typescript
/**
 * Find the most recent playbook triple for a task type on a rig.
 * Returns { playbookId, successRate, sampleSize, stack } or null.
 */
queryPlaybook(taskType: string, rigName: string, asOf?: string): {
  playbookId: string;
  successRate: number;
  sampleSize: number;
  stack?: string;
} | null
```

Implementation: query `SELECT * FROM triples WHERE relation = 'has_playbook' AND subject = 'rig_{rigName}' AND object LIKE 'playbook_{taskType}_%'` filtered by active validity window, return highest `success_rate` from metadata.

**Step 2 — Freshness Guard in RoutingDispatcher.** Add to `src/routing/dispatch.ts`:

```typescript
/**
 * Enforce ROUTING.md §Playbook Freshness Guard.
 * Returns true only when ALL conditions hold:
 *   - success_rate > 0.90
 *   - sample_size >= 20
 *   - no active Safeguard lockdown for this task class
 */
isPlaybookFresh(
  successRate: number,
  sampleSize: number,
  taskType: string,
): boolean
```

The lockdown check queries `this.kg.queryTriples('lockdown_*')` filtered for the task class. If any lockdown triple for this task type is active, return false.

**Step 3 — Mayor reads playbook before decompose.** In `Mayor.orchestrate()`, before `decompose()`:

```typescript
// src/roles/mayor.ts — inside orchestrate(), after cycle guard setup

// Query KG for playbook (ROUTING.md §Playbook Freshness Guard)
const playbookMeta = this.kg.queryPlaybook(task.task_type ?? 'execute', this.rigName);
let activePlaybook: PlaybookEntry | undefined;
let playbookHint = '';

if (playbookMeta && this.router.isPlaybookFresh(
  playbookMeta.successRate,
  playbookMeta.sampleSize,
  task.task_type ?? 'execute',
)) {
  // Build a minimal PlaybookEntry from the KG triple metadata
  activePlaybook = {
    id: playbookMeta.playbookId,
    title: playbookMeta.playbookId,
    task_type: task.task_type ?? 'execute',
    steps: [],
    model_hint: playbookMeta.modelHint,
    success_rate: playbookMeta.successRate,
    sample_size: playbookMeta.sampleSize,
  };
  playbookHint = `Use playbook ${playbookMeta.playbookId} (success rate: ${(playbookMeta.successRate * 100).toFixed(0)}%)`;
}

const beads = await this.decompose(task, '', playbookHint, activePlaybook);
```

Note: the Historian's `generatePlaybooks()` currently stores `{ success_rate, stack }` in metadata but not `model_hint` or `sample_size`. Update the triple write in `historian.ts` to include `model_hint: bestModel` and `sample_size: total` in metadata.

### Acceptance criteria

- `tests/unit/mayor-routing-lock.test.ts` — add test: "uses playbook model hint when playbook is fresh (>90%, ≥20 samples)"
- `tests/unit/mayor-routing-lock.test.ts` — add test: "ignores playbook when success_rate < 0.90"
- `tests/unit/mayor-routing-lock.test.ts` — add test: "ignores playbook when sample_size < 20"
- `tests/unit/mayor-routing-lock.test.ts` — add test: "ignores playbook when active lockdown for task class"
- `tests/integration/playbook-freshness.test.ts` — extend to cover round-trip: Historian writes triple → Mayor reads it → RoutingDispatcher applies hint

---

## P3 — Persist Convoy Sequence Counters

### Current state

`ConvoyBus.seqCounters` is an in-memory `Map` (`bus.ts:36`). On process restart the counter resets to 0. Any receiver that survived the restart will reject post-restart messages as replays (good), but a fresh receiver will accept any seq number, including replays from before the restart (bad). HARDENING.md §3.2: "Sequence counters are never reset."

### What to build

Persist `convoy_seq` as a KG triple on every send; restore on construction.

**`ConvoyBus` constructor change:**

```typescript
constructor(rigName: string, transportSecret?: string, kg?: KnowledgeGraph) {
  this.rigName = rigName;
  this.transportSecret = transportSecret ?? process.env.NOS_CONVOY_SECRET;
  this.kg = kg ?? new KnowledgeGraph();
  // Restore seq counters from KG on startup
  this.restoreSeqCounters();
}

private restoreSeqCounters(): void {
  const triples = this.kg.queryTriples('convoy_seq', undefined, 'last_seq');
  for (const t of triples) {
    // subject = 'convoy_seq', object = '{senderId}:{seq}'
    const [senderId, seq] = t.object.split(':');
    if (senderId && seq) {
      this.seqCounters.set(senderId, Number(seq));
    }
  }
}
```

**`ConvoyBus.send()` change** — after updating `this.seqCounters.set(sender_id, seq)`, write a KG triple:

```typescript
// Write seq to KG for persistence across restarts
const today = new Date().toISOString().slice(0, 10);
this.kg.addTriple({
  subject: 'convoy_seq',
  relation: 'last_seq',
  object: `${sender_id}:${seq}`,
  valid_from: today,
  agent_id: sender_id,
  metadata: { class: 'advisory' },
  created_at: new Date().toISOString(),
});
```

Note: Use `invalidateTriple` to supersede the previous triple for this sender before writing the new one, to keep the triples table from growing unboundedly. The KG already supports `invalidateTriple(id, validTo)`.

**Similarly, persist `last_seen_seq` for receivers** — in `ConvoyBus.send()`, before enforcing the monotonicity check, restore from KG on first access for a sender.

### Acceptance criteria

- `tests/unit/convoy-replay.test.ts` — add test: "seq counters restored from KG after ConvoyBus recreation"
- `tests/unit/convoy-replay.test.ts` — add test: "replay attack rejected even after receiver restart (KG-backed last_seen_seq)"

---

## P4 — Write AAAK Manifest to KG in `runNightly()`

### Current state

`Historian.generateAaakManifest()` is a pure transform method that is never called in `runNightly()` (`historian.ts:297`). HARDENING checklist item 21: "Historian AAAK manifest written as KG triple."

### What to build

Add one step to `runNightly()` after `recordRigWing()`:

```typescript
// src/roles/historian.ts — inside runNightly(), after recordRigWing()

// 5. Write AAAK manifest as KG triple (HARDENING.md checklist #21)
await this.recordAaakManifest(rigName, beads);
```

New private method:

```typescript
private async recordAaakManifest(rigName: string, beads: Bead[]): Promise<void> {
  const manifest = this.generateAaakManifest(beads);
  const today = new Date().toISOString().slice(0, 10);

  this.kg.addTriple({
    subject: `rig_${rigName}`,
    relation: 'aaak_manifest',
    object: `aaak_${rigName}_${today}`,
    valid_from: today,
    agent_id: this.agentId,
    metadata: {
      class: 'advisory',
      manifest,  // compressed manifest string
      bead_count: beads.length,
    },
    created_at: new Date().toISOString(),
  });
}
```

### Acceptance criteria

- Existing `tests/unit/historian-aaak.test.ts` tests the pure transform — leave as-is.
- Add test: `runNightly()` writes a triple with `relation === 'aaak_manifest'` to KG.

---

## P5 — PII Stripping on Playbook Generation Inputs

### Current state

`Historian.stripPii()` exists at `historian.ts:66` but is never called. Raw `bead.task_description` strings pass directly into `generatePlaybook()` as the `samples` array and are sent verbatim to the LLM.

### What to build

Single-line change in `generatePlaybooks()` at `historian.ts:120`:

```typescript
// Before (historian.ts:120):
const samples = beads
  .filter((b) => b.task_type === taskType && b.outcome === 'SUCCESS')
  .slice(-3)
  .map((b) => b.task_description)
  .filter(Boolean);

// After:
const samples = beads
  .filter((b) => b.task_type === taskType && b.outcome === 'SUCCESS')
  .slice(-3)
  .map((b) => b.task_description ? this.stripPii(b.task_description) : undefined)
  .filter(Boolean);
```

Also apply `stripPii` to the `bestModel` string and `taskType` before writing to KG triples (low risk but consistent with the intent).

### Acceptance criteria

- Add test to historian suite: task descriptions containing API keys or emails in samples are redacted before the inference call (mock the provider, assert the user message has `[REDACTED_KEY]` not the original key).

---

## P6 — `NOS_ROLE_KEY_DIR` Fail-Fast at Startup

### Current state

`src/index.ts:checkEnv()` only validates `GROQ_API_KEY`. `NOS_ROLE_KEY_DIR` is loaded lazily in `loadPrivateKey()` at first `dispatchBead()` call, producing a confusing error mid-operation. HARDENING.md §3.1: "startup MUST fail if no sender keys are available."

### What to build

Extend `checkEnv()` in `src/index.ts`:

```typescript
function checkEnv(): void {
  if (!process.env.GROQ_API_KEY) {
    console.error('[NOS Town] ERROR: GROQ_API_KEY environment variable is required');
    process.exit(1);
  }

  // HARDENING.md §3.1: fail fast if key directory missing or no keys present
  const keyDir = process.env.NOS_ROLE_KEY_DIR ?? 'keys';
  const agentId = process.env.NOS_AGENT_ID ?? 'mayor_01';
  const keyFile = path.resolve(keyDir, `${agentId}.key`);
  if (!fs.existsSync(keyFile)) {
    console.error(`[NOS Town] ERROR: No sender key found at ${keyFile}`);
    console.error(`  Run: npx tsx scripts/gen-keys.ts --agent ${agentId}`);
    process.exit(1);
  }
}
```

Also add a `scripts/gen-keys.ts` helper that calls `generateKeyPair()` from `src/convoys/sign.ts` for a given agent ID. This makes the first-run experience self-documenting.

### Acceptance criteria

- Add test: `checkEnv()` exits with code 1 when key file missing.
- `gen-keys.ts` script generates `.key` and `.pub` files in key directory.

---

## P7 — Wire Historian Cron in Entry Point

### Current state

`HISTORIAN_CRON` env var is documented in `.env.example` and `BUILDING.md` but no code in `src/index.ts` reads it or schedules the Historian.

### What to build

Add lightweight cron scheduling to `src/index.ts` using `node-cron` (add as dependency, it's small):

```typescript
// src/index.ts — after runtime.start()
import cron from 'node-cron';

const historianCron = process.env.HISTORIAN_CRON ?? '0 2 * * *';
if (cron.validate(historianCron)) {
  cron.schedule(historianCron, async () => {
    console.log('[NOS Town] Historian nightly run starting...');
    const historian = new Historian({
      agentId: 'historian_01',
      groqApiKey: GROQ_API_KEY,
    });
    try {
      await historian.runNightly(RIG_NAME);
    } catch (err) {
      console.error('[NOS Town] Historian run failed:', err);
    } finally {
      historian.close();
    }
  });
  console.log(`[NOS Town] Historian scheduled: ${historianCron}`);
}
```

### Acceptance criteria

- `npm install node-cron` and `npm install --save-dev @types/node-cron`
- Add test: with `HISTORIAN_CRON` set to a valid cron string, the schedule is registered without throwing.
- Manual test: `HISTORIAN_CRON='* * * * *' nt` triggers Historian within 60 seconds.

---

## P8 — CoVe Self-Critique Pass in Mayor Decompose

### Current state

`Mayor.decompose()` makes one Groq call and returns results (`mayor.ts:194`). ROLES.md §Mayor: "Mayor drafts the plan and self-critiques for dependencies before assigning to Crew."

### What to build

Add a second LLM call after the initial decompose. The second call is a focused critique that checks for missing dependency edges only — it must not re-decompose:

```typescript
// src/roles/mayor.ts — inside decompose(), after first Groq call
// Only run CoVe on plans with more than 1 bead (single-bead plans have no deps to check)
if (tempBeads.length > 1) {
  tempBeads = await this.covePass(tempBeads, task);
}
```

New private method:

```typescript
private async covePass(beads: Bead[], task: Task): Promise<Bead[]> {
  const plan = beads.map((b) => ({
    id: b.bead_id,
    type: b.task_type,
    desc: b.task_description,
    needs: b.needs,
  }));

  const params: InferenceParams = {
    role: 'mayor',
    task_type: 'cove_review',
    messages: [
      {
        role: 'system',
        content: `You are reviewing a bead plan for missing dependency edges.
Output JSON: { "corrections": [ { "bead_id": string, "add_needs": [string] } ] }
Only add missing edges — do NOT change descriptions or remove beads.
Output empty corrections array if the plan is correct.`,
      },
      {
        role: 'user',
        content: `Original goal: ${task.description}\n\nPlan:\n${JSON.stringify(plan, null, 2)}`,
      },
    ],
    temperature: 0.0,  // deterministic
    response_format: { type: 'json_object' },
  };

  try {
    const raw = await this.provider.executeInference(params);
    const parsed = JSON.parse(raw) as { corrections?: Array<{ bead_id: string; add_needs: string[] }> };
    const corrections = parsed.corrections ?? [];

    if (corrections.length === 0) return beads;

    // Apply corrections
    const beadMap = new Map(beads.map((b) => [b.bead_id, { ...b }]));
    for (const c of corrections) {
      const bead = beadMap.get(c.bead_id);
      if (bead && Array.isArray(c.add_needs)) {
        bead.needs = [...new Set([...bead.needs, ...c.add_needs.filter((id) => beadMap.has(id))])];
        beadMap.set(bead.bead_id, bead);
      }
    }

    // Re-run cycle detection after CoVe corrections
    const updated = [...beadMap.values()];
    const cycleNodes = detectCycles(updated);
    if (cycleNodes.length > 0) {
      console.warn(`[Mayor] CoVe introduced a cycle (${cycleNodes.join(' → ')}) — discarding corrections`);
      return beads;  // fall back to original plan
    }

    return updated;
  } catch (err) {
    // CoVe is best-effort — don't block dispatch on failure
    console.warn(`[Mayor] CoVe pass failed: ${String(err)} — proceeding with original plan`);
    return beads;
  }
}
```

Key design choices:
- `temperature: 0.0` for determinism
- Failures are non-fatal (best-effort, warn and continue)
- CoVe corrections that introduce cycles are silently discarded
- Only run on multi-bead plans

### Acceptance criteria

- `tests/unit/mayor-checkpoint.test.ts` — add test: CoVe adds missing edge when second call returns a correction
- `tests/unit/mayor-checkpoint.test.ts` — add test: CoVe failure is non-fatal; original plan returned
- `tests/unit/mayor-checkpoint.test.ts` — add test: CoVe correction that would create cycle is discarded

---

## P9 — Safeguard 500ms Async Window for Mayor→Polecat Dispatch

### Current state

Safeguard runs synchronously inside `Polecat.execute()` after the bead is already being processed. HARDENING.md §3.3: "Safeguard runs asynchronously (fire-and-monitor) for Mayor→Polecat convoys, with a 500ms window to raise a LOCKDOWN before execution begins."

### What to build

The intercept point belongs in the `WorkerRuntime` convoy handler (P1), not in Polecat itself. When handling a `BEAD_DISPATCH` convoy from Mayor:

```typescript
// src/runtime/worker-loop.ts — in the BEAD_DISPATCH handler

// 1. Fire Safeguard scan on the payload asynchronously
const scanPromise = this.safeguardPool.scan(JSON.stringify(beadPayload));

// 2. Race against 500ms window
const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 500));
const earlyResult = await Promise.race([scanPromise, timeoutPromise]);

if (earlyResult !== null && !earlyResult.approved) {
  // LOCKDOWN raised within the window — block dispatch
  await this.emitLockdown(bead, earlyResult);
  return;
}

// 3. Dispatch to Polecat — Safeguard scan continues in background
// The Polecat's own safeguard.scan() in execute() covers the result diff;
// this intercept covers the payload/prompt before execution starts.
const polecat = this.claimFreePolecat();
if (!polecat) { /* re-queue */ return; }

// If early scan didn't finish, it completes in background — monitor it
void scanPromise.then((result) => {
  if (!result.approved) {
    this.emitLockdownBroadcast(bead.bead_id, result);
  }
});

await polecat.execute(bead, context);
```

This exactly matches the spec: fire-and-monitor, 500ms window, non-blocking on timeout.

### Acceptance criteria

- `tests/integration/polecat-safeguard-e2e.test.ts` — add test: Safeguard LOCKDOWN within 500ms blocks Polecat from starting
- `tests/integration/polecat-safeguard-e2e.test.ts` — add test: if scan takes > 500ms, Polecat starts and the scan continues in background; LOCKDOWN still emitted if scan later fires

---

## P10 — Historian Uses Batch API for Playbook Synthesis

### Current state

`Historian.generatePlaybooksSequential()` calls `this.provider.executeInference()` one-by-one for each eligible task type (`historian.ts:155`). `src/groq/batch.ts` (`GroqBatchClient`) is fully implemented but unused by Historian.

### What to build

Replace `generatePlaybooksSequential()` with a batch path using `GroqBatchClient`:

```typescript
// src/roles/historian.ts

import { GroqBatchClient, BatchRequest } from '../groq/batch.js';

private async generatePlaybooksBatch(
  eligible: EligibleCtx[],
): Promise<Array<{ ctx: EligibleCtx; playbook: PlaybookEntry | null }>> {
  const client = new GroqBatchClient(process.env.GROQ_API_KEY);

  const requests: BatchRequest[] = eligible.map((ctx) => ({
    custom_id: ctx.taskType,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model: 'llama-3.3-70b-versatile',  // 70B for playbook quality
      messages: [
        {
          role: 'system',
          content: 'Generate a concise playbook for a task type. Output JSON: { "title": string, "steps": [string], "tips": [string] }',
        },
        {
          role: 'user',
          content: `Task type: ${ctx.taskType}\nBest model: ${ctx.bestModel}\nExample tasks:\n${ctx.samples.join('\n')}`,
        },
      ],
      temperature: 0.3,
    },
  }));

  const jobId = await client.createBatch(requests);
  const results = await client.pollBatch(jobId);

  return eligible.map((ctx) => {
    const result = results.find((r) => r.custom_id === ctx.taskType);
    if (!result || result.error || !result.response?.body?.choices?.[0]) {
      return { ctx, playbook: null };
    }
    try {
      const raw = result.response.body.choices[0].message.content;
      const parsed = JSON.parse(raw) as { title?: string; steps?: string[] };
      return {
        ctx,
        playbook: {
          id: uuidv4().slice(0, 8),
          title: String(parsed.title ?? ctx.taskType),
          task_type: ctx.taskType,
          steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : [],
          model_hint: ctx.bestModel,
          created_at: new Date().toISOString(),
        },
      };
    } catch {
      return { ctx, playbook: null };
    }
  });
}
```

Switch `generatePlaybooks()` to call `generatePlaybooksBatch()` when there are 2+ eligible task types (batch makes sense at scale), and fall back to `generatePlaybooksSequential()` for a single task type (batch overhead isn't worth it for 1 request).

### Acceptance criteria

- `tests/unit/groq-batch.test.ts` — existing batch tests should still pass
- Add test: `Historian.runNightly()` with multiple eligible task types calls `GroqBatchClient.createBatch()` (mock the batch client)
- Add test: single eligible task type takes the sequential path, not batch

---

## P11 — RoutingDispatcher KG Lookup Uses All Registered Models

### Current state

`queryKgLock()` and `queryKgDemotion()` iterate only `Object.values(COMPLEXITY_MODELS)` — four models (`dispatch.ts:123`). KG triples for models not in that set (e.g., `qwen/qwen3-32b` promoted by Historian for a security task) are never found.

### What to build

Replace the forward iteration with a reverse lookup using the KG's existing bidirectional `queryEntity()` method:

```typescript
// src/routing/dispatch.ts

private queryKgLock(taskType: string): string | null {
  const today = new Date().toISOString().slice(0, 10);

  // Reverse lookup: find any model with locked_to → taskType active today
  // KG.queryEntity() returns triples where subject OR object = entity
  const triples = this.kg.queryEntity(taskType, today)
    .filter((t) => t.relation === 'locked_to');

  if (triples.length === 0) return null;

  // Return the most recently written lock (DESC valid_from already handled by queryEntity)
  return triples[0].subject;
}

private queryKgDemotion(taskType: string): string | null {
  const today = new Date().toISOString().slice(0, 10);

  const triples = this.kg.queryEntity(taskType, today)
    .filter((t) => t.relation === 'demoted_from');

  return triples.length > 0 ? triples[0].subject : null;
}
```

`KnowledgeGraph.queryEntity()` already queries `WHERE subject = @entity OR object = @entity` (`kg/index.ts:176`), so no KG changes needed.

### Acceptance criteria

- `tests/unit/routing-dispatch.test.ts` — add test: KG lock for a model not in `COMPLEXITY_MODELS` is respected
- `tests/unit/routing-dispatch.test.ts` — add test: KG demotion for an arbitrary model name is respected

---

## P12 — Safeguard Rules Loaded from JSONL File

### Current state

`BUILTIN_RULES` is a hardcoded TypeScript array in `safeguard.ts:27`. Adding a rule requires redeployment. `getOrLoadRules()` has TTL-based caching structure that implies file-based loading was intended.

### What to build

**1. Create `src/hardening/safeguard-rules.jsonl`:**

```jsonl
{"id":"secret_hardcoded","severity":"critical","name":"Hardcoded Secret","pattern":"(?:password|secret|api_key|apikey|token|credential)\\s*[:=]\\s*['\"][^'\"]{8,}['\"]","description":"Hardcoded secret or credential detected"}
{"id":"eval_usage","severity":"critical","name":"eval() Usage","pattern":"\\beval\\s*\\(","description":"eval() usage detected — arbitrary code execution risk"}
{"id":"shell_injection","severity":"high","name":"Shell Metacharacters","pattern":"(?:exec|execSync|spawn|spawnSync|shell\\.exec)\\s*\\([^)]*(?:\\$\\{|`|\\||\\;|&&|\\|\\|)","description":"Potential shell metacharacter injection"}
{"id":"sql_injection","severity":"high","name":"SQL Injection Risk","pattern":"(?:query|execute)\\s*\\(\\s*[`'\"][^`'\"]*\\$\\{","description":"Possible SQL injection via string interpolation"}
{"id":"private_key_pattern","severity":"critical","name":"Private Key Material","pattern":"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----","description":"Private key material in diff"}
{"id":"env_secret_leak","severity":"high","name":"Environment Secret in Output","pattern":"process\\.env\\.[A-Z_]*(?:SECRET|PASSWORD|KEY|TOKEN)","description":"Environment secret variable directly output or logged"}
```

**2. Update `getOrLoadRules()` in `safeguard.ts`:**

```typescript
const RULES_FILE = process.env.NOS_SAFEGUARD_RULES ?? 'src/hardening/safeguard-rules.jsonl';

function getOrLoadRules(ttlMs: number): SecurityRule[] {
  const now = Date.now();
  if (rulesetCache && now - rulesetCache.loadedAt < ttlMs) {
    return rulesetCache.rules;
  }

  let rules = BUILTIN_RULES; // fallback
  try {
    if (fs.existsSync(RULES_FILE)) {
      rules = fs.readFileSync(RULES_FILE, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const r = JSON.parse(l) as { id: string; name: string; severity: string; pattern: string; description: string };
          return { ...r, severity: r.severity as SecurityRule['severity'], pattern: new RegExp(r.pattern) };
        });
    }
  } catch (err) {
    console.warn(`[Safeguard] Failed to load rules from ${RULES_FILE}: ${String(err)} — using built-ins`);
  }

  rulesetCache = { rules, loadedAt: now };
  return rules;
}
```

Add `NOS_SAFEGUARD_RULES` to `.env.example` as an optional override path.

### Acceptance criteria

- Add test: rules loaded from JSONL file when file exists and `NOS_SAFEGUARD_RULES` is set
- Add test: falls back to `BUILTIN_RULES` when file is missing or malformed
- Existing `safeguard-lockdown.test.ts` and `safeguard-patterns.test.ts` still pass without changes

---

## P13 — Cleanup: Stale CLAUDE.md and Dead Code

### CLAUDE.md updates

Both stale references resolved:

**1.** ✅ `CLAUDE.md` test count hardcode removed.

**2.** ✅ `nt up # Start MemPalace` removed — command no longer exists.

### Remove dead `patternsLoadedAt` state

In `src/roles/safeguard.ts`:
- Remove `let patternsLoadedAt = 0;` (line 92) — the variable is initialized but never meaningfully read or updated after the TTL bug fix.
- Remove `patternsLoadedAt = 0;` from `_resetPatternCacheForTesting()` — it has no effect.

The TTL that still exists (`PATTERNS_TTL_MS`) is used only in `getOrLoadRules()` for the *static ruleset*, not the learned patterns. That is correct and unaffected.

### Acceptance criteria

- `npm run typecheck` passes after removal (no references to `patternsLoadedAt` elsewhere).
- `tests/unit/safeguard-patterns.test.ts` still passes (it doesn't reference `patternsLoadedAt`).

---

## Dependency Graph

Items can be parallelized by stream:

```
Stream A (runtime):
  P1 (worker loop) → P9 (async safeguard window)

Stream B (feedback loop):
  P4 (AAAK to KG) → P2 (playbook query) → (P2 needed for full E2E)

Stream C (data integrity):
  P3 (seq persistence)

Stream D (small fixes — parallelizable):
  P5 (PII strip) ∥ P6 (key dir fail-fast) ∥ P7 (historian cron) ∥ P11 (KG reverse lookup) ∥ P12 (rules JSONL) ∥ P13 (cleanup)

Stream E (deeper changes):
  P8 (CoVe) — independent, can start anytime
  P10 (Batch API) — depends on P2 being done (playbook quality matters once feedback loop works)
```

P1 is the highest-leverage item: without the worker loop no real-world execution is possible. P2 unlocks the Historian→Mayor learning loop. Everything else improves correctness, cost, or robustness.

---

## New Tests Required

| File | New Tests |
|---|---|
| `tests/integration/worker-loop.test.ts` | NEW — full dispatch→execute→ledger cycle |
| `tests/unit/mayor-routing-lock.test.ts` | +4 playbook freshness guard tests |
| `tests/unit/convoy-replay.test.ts` | +2 KG-backed seq persistence tests |
| `tests/unit/historian-aaak.test.ts` | +1 AAAK manifest written to KG in runNightly |
| `tests/unit/historian-nightly.test.ts` | +1 PII stripping on samples; +1 batch path invoked for ≥2 task types |
| `tests/unit/routing-dispatch.test.ts` | +2 reverse KG lookup tests |
| `tests/unit/safeguard-patterns.test.ts` | +2 JSONL rules loading tests |
| `tests/unit/mayor-checkpoint.test.ts` | +3 CoVe pass tests |
| `tests/integration/polecat-safeguard-e2e.test.ts` | +2 500ms async window tests |

---

## Environment Variables Added by This Plan

| Variable | Required | Default | Added by |
|---|---|---|---|
| `NOS_POLECAT_COUNT` | No | `4` | P1 |
| `NOS_POLL_INTERVAL_MS` | No | `500` | P1 |
| `NOS_SAFEGUARD_RULES` | No | `src/hardening/safeguard-rules.jsonl` | P12 |

Add all three to `.env.example`.
