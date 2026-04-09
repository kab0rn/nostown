// Tests: Sequence monotonicity enforcement (replay attack prevention)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { generateKeyPair, buildSignedConvoy, loadPrivateKey } from '../../src/convoys/sign';
import { ConvoyBus } from '../../src/convoys/bus';
import type { ConvoyHeader, ConvoyPayload } from '../../src/types/index';

const TEST_KEY_DIR = path.join(os.tmpdir(), `nos-replay-keys-${Date.now()}`);
const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-replay-rigs-${Date.now()}`);

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  await generateKeyPair('mayor_replay');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
});

function makeHeader(seq: number): ConvoyHeader {
  return {
    sender_id: 'mayor_replay',
    recipient: 'polecat',
    timestamp: new Date().toISOString(),
    seq,
  };
}

const payload: ConvoyPayload = {
  type: 'BEAD_DISPATCH',
  data: { bead_id: 'test-bead', plan_checkpoint_id: 'ckpt-01' },
};

describe('Sequence monotonicity', () => {
  it('accepts convoy with seq=1', async () => {
    const bus = new ConvoyBus('replay-test');
    const privKey = loadPrivateKey('mayor_replay');
    const convoy = await buildSignedConvoy(makeHeader(1), payload, privKey);

    // getNextSeq should return 1 on first call
    const seq = bus.getNextSeq('mayor_replay');
    expect(seq).toBe(1);
  });

  it('rejects convoy with replay (same seq)', async () => {
    const bus = new ConvoyBus('replay-test-2');
    const privKey = loadPrivateKey('mayor_replay');

    // First send (seq=1)
    const convoy1 = await buildSignedConvoy(makeHeader(1), payload, privKey);
    await bus.send(convoy1);

    // Replay same convoy (seq=1 again)
    const convoy2 = await buildSignedConvoy(makeHeader(1), payload, privKey);
    await expect(bus.send(convoy2)).rejects.toThrow(/[Rr]eplay/);
  });

  it('rejects convoy with retrograde seq', async () => {
    const bus = new ConvoyBus('replay-test-3');
    const privKey = loadPrivateKey('mayor_replay');

    // Send seq=5
    const convoy5 = await buildSignedConvoy(makeHeader(5), payload, privKey);
    await bus.send(convoy5);

    // Send seq=3 (retrograde)
    const convoy3 = await buildSignedConvoy(makeHeader(3), payload, privKey);
    await expect(bus.send(convoy3)).rejects.toThrow(/[Rr]eplay|seq/);
  });

  it('accepts increasing seq values', async () => {
    const bus = new ConvoyBus('replay-test-4');
    const privKey = loadPrivateKey('mayor_replay');

    for (let seq = 10; seq <= 15; seq++) {
      const convoy = await buildSignedConvoy(makeHeader(seq), payload, privKey);
      await expect(bus.send(convoy)).resolves.not.toThrow();
    }
  });
});
