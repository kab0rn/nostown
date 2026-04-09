// Tests: Wrong key rejected even with valid HMAC

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { generateKeyPair, buildSignedConvoy, loadPrivateKey, loadPublicKey } from '../../src/convoys/sign';
import { validateConvoy, verifyTransportMac } from '../../src/convoys/verify';
import type { ConvoyHeader, ConvoyPayload } from '../../src/types/index';

const TEST_KEY_DIR = path.join(os.tmpdir(), `nos-authn-keys-${Date.now()}`);

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  await generateKeyPair('mayor_authn');
  await generateKeyPair('polecat_authn');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
});

const header: ConvoyHeader = {
  sender_id: 'mayor_authn',
  recipient: 'polecat',
  timestamp: '2026-04-09T10:00:00Z',
  seq: 1,
};

const payload: ConvoyPayload = {
  type: 'BEAD_DISPATCH',
  data: { bead_id: 'authn-test', plan_checkpoint_id: 'ckpt-authn' },
};

const TRANSPORT_SECRET = 'shared-cluster-secret-for-test';

describe('Authentication with transport MAC', () => {
  it('accepts convoy signed with correct key AND valid MAC', async () => {
    const privKey = loadPrivateKey('mayor_authn');
    const pubKey = loadPublicKey('mayor_authn');
    const convoy = await buildSignedConvoy(header, payload, privKey, TRANSPORT_SECRET);

    const result = await validateConvoy(convoy, pubKey, TRANSPORT_SECRET);
    expect(result.ok).toBe(true);
  });

  it('rejects convoy with valid MAC but wrong signing key', async () => {
    // Sign with polecat's key but present as mayor
    const polecatPrivKey = loadPrivateKey('polecat_authn');
    const mayorPubKey = loadPublicKey('mayor_authn');

    // Create a convoy signed by polecat but claiming to be from mayor
    const fakeConvoy = await buildSignedConvoy(header, payload, polecatPrivKey, TRANSPORT_SECRET);

    // Verify against mayor's public key — should fail even though HMAC is valid
    const result = await validateConvoy(fakeConvoy, mayorPubKey, TRANSPORT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/[Ss]ignature/);
  });

  it('rejects convoy with invalid transport MAC', async () => {
    const privKey = loadPrivateKey('mayor_authn');
    const pubKey = loadPublicKey('mayor_authn');
    const convoy = await buildSignedConvoy(header, payload, privKey, TRANSPORT_SECRET);

    // Tamper with the MAC
    const tamperedConvoy = {
      ...convoy,
      transport_mac: 'hmac256:deadbeefdeadbeef',
    };

    const result = await validateConvoy(tamperedConvoy, pubKey, TRANSPORT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/[Mm][Aa][Cc]/i);
  });

  it('shared HMAC alone cannot forge a Mayor message from polecat sender_id', async () => {
    // Scenario: attacker knows HMAC secret, tries to forge a polecat-signed BEAD_DISPATCH
    const polecatPrivKey = loadPrivateKey('polecat_authn');
    const polecatPubKey = loadPublicKey('polecat_authn');

    // Polecat tries to send BEAD_DISPATCH (not allowed)
    const attackHeader: ConvoyHeader = {
      sender_id: 'polecat_authn',
      recipient: 'witness',
      timestamp: '2026-04-09T10:00:00Z',
      seq: 1,
    };
    const attackPayload: ConvoyPayload = {
      type: 'BEAD_DISPATCH', // Polecat not authorized
      data: { bead_id: 'forged', plan_checkpoint_id: 'ckpt-forged' },
    };

    const forgedConvoy = await buildSignedConvoy(attackHeader, attackPayload, polecatPrivKey, TRANSPORT_SECRET);

    // Even with valid HMAC and valid polecat signature, authz should fail
    const result = await validateConvoy(forgedConvoy, polecatPubKey, TRANSPORT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/AUTHZ_DENIED/);
  });

  it('verifyTransportMac returns true when mac is absent', () => {
    const convoy = { header, payload, signature: 'ed25519:test' };
    const result = verifyTransportMac(convoy, TRANSPORT_SECRET);
    expect(result.ok).toBe(true);
  });
});
