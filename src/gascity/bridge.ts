import { randomUUID } from 'crypto';
import { resolveConsensus } from '../swarm/resolve.js';
import { createProvider, defaultBridgeProviders, type ProviderAdapter } from '../providers/index.js';
import { BdClient } from './bd.js';
import { writeComb } from './comb.js';
import type { GasCityBridgeRequest, GasCityBridgeResult } from './types.js';
import { normalizeQuorumRatio, normalizeTimeoutMs, normalizeWorkers } from './options.js';
import { metadataForResult } from './metadata.js';
import { adjudicate, type ArbiterTrace } from './adjudication.js';
import { invokeWorkers } from './workers.js';
import { noConsensusError, resultFromConsensus, timeoutCount } from './results.js';
import { throwIfAborted } from './bridge-errors.js';

export interface BridgeDeps {
  bd?: BdClient;
  providers?: ProviderAdapter[];
  now?: () => Date;
  signal?: AbortSignal;
}

export async function runGasCityBridge(
  request: GasCityBridgeRequest,
  deps: BridgeDeps = {},
): Promise<GasCityBridgeResult> {
  throwIfAborted(deps.signal, 'bridge');
  const runId = `nos-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const mode = request.mode ?? 'pure';
  const strategy = request.strategy ?? 'majority';
  const bd = deps.bd ?? new BdClient();
  const now = deps.now ?? (() => new Date());
  const bead = request.bead ?? await bd.show(request.bead_id);
  throwIfAborted(deps.signal, 'bridge');

  const providers = deps.providers ??
    (request.providers?.length ? request.providers.map(createProvider) : defaultBridgeProviders());
  if (providers.length === 0) {
    throw new Error('No bridge providers configured');
  }
  const workers = normalizeWorkers(request.workers);
  const timeoutMs = normalizeTimeoutMs(request.timeoutMs);
  const quorumRatio = normalizeQuorumRatio(request.quorumRatio);

  const responses = await invokeWorkers(providers, workers, bead, request.instructions, timeoutMs, deps.signal);
  let result: GasCityBridgeResult;
  let arbiter: ArbiterTrace | undefined;
  try {
    const consensus = resolveConsensus(responses, strategy, quorumRatio);
    result = resultFromConsensus(runId, request.bead_id, mode, consensus, responses.length, 'consensus');
  } catch (err) {
    const adjudicated = await adjudicate(
      runId,
      request.bead_id,
      mode,
      strategy,
      responses,
      providers,
      bead,
      request.instructions,
      timeoutMs,
      deps.signal,
    );
    if (adjudicated) {
      result = adjudicated.result;
      arbiter = adjudicated.trace;
    } else {
      result = {
        ok: false,
        schema: 'gascity.swarm.result.v1',
        run_id: runId,
        bead_id: request.bead_id,
        mode,
        status: 'no_consensus',
        error: noConsensusError(err, responses),
        timeout_count: timeoutCount(responses),
      };
    }
  }

  throwIfAborted(deps.signal, 'bridge');
  const combPath = writeComb({
    run_id: runId,
    bead_id: request.bead_id,
    created_at: now().toISOString(),
    request: { ...request, bead },
    responses,
    arbiter,
    result,
  });
  result.comb_path = combPath;

  if (mode === 'apply') {
    throwIfAborted(deps.signal, 'bridge');
    try {
      const metadata = metadataForResult(result);
      await bd.setMetadata(request.bead_id, metadata);
      result.metadata_written = metadata;
    } catch (err) {
      result = {
        ...result,
        ok: false,
        status: 'error',
        error: `metadata apply failed: ${String(err)}`,
        comb_path: combPath,
      };
      writeComb({
        run_id: runId,
        bead_id: request.bead_id,
        created_at: now().toISOString(),
        request: { ...request, bead },
        responses,
        arbiter,
        result,
      });
    }
  }

  return result;
}
