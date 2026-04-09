// NOS Town — Convoy Verification + Authorization Matrix

import * as ed from '@noble/ed25519';
import { createHmac, createHash } from 'crypto';
import type { ConvoyMessage, ConvoyType } from '../types/index.js';
import { canonicalize } from './sign.js';

// Provide sha512Sync using Node's built-in crypto for @noble/ed25519 v2
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const h = createHash('sha512');
  for (const m of msgs) h.update(m);
  return new Uint8Array(h.digest());
};

export const AUTHZ_MATRIX: Record<string, ConvoyType[]> = {
  mayor: ['BEAD_DISPATCH', 'SWARM_ABORT', 'CAPACITY_UPDATE', 'LOCKDOWN_BROADCAST'],
  polecat: ['BEAD_STATUS', 'DISCOVERY', 'BLOCKED', 'PATCH_READY'],
  witness: ['REVIEW_VERDICT', 'COUNCIL_VOTE', 'REVIEW_RETRY'],
  safeguard: ['SECURITY_VIOLATION', 'LOCKDOWN_TRIGGERED', 'WRITE_APPROVED', 'WRITE_REJECTED'],
  historian: ['ROUTING_UPDATE', 'PLAYBOOK_PUBLISHED', 'BACKFILL_NOTICE'],
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Extract role from sender_id (e.g. "mayor_01" → "mayor")
 */
function extractRole(senderId: string): string {
  return senderId.split('_')[0] ?? senderId;
}

/**
 * Verify Ed25519 signature on a convoy message.
 */
export async function verifyConvoy(
  msg: ConvoyMessage,
  publicKeyHex: string,
): Promise<VerifyResult> {
  if (!msg.signature.startsWith('ed25519:')) {
    return { ok: false, reason: 'Invalid signature format — expected ed25519: prefix' };
  }

  const sigBase64 = msg.signature.slice('ed25519:'.length);
  const sigBytes = Buffer.from(sigBase64, 'base64');
  const canonical = canonicalize(msg.header, msg.payload);
  const msgBytes = new TextEncoder().encode(canonical);
  const pubKeyBytes = Buffer.from(publicKeyHex, 'hex');

  try {
    const valid = await ed.verifyAsync(sigBytes, msgBytes, pubKeyBytes);
    if (!valid) {
      return { ok: false, reason: 'Ed25519 signature verification failed' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Signature verification error: ${String(err)}` };
  }
}

/**
 * Verify HMAC transport MAC (optional layer).
 */
export function verifyTransportMac(msg: ConvoyMessage, secret: string): VerifyResult {
  if (!msg.transport_mac) return { ok: true }; // absent = not required

  if (!msg.transport_mac.startsWith('hmac256:')) {
    return { ok: false, reason: 'Invalid transport_mac format — expected hmac256: prefix' };
  }

  const providedHex = msg.transport_mac.slice('hmac256:'.length);
  const canonical = canonicalize(msg.header, msg.payload);
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');

  if (providedHex !== expected) {
    return { ok: false, reason: 'Transport MAC mismatch' };
  }
  return { ok: true };
}

/**
 * Check that sender is authorized to emit the given payload type.
 */
export function validateAuthz(senderId: string, payloadType: ConvoyType): VerifyResult {
  const role = extractRole(senderId);
  const allowed = AUTHZ_MATRIX[role];

  if (!allowed) {
    return { ok: false, reason: `Unknown sender role: ${role} (sender_id: ${senderId})` };
  }

  if (!allowed.includes(payloadType)) {
    return {
      ok: false,
      reason: `AUTHZ_DENIED: ${role} is not authorized to emit ${payloadType}`,
    };
  }

  return { ok: true };
}

/**
 * Full convoy validation pipeline:
 * 1. Check authz
 * 2. Verify Ed25519 signature
 * 3. Verify transport MAC if present
 */
export async function validateConvoy(
  msg: ConvoyMessage,
  publicKeyHex: string,
  transportSecret?: string,
): Promise<VerifyResult> {
  // 1. Authorization check
  const authz = validateAuthz(msg.header.sender_id, msg.payload.type);
  if (!authz.ok) return authz;

  // 2. Ed25519 signature
  const sig = await verifyConvoy(msg, publicKeyHex);
  if (!sig.ok) return sig;

  // 3. Transport MAC (if secret provided)
  if (transportSecret) {
    const mac = verifyTransportMac(msg, transportSecret);
    if (!mac.ok) return mac;
  }

  return { ok: true };
}
