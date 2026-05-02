import type { Strategy } from '../swarm/types.js';
import type { BridgeMode } from './types.js';

export const DEFAULT_BRIDGE_WORKERS = 3;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 90_000;
export const DEFAULT_BRIDGE_MAX_WORKERS = 9;
export const DEFAULT_BRIDGE_QUORUM = 0.6;

export function normalizeBridgeMode(value: string | undefined, fallback: BridgeMode = 'pure'): BridgeMode {
  if (value === undefined) return fallback;
  if (value === 'apply' || value === 'pure') return value;
  throw new Error(`invalid mode ${value}; expected pure or apply`);
}

export function normalizeStrategy(value: string | undefined, fallback: Strategy = 'majority'): Strategy {
  if (value === undefined) return fallback;
  if (value === 'unanimous' || value === 'first_quorum' || value === 'majority') return value;
  throw new Error(`invalid strategy ${value}; expected majority, unanimous, or first_quorum`);
}

export function normalizeWorkers(requested: number | undefined): number {
  const workers = requested ?? DEFAULT_BRIDGE_WORKERS;
  if (!Number.isInteger(workers) || workers <= 0) {
    throw new Error('workers must be a positive integer');
  }
  const max = maxBridgeWorkers();
  if (workers > max) throw new Error(`workers must be <= ${max}`);
  return workers;
}

export function normalizeTimeoutMs(requested: number | undefined): number {
  const timeoutMs = requested ?? envPositiveInteger('NOS_BRIDGE_TIMEOUT_MS') ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive integer');
  }
  return timeoutMs;
}

export function maxBridgeWorkers(): number {
  return envPositiveInteger('NOS_MAX_BRIDGE_WORKERS') ?? DEFAULT_BRIDGE_MAX_WORKERS;
}

export function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export function parseWorkers(value: string | undefined): number | undefined {
  const workers = parsePositiveInteger(value, '--workers');
  if (workers === undefined) return undefined;
  const max = maxBridgeWorkers();
  if (workers > max) throw new Error(`--workers must be <= ${max}`);
  return workers;
}

export function parseQuorumRatio(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('--quorum must be a number');
  if (parsed <= 0 || parsed > 1) throw new Error('--quorum must be in range (0, 1]');
  return parsed;
}

function envPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
