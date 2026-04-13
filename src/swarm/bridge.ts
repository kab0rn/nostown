import { invokeSwarm } from './invoke.js';
import { resolveConsensus } from './resolve.js';
import { SlingParams, SlingResult, Strategy } from './types.js';

const JSON_ENFORCEMENT = '\n\n---\nRESPONSE FORMAT: Respond ONLY with a single valid JSON object. ' +
  'No text, markdown, or code fences outside the JSON. ' +
  'If unable to comply, return: {"error": "<reason>"}';

export async function runSwarmBridge(params: SlingParams): Promise<SlingResult> {
  const { swarm_config: cfg } = params;
  const n = Math.max(cfg.n ?? 3, 3);
  const strategy = (cfg.strategy ?? 'majority') as Strategy;

  const responses = await invokeSwarm({
    agentBinary: params.agent,
    systemPrompt: JSON_ENFORCEMENT,  // base; caller can prepend role context
    userPrompt: '',                  // GasTown will have set context via bead
    n,
    extraArgs: [],
  });

  try {
    const consensus = resolveConsensus(responses, strategy, cfg.quorumRatio ?? 0.6);
    return { consensus_result: consensus };
  } catch (err) {
    return { error: String(err) };
  }
}

// CLI entrypoint: reads SlingParams from stdin, writes SlingResult to stdout.
export async function runFromStdin(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const params = JSON.parse(raw) as SlingParams;
  const result = await runSwarmBridge(params);
  process.stdout.write(JSON.stringify(result) + '\n');
}
