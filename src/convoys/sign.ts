// NOS Town — Ed25519 Convoy Signing

import * as ed from '@noble/ed25519';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ConvoyMessage, ConvoyHeader, ConvoyPayload } from '../types/index.js';

// Provide sha512Sync using Node's built-in crypto for @noble/ed25519 v2
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const h = createHash('sha512');
  for (const m of msgs) h.update(m);
  return new Uint8Array(h.digest());
};

function getKeyDir(): string {
  return process.env.NOS_ROLE_KEY_DIR ?? 'keys';
}

function keyPath(senderId: string, ext: 'key' | 'pub'): string {
  return path.resolve(getKeyDir(), `${senderId}.${ext}`);
}

export interface KeyPair {
  privateKeyHex: string;
  publicKeyHex: string;
}

/**
 * Generate a new Ed25519 key pair for a role/senderId.
 * Saves .key (private) and .pub (public) files in KEY_DIR.
 */
export async function generateKeyPair(senderId: string): Promise<KeyPair> {
  const privKey = ed.utils.randomPrivateKey();
  const pubKey = await ed.getPublicKeyAsync(privKey);

  const privateKeyHex = Buffer.from(privKey).toString('hex');
  const publicKeyHex = Buffer.from(pubKey).toString('hex');

  fs.mkdirSync(path.resolve(getKeyDir()), { recursive: true });
  fs.writeFileSync(keyPath(senderId, 'key'), privateKeyHex, 'utf8');
  fs.writeFileSync(keyPath(senderId, 'pub'), publicKeyHex, 'utf8');

  return { privateKeyHex, publicKeyHex };
}

/**
 * Load private key hex for a senderId from the key directory.
 */
export function loadPrivateKey(senderId: string): string {
  const p = keyPath(senderId, 'key');
  if (!fs.existsSync(p)) {
    throw new Error(`Private key not found for ${senderId} at ${p}`);
  }
  return fs.readFileSync(p, 'utf8').trim();
}

/**
 * Load public key hex for a senderId from the key directory.
 */
export function loadPublicKey(senderId: string): string {
  const p = keyPath(senderId, 'pub');
  if (!fs.existsSync(p)) {
    throw new Error(`Public key not found for ${senderId} at ${p}`);
  }
  return fs.readFileSync(p, 'utf8').trim();
}

/**
 * Canonicalize header + payload deterministically for signing.
 */
export function canonicalize(header: ConvoyHeader, payload: ConvoyPayload): string {
  return JSON.stringify({ header, payload });
}

/**
 * Sign a convoy message. Returns the full ConvoyMessage with signature attached.
 */
export async function signConvoy(
  header: ConvoyHeader,
  payload: ConvoyPayload,
  privateKeyHex: string,
): Promise<string> {
  const canonical = canonicalize(header, payload);
  const msgBytes = new TextEncoder().encode(canonical);
  const privKeyBytes = Buffer.from(privateKeyHex, 'hex');
  const sigBytes = await ed.signAsync(msgBytes, privKeyBytes);
  return 'ed25519:' + Buffer.from(sigBytes).toString('base64');
}

/**
 * Build a complete signed ConvoyMessage.
 */
export async function buildSignedConvoy(
  header: ConvoyHeader,
  payload: ConvoyPayload,
  privateKeyHex: string,
  transportSecret?: string,
): Promise<ConvoyMessage> {
  const signature = await signConvoy(header, payload, privateKeyHex);

  let transport_mac: string | undefined;
  if (transportSecret) {
    const { createHmac } = await import('crypto');
    const canonical = canonicalize(header, payload);
    const mac = createHmac('sha256', transportSecret).update(canonical).digest('hex');
    transport_mac = 'hmac256:' + mac;
  }

  return { header, payload, signature, transport_mac };
}
