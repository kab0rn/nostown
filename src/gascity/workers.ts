import type { AgentResponse } from '../swarm/types.js';
import type { ProviderAdapter } from '../providers/index.js';
import type { GasCityBead } from './types.js';
import { safeJsonParse } from './json.js';
import { normalizeTimeoutMs } from './options.js';
import { isBridgeAbortError, isBridgeTimeoutError, runWithTimeout } from './bridge-errors.js';
import { sanitizeError } from './redaction.js';

export async function invokeWorkers(
  providers: ProviderAdapter[],
  workers: number,
  bead: GasCityBead,
  instructions?: string,
  timeoutMs = normalizeTimeoutMs(undefined),
  signal?: AbortSignal,
): Promise<AgentResponse[]> {
  const system = [
    'You are a role-neutral NOSTown swarm worker evaluating a Gas City bead.',
    'Return exactly one JSON object. No prose, markdown, or code fences.',
    'Use this shape: {"summary": string, "recommendation": string, "confidence": number, "evidence": string[]}.',
  ].join('\n');
  const user = JSON.stringify({
    bead,
    instructions: instructions ?? 'Evaluate the bead and produce the best consensus-ready result.',
  }, null, 2);

  return Promise.all(Array.from({ length: workers }, async (_, index) => {
    const provider = providers[index % providers.length];
    const started = Date.now();
    try {
      const response = await runWithTimeout((workerSignal) => provider.generateJson({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        timeoutMs,
        signal: workerSignal,
      }), timeoutMs, `worker[${index}] ${provider.name}`, signal);
      try {
        return {
          agentIndex: index,
          raw: response.content,
          parsed: safeJsonParse(response.content),
          parseError: null,
          latencyMs: response.latencyMs,
          provider: response.provider,
          model: response.model,
        };
      } catch (err) {
        return {
          agentIndex: index,
          raw: response.content,
          parsed: null,
          parseError: `worker[${index}] JSON parse failed: ${String(err)}`,
          latencyMs: response.latencyMs,
          provider: response.provider,
          model: response.model,
        };
      }
    } catch (err) {
      if (isBridgeAbortError(err)) throw err;
      const error = sanitizeError(err);
      return {
        agentIndex: index,
        raw: '',
        parsed: null,
        parseError: `worker[${index}] provider ${provider.name} failed: ${error}`,
        latencyMs: Date.now() - started,
        provider: provider.name,
        model: provider.model,
        error,
        timedOut: isBridgeTimeoutError(err),
      };
    }
  }));
}
