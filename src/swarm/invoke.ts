import { spawn } from 'child_process';
import { AgentResponse } from './types.js';

export interface InvokeConfig {
  agentBinary: string;      // e.g. 'groq-compound' or path to binary
  systemPrompt: string;
  userPrompt: string;
  n: number;
  timeoutMs?: number;       // per-agent timeout, default 90000
  extraArgs?: string[];
}

export async function invokeSwarm(config: InvokeConfig): Promise<AgentResponse[]> {
  const { n, timeoutMs = 90_000 } = config;
  return Promise.all(
    Array.from({ length: n }, (_, i) => invokeOne(config, i, timeoutMs))
  );
}

async function invokeOne(config: InvokeConfig, index: number, timeoutMs: number): Promise<AgentResponse> {
  const start = Date.now();
  const args = [
    '--system', config.systemPrompt,
    '--message', config.userPrompt,
    '--output-format', 'json',
    '--no-color',
    ...(config.extraArgs ?? []),
  ];

  return new Promise((resolve) => {
    const proc = spawn(config.agentBinary, args);
    let stdout = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (timedOut) {
        resolve({ agentIndex: index, raw: stdout, parsed: null, parseError: `agent[${index}] timed out after ${timeoutMs}ms`, latencyMs });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
        resolve({ agentIndex: index, raw: stdout, parsed, parseError: null, latencyMs });
      } catch (e) {
        resolve({ agentIndex: index, raw: stdout, parsed: null, parseError: `agent[${index}] JSON parse failed: ${String(e)}`, latencyMs });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ agentIndex: index, raw: '', parsed: null, parseError: `agent[${index}] spawn error: ${err.message}`, latencyMs: Date.now() - start });
    });
  });
}
