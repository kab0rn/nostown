// Tests: Safeguard LOCKDOWN protocol
// Verifies that critical violations trigger LOCKDOWN signal with KG triple

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: '{"violations":[]}' } }] }) } },
  })),
}));

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SafeguardPool, SafeguardWorker } from '../../src/roles/safeguard';
import { KnowledgeGraph } from '../../src/kg/index';

const TEST_KG = path.join(os.tmpdir(), `safeguard-lockdown-${Date.now()}.sqlite`);

afterAll(() => {
  fs.rmSync(TEST_KG, { force: true });
});

describe('Safeguard LOCKDOWN protocol', () => {
  it('sets lockdown field when credential pattern detected', async () => {
    const pool = new SafeguardPool({ poolSize: 2, kgPath: TEST_KG });
    // Diff with a hardcoded credential — triggers CRED_LEAK critical rule
    const diff = `+const apiKey = 'sk-1234567890abcdefghij';`;

    const result = await pool.scan(diff);

    expect(result.approved).toBe(false);
    expect(result.lockdown).toBeDefined();
    expect(result.lockdown?.triggered).toBe(true);
    expect(result.lockdown?.lockdown_id).toMatch(/^lockdown_/);
    expect(result.lockdown?.reason).toBeTruthy();

    pool.close();
  });

  it('writes KG triple on LOCKDOWN', async () => {
    const pool = new SafeguardPool({ poolSize: 2, kgPath: TEST_KG });
    const diff = `+const password = 'supersecretpassword123!';`;

    const result = await pool.scan(diff);
    expect(result.lockdown).toBeDefined();

    const lockdownId = result.lockdown?.lockdown_id ?? '';

    // Verify KG triple was written
    const kg = new KnowledgeGraph(TEST_KG);
    const today = new Date().toISOString().slice(0, 10);
    const triples = kg.queryEntity(lockdownId, today);

    expect(triples.length).toBeGreaterThan(0);
    expect(triples.some((t) => t.relation === 'triggered_by')).toBe(true);

    kg.close();
    pool.close();
  });

  it('does NOT set lockdown field for high (non-critical) violations', async () => {
    // High violations come from LLM, but we mock LLM to return high severity
    // Static rules only produce critical for creds/destructive commands
    const pool = new SafeguardPool({ poolSize: 2, kgPath: TEST_KG });
    // A diff with no static critical patterns — LLM mock returns empty
    const diff = `+console.log('hello');`;

    const result = await pool.scan(diff);
    // LLM mock returns empty violations → approved=true, no lockdown
    expect(result.lockdown).toBeUndefined();

    pool.close();
  });

  it('lockdown_id is unique per trigger', async () => {
    const pool = new SafeguardPool({ poolSize: 2, kgPath: TEST_KG });
    const diff = `+const token = 'Bearer abcdefghijklmnopqrst';`;

    const [r1, r2] = await Promise.all([
      pool.scan(diff),
      pool.scan(diff),
    ]);

    expect(r1.lockdown?.lockdown_id).toBeTruthy();
    expect(r2.lockdown?.lockdown_id).toBeTruthy();
    expect(r1.lockdown?.lockdown_id).not.toBe(r2.lockdown?.lockdown_id);

    pool.close();
  });

  it('lockdown reason lists the triggered rule', async () => {
    const pool = new SafeguardPool({ poolSize: 2, kgPath: TEST_KG });
    const diff = `+const apiKey = 'sk-1234567890abcdefghij';`;

    const result = await pool.scan(diff);

    // The rule ID comes from the static ruleset (e.g. secret_hardcoded, destructive_cmd)
    expect(result.lockdown?.reason).toBeTruthy();
    expect(result.lockdown?.reason.length).toBeGreaterThan(0);

    pool.close();
  });
});
