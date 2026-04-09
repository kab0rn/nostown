// Tests: Ed25519 sign + verify roundtrip, tampered payload fails

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { generateKeyPair, signConvoy, loadPrivateKey, loadPublicKey, canonicalize, buildSignedConvoy } from '../../src/convoys/sign';
import { verifyConvoy, validateAuthz } from '../../src/convoys/verify';
import type { ConvoyHeader, ConvoyPayload } from '../../src/types/index';

// Use a temp key directory for tests
const TEST_KEY_DIR = path.join(os.tmpdir(), `nos-test-keys-${Date.now()}`);

beforeAll(() => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
});

const header: ConvoyHeader = {
  sender_id: 'mayor_01',
  recipient: 'polecat',
  timestamp: '2026-04-09T07:14:00Z',
  seq: 1,
  trace_id: 'test-trace',
};

const payload: ConvoyPayload = {
  type: 'BEAD_DISPATCH',
  data: { bead_id: 'abc-123', plan_checkpoint_id: 'ckpt-01' },
};

describe('Ed25519 key generation', () => {
  it('generates a key pair for mayor_01', async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeyPair('mayor_01');
    expect(privateKeyHex).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(publicKeyHex).toHaveLength(64);
  });

  it('saves key files to key directory', () => {
    expect(fs.existsSync(path.join(TEST_KEY_DIR, 'mayor_01.key'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_KEY_DIR, 'mayor_01.pub'))).toBe(true);
  });
});

describe('Sign + verify roundtrip', () => {
  it('verifies a correctly signed convoy', async () => {
    const privateKey = loadPrivateKey('mayor_01');
    const publicKey = loadPublicKey('mayor_01');
    const signature = await signConvoy(header, payload, privateKey);

    expect(signature).toMatch(/^ed25519:/);

    const convoy = { header, payload, signature };
    const result = await verifyConvoy(convoy, publicKey);
    expect(result.ok).toBe(true);
  });

  it('rejects tampered payload', async () => {
    const privateKey = loadPrivateKey('mayor_01');
    const publicKey = loadPublicKey('mayor_01');
    const signature = await signConvoy(header, payload, privateKey);

    // Tamper: change bead_id after signing
    const tamperedPayload: ConvoyPayload = {
      ...payload,
      data: { ...payload.data, bead_id: 'TAMPERED' },
    };
    const convoy = { header, payload: tamperedPayload, signature };
    const result = await verifyConvoy(convoy, publicKey);
    expect(result.ok).toBe(false);
  });

  it('rejects tampered header', async () => {
    const privateKey = loadPrivateKey('mayor_01');
    const publicKey = loadPublicKey('mayor_01');
    const signature = await signConvoy(header, payload, privateKey);

    const tamperedHeader = { ...header, seq: 999 };
    const convoy = { header: tamperedHeader, payload, signature };
    const result = await verifyConvoy(convoy, publicKey);
    expect(result.ok).toBe(false);
  });

  it('rejects convoy verified with wrong public key', async () => {
    // Generate a second key pair
    await generateKeyPair('polecat_01');
    const mayorKey = loadPrivateKey('mayor_01');
    const polecatPub = loadPublicKey('polecat_01');

    const signature = await signConvoy(header, payload, mayorKey);
    const convoy = { header, payload, signature };

    // Verify mayor's signature with polecat's public key — should fail
    const result = await verifyConvoy(convoy, polecatPub);
    expect(result.ok).toBe(false);
  });
});

describe('Authorization matrix', () => {
  it('allows mayor to emit BEAD_DISPATCH', () => {
    const result = validateAuthz('mayor_01', 'BEAD_DISPATCH');
    expect(result.ok).toBe(true);
  });

  it('denies polecat emitting BEAD_DISPATCH', () => {
    const result = validateAuthz('polecat_01', 'BEAD_DISPATCH');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/AUTHZ_DENIED/);
  });

  it('allows polecat to emit BEAD_STATUS', () => {
    const result = validateAuthz('polecat_01', 'BEAD_STATUS');
    expect(result.ok).toBe(true);
  });

  it('allows historian to emit ROUTING_UPDATE', () => {
    const result = validateAuthz('historian_01', 'ROUTING_UPDATE');
    expect(result.ok).toBe(true);
  });

  it('denies unknown role', () => {
    const result = validateAuthz('unknown_01', 'BEAD_DISPATCH');
    expect(result.ok).toBe(false);
  });
});

describe('Transport MAC', () => {
  it('builds convoy with transport MAC', async () => {
    const privateKey = loadPrivateKey('mayor_01');
    const convoy = await buildSignedConvoy(header, payload, privateKey, 'test-secret');
    expect(convoy.transport_mac).toMatch(/^hmac256:/);
  });

  it('builds convoy without transport MAC when no secret', async () => {
    const privateKey = loadPrivateKey('mayor_01');
    const convoy = await buildSignedConvoy(header, payload, privateKey);
    expect(convoy.transport_mac).toBeUndefined();
  });
});
