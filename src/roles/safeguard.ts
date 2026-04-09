// NOS Town — Safeguard Pool (Security Scanner)
// Per ROLES.md §Safeguard: maintains vulnerability memory in wing_safeguard/hall_facts.
// Workers read known patterns at startup and persist newly discovered ones.

import { GroqProvider } from '../groq/provider.js';
import { MemPalaceClient } from '../mempalace/client.js';
import type { ScanResult, InferenceParams } from '../types/index.js';
import { safeguardQueueDepth, safeguardScanLatencyMs } from '../telemetry/metrics.js';

export interface SafeguardConfig {
  poolSize?: number;    // minimum 2
  groqApiKey?: string;
  rulesetCacheTtlMs?: number;
  palaceUrl?: string;
}

interface SecurityRule {
  id: string;
  name: string;
  severity: 'critical' | 'high' | 'medium';
  pattern: RegExp;
  description: string;
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
  rulesetCache = { rules: BUILTIN_RULES, loadedAt: now };
  return rulesetCache.rules;
}

/** Cached learned vulnerability patterns (shared across workers in-process) */
let learnedPatterns: string[] = [];
let patternsLoadedAt = 0;
const PATTERNS_TTL_MS = 60_000; // refresh every 60s per ROLES.md §Safeguard diary cache

/** Reset the in-process pattern cache — for testing only. */
export function _resetPatternCacheForTesting(): void {
  learnedPatterns = [];
  patternsLoadedAt = 0;
}

export class SafeguardWorker {
  private workerId: string;
  private provider: GroqProvider;
  private palace: MemPalaceClient;
  private rulesetCacheTtlMs: number;

  constructor(workerId: string, groqApiKey?: string, rulesetCacheTtlMs = 300_000, palaceUrl?: string) {
    this.workerId = workerId;
    this.provider = new GroqProvider(groqApiKey);
    this.palace = new MemPalaceClient(palaceUrl);
    this.rulesetCacheTtlMs = rulesetCacheTtlMs;
  }

  /**
   * Load learned vulnerability patterns from MemPalace diary.
   * Per ROLES.md §Safeguard: reads wing_safeguard diary before each scan,
   * refreshed every 60s to pick up patterns learned by other workers/sessions.
   */
  private async loadLearnedPatterns(): Promise<string[]> {
    const now = Date.now();
    if (now - patternsLoadedAt < PATTERNS_TTL_MS) {
      return learnedPatterns;
    }
    try {
      const diary = await this.palace.diaryRead('wing_safeguard', 20);
      learnedPatterns = diary
        .filter((e) => e.content.startsWith('vuln-pattern:'))
        .map((e) => e.content.slice('vuln-pattern:'.length).trim());
      patternsLoadedAt = now;
    } catch {
      // non-fatal — proceed with existing patterns
    }
    return learnedPatterns;
  }

  /**
   * Persist a newly discovered vulnerability pattern to wing_safeguard/hall_facts.
   * Per ROLES.md §Safeguard: pattern persisted as Drawer so next session reloads it.
   */
  private async persistPattern(rule: string, detail: string): Promise<void> {
    const patternKey = `vuln-pattern:${rule}: ${detail}`;
    try {
      await this.palace.addDrawer(
        'wing_safeguard',
        'hall_facts',
        `vuln-${rule}-${Date.now()}`,
        JSON.stringify({ rule, detail, discovered_at: new Date().toISOString() }),
        `vulnerability pattern ${rule}`,
      );
      // Also write to diary for fast TTL-based reload
      await this.palace.diaryWrite('wing_safeguard', patternKey);
      // Invalidate in-process cache so next scan picks up new patterns
      patternsLoadedAt = 0;
    } catch (err) {
      console.warn(`[SafeguardWorker:${this.workerId}] Pattern persist failed: ${String(err)}`);
    }
  }

  async scan(diff: string): Promise<ScanResult> {
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

    // If any critical violations found statically, return immediately
    const hasCritical = violations.some((v) => v.severity === 'critical');
    if (hasCritical) {
      return { approved: false, violations };
    }

    // Load learned patterns from prior sessions
    const knownPatterns = await this.loadLearnedPatterns();

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

    // Persist newly discovered patterns for future sessions
    for (const v of newViolations) {
      if (v.severity === 'critical' || v.severity === 'high') {
        void this.persistPattern(v.rule, v.detail);
      }
    }

    const approved = violations.filter((v) => v.severity === 'critical' || v.severity === 'high').length === 0;
    return { approved, violations };
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
        config.palaceUrl,
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
   */
  scan(diff: string, priority = 0): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const entry: ScanQueueEntry = { diff, priority, failCount: 0, resolve, reject };
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
    worker.scan(entry.diff).then(
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
}
