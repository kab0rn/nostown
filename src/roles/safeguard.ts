// NOS Town — Safeguard Pool (Security Scanner)

import { GroqProvider } from '../groq/provider.js';
import type { ScanResult, InferenceParams } from '../types/index.js';

export interface SafeguardConfig {
  poolSize?: number;    // minimum 2
  groqApiKey?: string;
  rulesetCacheTtlMs?: number;
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

class SafeguardWorker {
  private workerId: string;
  private provider: GroqProvider;
  private rulesetCacheTtlMs: number;

  constructor(workerId: string, groqApiKey?: string, rulesetCacheTtlMs = 300_000) {
    this.workerId = workerId;
    this.provider = new GroqProvider(groqApiKey);
    this.rulesetCacheTtlMs = rulesetCacheTtlMs;
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

    // LLM-based semantic check for subtler issues
    try {
      const llmCheck = await this.llmScan(diff);
      for (const v of llmCheck) {
        // Avoid duplicating static detections
        if (!violations.find((existing) => existing.rule === v.rule)) {
          violations.push(v);
        }
      }
    } catch (err) {
      console.warn(`[SafeguardWorker:${this.workerId}] LLM scan failed (static rules still apply): ${String(err)}`);
    }

    const approved = violations.filter((v) => v.severity === 'critical' || v.severity === 'high').length === 0;
    return { approved, violations };
  }

  private async llmScan(diff: string): Promise<ScanResult['violations']> {
    const params: InferenceParams = {
      role: 'safeguard',
      task_type: 'security_scan',
      messages: [
        {
          role: 'system',
          content: `You are a security scanner. Analyze this code diff for security issues.
Output JSON: { "violations": [{ "rule": "<id>", "severity": "critical|high|medium", "detail": "<description>" }] }
Focus on: secrets, eval/exec, injection risks, auth bypass, insecure crypto.
If no issues found, return { "violations": [] }.`,
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

export class SafeguardPool {
  private workers: SafeguardWorker[];
  private roundRobinIndex = 0;

  constructor(config: SafeguardConfig = {}) {
    const size = Math.max(2, config.poolSize ?? 2); // minimum 2 workers
    this.workers = Array.from({ length: size }, (_, i) =>
      new SafeguardWorker(
        `safeguard_${i}`,
        config.groqApiKey,
        config.rulesetCacheTtlMs,
      ),
    );
  }

  /**
   * Scan a diff using the next available worker (round-robin).
   */
  async scan(diff: string): Promise<ScanResult> {
    const worker = this.workers[this.roundRobinIndex % this.workers.length];
    this.roundRobinIndex++;
    return worker.scan(diff);
  }

  get workerCount(): number {
    return this.workers.length;
  }
}
