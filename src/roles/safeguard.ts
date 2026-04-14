// NOS Town — Safeguard Pool (Security Scanner)
// Per ROLES.md §Safeguard: maintains vulnerability rules and scans diffs.
// Learned patterns from LLM scans are cached in-process (session-local only).

import { GroqProvider } from '../groq/provider.js';
import { KnowledgeGraph } from '../kg/index.js';
import type { ScanResult, InferenceParams } from '../types/index.js';
import { safeguardQueueDepth, safeguardScanLatencyMs } from '../telemetry/metrics.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

export interface SafeguardConfig {
  poolSize?: number;    // minimum 2
  groqApiKey?: string;
  rulesetCacheTtlMs?: number;
  kgPath?: string;      // for writing LOCKDOWN KG triples
}

interface SecurityRule {
  id: string;
  name: string;
  severity: 'critical' | 'high' | 'medium';
  pattern: RegExp;
  description: string;
}

function getRulesFile(): string {
  return process.env.NOS_SAFEGUARD_RULES ?? 'src/hardening/safeguard-rules.jsonl';
}

// Static ruleset — cache-shared across all pool workers
const BUILTIN_RULES: SecurityRule[] = [
  {
    id: 'secret_hardcoded',
    name: 'Hardcoded Secret',
    severity: 'critical',
    pattern: /(?:password|secret|api_key|apikey|token|credential)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    description: 'Hardcoded secret or credential detected',
  },
  {
    id: 'eval_usage',
    name: 'eval() Usage',
    severity: 'critical',
    pattern: /\beval\s*\(/,
    description: 'eval() usage detected — arbitrary code execution risk',
  },
  {
    id: 'shell_injection',
    name: 'Shell Metacharacters',
    severity: 'high',
    pattern: /(?:exec|execSync|spawn|spawnSync|shell\.exec)\s*\([^)]*(?:\$\{|`|\||\;|&&|\|\|)/,
    description: 'Potential shell metacharacter injection',
  },
  {
    id: 'sql_injection',
    name: 'SQL Injection Risk',
    severity: 'high',
    pattern: /(?:query|execute)\s*\(\s*[`'"][^`'"]*\$\{/,
    description: 'Possible SQL injection via string interpolation',
  },
  {
    id: 'private_key_pattern',
    name: 'Private Key Material',
    severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
    description: 'Private key material in diff',
  },
  {
    id: 'env_secret_leak',
    name: 'Environment Secret in Output',
    severity: 'high',
    pattern: /process\.env\.[A-Z_]*(?:SECRET|PASSWORD|KEY|TOKEN)/,
    description: 'Environment secret variable directly output or logged',
  },
];

interface RulesetCache {
  rules: SecurityRule[];
  loadedAt: number;
}

// Shared ruleset cache across all pool workers
let rulesetCache: RulesetCache | null = null;

function getOrLoadRules(ttlMs: number): SecurityRule[] {
  const now = Date.now();
  if (rulesetCache && now - rulesetCache.loadedAt < ttlMs) {
    return rulesetCache.rules;
  }

  const rulesFile = getRulesFile();
  let rules = BUILTIN_RULES;
  try {
    if (fs.existsSync(rulesFile)) {
      rules = fs.readFileSync(rulesFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const r = JSON.parse(l) as { id: string; name: string; severity: string; pattern: string; flags?: string; description: string };
          return { ...r, severity: r.severity as SecurityRule['severity'], pattern: new RegExp(r.pattern, r.flags ?? '') };
        });
    }
  } catch (err) {
    console.warn(`[Safeguard] Failed to load rules from ${rulesFile}: ${String(err)} — using built-ins`);
    rules = BUILTIN_RULES;
  }

  rulesetCache = { rules, loadedAt: now };
  return rulesetCache.rules;
}

/** Cached learned vulnerability patterns (shared across workers in-process, session-local) */
let learnedPatterns: string[] = [];

/**
 * Whether to persist learned patterns to KG for cross-session survival (Enh 3.1).
 * Must be explicitly enabled via NOS_SAFEGUARD_PERSIST_PATTERNS=true (default: false).
 * Keeping it opt-in preserves test isolation: existing tests that rely on
 * _resetPatternCacheForTesting() are unaffected because KG reads are skipped.
 */
function shouldPersistPatterns(): boolean {
  return process.env.NOS_SAFEGUARD_PERSIST_PATTERNS === 'true';
}

/** Reset the in-process pattern cache — for testing only. */
export function _resetPatternCacheForTesting(): void {
  learnedPatterns = [];
}

/** Reset the ruleset cache — for testing only. */
export function _resetRulesetCacheForTesting(): void {
  rulesetCache = null;
}

export class SafeguardWorker {
  private workerId: string;
  private provider: GroqProvider;
  private kg: KnowledgeGraph;
  private rulesetCacheTtlMs: number;

  constructor(workerId: string, groqApiKey?: string, rulesetCacheTtlMs = 300_000, kgPath?: string) {
    this.workerId = workerId;
    this.provider = new GroqProvider(groqApiKey);
    this.kg = new KnowledgeGraph(kgPath);
    this.rulesetCacheTtlMs = rulesetCacheTtlMs;
  }

  close(): void {
    this.kg.close();
  }

  /**
   * Return learned vulnerability patterns.
   * When NOS_SAFEGUARD_PERSIST_PATTERNS=true (default): reads KG-persisted patterns (cross-session)
   * merged with in-process cache. In test environments set NOS_SAFEGUARD_PERSIST_PATTERNS=false
   * to keep patterns session-local.
   */
  private loadLearnedPatterns(): string[] {
    if (!shouldPersistPatterns()) return learnedPatterns;
    // Load KG-persisted patterns (survive restarts) (Enh 3.1)
    try {
      const today = new Date().toISOString().slice(0, 10);
      const triples = this.kg.queryTriples('safeguard_patterns', today, 'learned_vuln_pattern');
      const kgPatterns = triples.map((t) => t.object).filter((p) => !learnedPatterns.includes(p));
      return [...learnedPatterns, ...kgPatterns];
    } catch {
      return learnedPatterns;
    }
  }

  /**
   * Persist a newly discovered vulnerability pattern.
   * Always updates in-process cache; also writes KG triple when
   * NOS_SAFEGUARD_PERSIST_PATTERNS=true (default) for cross-session survival (Enh 3.1).
   */
  private cachePattern(rule: string, detail: string): void {
    const patternKey = `vuln-pattern:${rule}: ${detail}`;
    if (!learnedPatterns.includes(patternKey)) {
      learnedPatterns.push(patternKey);
    }
    if (!shouldPersistPatterns()) return;
    // Persist to KG so pattern survives restarts (Enh 3.1)
    try {
      const today = new Date().toISOString().slice(0, 10);
      this.kg.addTriple({
        subject: 'safeguard_patterns',
        relation: 'learned_vuln_pattern',
        object: patternKey,
        valid_from: today,
        agent_id: this.workerId,
        metadata: { class: 'advisory', rule, detail },
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[SafeguardWorker:${this.workerId}] Pattern KG write failed: ${String(err)}`);
    }
  }

  /**
   * Scan a diff for security violations.
   * @param diff - The code diff or content to scan.
   * @param taskType - Optional task class (e.g. 'security', 'auth') written to the lockdown KG
   *   triple so hasActiveLockdown() can filter per-task-class rather than globally.
   */
  async scan(diff: string, taskType?: string): Promise<ScanResult> {
    const rules = getOrLoadRules(this.rulesetCacheTtlMs);
    const violations: ScanResult['violations'] = [];

    // Static rule check
    for (const rule of rules) {
      if (rule.pattern.test(diff)) {
        violations.push({
          rule: rule.id,
          severity: rule.severity,
          detail: rule.description,
        });
      }
    }

    // If any critical violations found statically, trigger LOCKDOWN immediately
    const hasCritical = violations.some((v) => v.severity === 'critical');
    if (hasCritical) {
      const lockdown = this.emitLockdown(violations.filter((v) => v.severity === 'critical'), taskType);
      return { approved: false, violations, lockdown };
    }

    // Load learned patterns from prior scans (in-process cache)
    const knownPatterns = this.loadLearnedPatterns();

    // LLM-based semantic check for subtler issues
    const newViolations: ScanResult['violations'] = [];
    try {
      const llmCheck = await this.llmScan(diff, knownPatterns);
      for (const v of llmCheck) {
        // Avoid duplicating static detections
        if (!violations.find((existing) => existing.rule === v.rule)) {
          violations.push(v);
          newViolations.push(v);
        }
      }
    } catch (err) {
      console.warn(`[SafeguardWorker:${this.workerId}] LLM scan failed (static rules still apply): ${String(err)}`);
    }

    // Cache newly discovered patterns for this session
    for (const v of newViolations) {
      if (v.severity === 'critical' || v.severity === 'high') {
        this.cachePattern(v.rule, v.detail);
      }
    }

    const criticalFromLlm = violations.filter((v) => v.severity === 'critical');
    const approved = violations.filter((v) => v.severity === 'critical' || v.severity === 'high').length === 0;

    if (criticalFromLlm.length > 0) {
      const lockdown = this.emitLockdown(criticalFromLlm, taskType);
      return { approved: false, violations, lockdown };
    }

    return { approved, violations };
  }

  /**
   * Emit LOCKDOWN signal: write KG triple and log hard stop.
   * Per ROLES.md §Safeguard: every LOCKDOWN written as KG triple.
   * The task_type is stored in metadata so hasActiveLockdown() can filter per task class.
   */
  private emitLockdown(criticalViolations: ScanResult['violations'], taskType?: string): ScanResult['lockdown'] {
    const lockdownId = `lockdown_${uuidv4().slice(0, 8)}`;
    const reason = criticalViolations.map((v) => v.rule).join(', ');
    const today = new Date().toISOString().slice(0, 10);

    console.error(`[SafeguardWorker:${this.workerId}] *** LOCKDOWN TRIGGERED *** ${lockdownId}: ${reason}`);

    // Write KG triple: lockdown_{id} → triggered_by → {vuln_type} (ROLES.md §Safeguard step 4)
    // task_type in metadata enables task-class-scoped lockdown queries by the routing dispatcher.
    try {
      this.kg.addTriple({
        subject: lockdownId,
        relation: 'triggered_by',
        object: reason,
        valid_from: today,
        agent_id: this.workerId,
        metadata: {
          class: 'critical',
          ...(taskType ? { task_type: taskType } : {}),
          violations: criticalViolations.map((v) => ({ rule: v.rule, detail: v.detail })),
        },
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[SafeguardWorker:${this.workerId}] LOCKDOWN KG write failed: ${String(err)}`);
    }

    return { triggered: true, reason, lockdown_id: lockdownId };
  }

  private async llmScan(diff: string, knownPatterns: string[]): Promise<ScanResult['violations']> {
    const patternContext = knownPatterns.length > 0
      ? `\nKnown vulnerability patterns from prior scans (apply extra scrutiny):\n${knownPatterns.slice(0, 10).join('\n')}`
      : '';

    const params: InferenceParams = {
      role: 'safeguard',
      task_type: 'security_scan',
      messages: [
        {
          role: 'system',
          content: `You are a security scanner. Analyze this code diff for security issues.
Output JSON: { "violations": [{ "rule": "<id>", "severity": "critical|high|medium", "detail": "<description>" }] }
Focus on: secrets, eval/exec, injection risks, auth bypass, insecure crypto.
If no issues found, return { "violations": [] }.${patternContext}`,
        },
        { role: 'user', content: `Scan this diff:\n${diff.slice(0, 8000)}` },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    };

    const raw = await this.provider.executeInference(params);
    const parsed = JSON.parse(raw) as { violations?: Array<{ rule?: string; severity?: string; detail?: string }> };
    return (parsed.violations ?? []).map((v) => ({
      rule: String(v.rule ?? 'llm_detected'),
      severity: (['critical', 'high', 'medium'].includes(v.severity ?? '') ? v.severity : 'medium') as 'critical' | 'high' | 'medium',
      detail: String(v.detail ?? ''),
    }));
  }
}

interface ScanQueueEntry {
  diff: string;
  /** Higher number = higher priority. critical_path beads use 10; default is 0. */
  priority: number;
  /** Task class for lockdown KG metadata (enables per-task-class lockdown filtering). */
  taskType?: string;
  /** Number of worker failures for this entry — reject after exhausting pool. */
  failCount: number;
  resolve: (result: ScanResult) => void;
  reject: (err: unknown) => void;
}

export class SafeguardPool {
  private workers: SafeguardWorker[];
  private availableWorkers: SafeguardWorker[];
  /** Priority queue: sorted descending by priority on insertion */
  private queue: ScanQueueEntry[] = [];

  constructor(config: SafeguardConfig = {}) {
    const size = Math.max(2, config.poolSize ?? 2); // minimum 2 workers
    this.workers = Array.from({ length: size }, (_, i) =>
      new SafeguardWorker(
        `safeguard_${i}`,
        config.groqApiKey,
        config.rulesetCacheTtlMs,
        config.kgPath,
      ),
    );
    this.availableWorkers = [...this.workers];

    // Wire safeguardQueueDepth observable gauge to this pool
    safeguardQueueDepth.addCallback((result) => {
      result.observe(this.queue.length);
    });
  }

  /**
   * Scan a diff, queuing if all workers are busy.
   * @param priority Higher = higher priority; critical_path beads should pass 10.
   * @param taskType Optional task class forwarded to the lockdown KG triple.
   */
  scan(diff: string, priority = 0, taskType?: string): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const entry: ScanQueueEntry = { diff, priority, taskType, failCount: 0, resolve, reject };
      this.enqueue(entry);
      this.dispatch();
    });
  }

  private enqueue(entry: ScanQueueEntry): void {
    // Insert in descending priority order (higher priority → earlier position)
    let i = 0;
    while (i < this.queue.length && this.queue[i].priority >= entry.priority) {
      i++;
    }
    this.queue.splice(i, 0, entry);
  }

  private dispatch(): void {
    while (this.availableWorkers.length > 0 && this.queue.length > 0) {
      const worker = this.availableWorkers.shift()!;
      const entry = this.queue.shift()!;
      this.runEntry(worker, entry);
    }
  }

  private runEntry(worker: SafeguardWorker, entry: ScanQueueEntry): void {
    const start = Date.now();
    worker.scan(entry.diff, entry.taskType).then(
      (result) => {
        safeguardScanLatencyMs.record(Date.now() - start);
        this.availableWorkers.push(worker);
        entry.resolve(result);
        this.dispatch();
      },
      (err: unknown) => {
        console.warn(`[SafeguardPool] Worker failed: ${String(err)}`);
        entry.failCount++;
        // Return the failed worker to the pool
        this.availableWorkers.push(worker);

        if (entry.failCount >= this.workers.length) {
          // All workers have been tried — give up
          entry.reject(new Error(`SafeguardPool: all ${this.workers.length} workers exhausted`));
        } else if (this.availableWorkers.length > 0) {
          // Retry immediately with a different worker
          const nextWorker = this.availableWorkers.shift()!;
          this.runEntry(nextWorker, entry);
        } else {
          // No workers currently free — requeue at front (max priority)
          entry.priority = Number.MAX_SAFE_INTEGER;
          this.enqueue(entry);
        }
        this.dispatch();
      },
    );
  }

  get workerCount(): number {
    return this.workers.length;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  close(): void {
    for (const worker of this.workers) {
      worker.close();
    }
  }
}
