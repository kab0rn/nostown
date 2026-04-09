// Tests: Historian AAAK bead manifest compression

import { Historian } from '../../src/roles/historian';
import type { Bead } from '../../src/types/index';

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    bead_id: 'abcd1234-efgh',
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    rig: 'test-rig',
    status: 'done',
    outcome: 'SUCCESS',
    needs: [],
    critical_path: false,
    witness_required: false,
    fan_out_weight: 1,
    created_at: new Date().toISOString(),
    metrics: { duration_ms: 1200 },
    ...overrides,
  };
}

describe('Historian.generateAaakManifest', () => {
  let historian: Historian;

  beforeEach(() => {
    // Use in-memory DB — palace will fail but generateAaakManifest is synchronous
    historian = new Historian({ agentId: 'test-historian', kgPath: ':memory:' });
  });

  afterEach(() => {
    historian.close();
  });

  it('generates a non-empty manifest for a single bead', () => {
    const beads = [makeBead()];
    const manifest = historian.generateAaakManifest(beads);
    expect(manifest).toBeTruthy();
    expect(manifest.length).toBeGreaterThan(0);
  });

  it('includes AAAK header with role and model codes', () => {
    const beads = [makeBead({ role: 'polecat', model: 'llama-3.1-8b-instant' })];
    const manifest = historian.generateAaakManifest(beads);
    expect(manifest).toContain('# AAAK entity codes:');
    expect(manifest).toContain('POL=polecat');
    expect(manifest).toContain('L8B=llama-3.1-8b');
  });

  it('encodes polecat as POL', () => {
    const beads = [makeBead({ role: 'polecat' })];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines[0]).toContain('|POL|');
  });

  it('encodes witness as WIT', () => {
    const beads = [makeBead({ role: 'witness', task_type: 'review' })];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines[0]).toContain('|WIT|');
  });

  it('encodes llama-3.1-8b model as L8B', () => {
    const beads = [makeBead({ model: 'llama-3.1-8b-instant' })];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines[0]).toContain('|L8B|');
  });

  it('encodes llama-4-scout model as L4S', () => {
    const beads = [makeBead({ model: 'meta-llama/llama-4-scout-17b-16e-instruct' })];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines[0]).toContain('|L4S|');
  });

  it('encodes SUCCESS outcome as pass', () => {
    const beads = [makeBead({ outcome: 'SUCCESS', status: 'done' })];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines[0]).toContain('|pass|');
  });

  it('encodes FAILURE outcome as fail', () => {
    const beads = [makeBead({ outcome: 'FAILURE', status: 'failed' })];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines[0]).toContain('|fail|');
  });

  it('includes duration in ms', () => {
    const beads = [makeBead({ metrics: { duration_ms: 2500 } })];
    const manifest = historian.generateAaakManifest(beads);
    expect(manifest).toContain('2500ms');
  });

  it('uses first 4 chars of bead_id', () => {
    const beads = [makeBead({ bead_id: 'deadbeef-1234-5678' })];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines[0].startsWith('dead|')).toBe(true);
  });

  it('produces one line per bead (excluding header)', () => {
    const beads = [
      makeBead({ bead_id: 'aaaa0001', role: 'polecat' }),
      makeBead({ bead_id: 'bbbb0002', role: 'witness', task_type: 'review' }),
      makeBead({ bead_id: 'cccc0003', role: 'historian', task_type: 'generate_playbook' }),
    ];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines.length).toBe(3);
  });

  it('returns empty manifest body for empty bead list', () => {
    const manifest = historian.generateAaakManifest([]);
    // Header should still be present, but no data lines
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines.length).toBe(0);
  });

  it('encodes witness_score as W-prefixed percentage', () => {
    const beads = [makeBead({ metrics: { duration_ms: 1000, witness_score: 0.92 } })];
    const manifest = historian.generateAaakManifest(beads);
    expect(manifest).toContain('W92');
  });

  it('encodes null witness when score absent', () => {
    const beads = [makeBead({ metrics: { duration_ms: 1000 } })];
    const manifest = historian.generateAaakManifest(beads);
    const lines = manifest.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    expect(lines[0]).toContain('|null|');
  });
});
