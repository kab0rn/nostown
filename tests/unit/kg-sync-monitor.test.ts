// Tests: KGSyncMonitor — state hash exchange and reconciliation
// Per MEMPALACE.md §Consistency: every 500ms compare local vs remote hash.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KnowledgeGraph } from '../../src/kg/index';
import { KGSyncMonitor } from '../../src/kg/sync-monitor';
import { MemPalaceClient } from '../../src/mempalace/client';

const TEST_DB = path.join(os.tmpdir(), `kg-sync-${Date.now()}.sqlite`);

afterAll(() => {
  fs.rmSync(TEST_DB, { force: true });
});

function makeKg(): KnowledgeGraph {
  return new KnowledgeGraph(TEST_DB);
}

function makePalace(remoteHash = ''): MemPalaceClient {
  const palace = new MemPalaceClient('http://localhost:9999');
  jest.spyOn(palace, 'getStatus').mockResolvedValue({
    wings: 1,
    rooms: 1,
    drawers: 0,
    kg_triples: 0,
    state_hash: remoteHash,
  });
  jest.spyOn(palace, 'kgTimeline').mockResolvedValue([]);
  return palace;
}

describe('KGSyncMonitor', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts and stops cleanly', () => {
    const kg = makeKg();
    const monitor = new KGSyncMonitor(kg, makePalace(), { intervalMs: 100 });
    monitor.start();
    expect(monitor.status.writePaused).toBe(false);
    monitor.stop();
    kg.close();
  });

  it('reports in-sync when local hash matches remote', async () => {
    const kg = makeKg();
    const localHash = kg.computeStateHash();
    const monitor = new KGSyncMonitor(kg, makePalace(localHash), { intervalMs: 100 });

    await monitor.checkHash();

    expect(monitor.status.inSync).toBe(true);
    expect(monitor.status.lastLocalHash).toBe(localHash);
    expect(monitor.status.lastRemoteHash).toBe(localHash);
    monitor.stop();
    kg.close();
  });

  it('detects hash divergence and triggers reconcile', async () => {
    const kg = makeKg();
    const palace = makePalace('remote-hash-differs-from-local');
    const monitor = new KGSyncMonitor(kg, palace, { intervalMs: 100 });

    await monitor.checkHash();

    expect(monitor.status.reconcileCount).toBe(1);
    expect(monitor.status.lastReconcileAt).toBeTruthy();
    monitor.stop();
    kg.close();
  });

  it('reconcile pastes remote triples into local KG', async () => {
    const kg = makeKg();
    const today = new Date().toISOString().slice(0, 10);

    const remoteTriple = {
      id: 9999,
      subject: 'sync-subject',
      relation: 'test_relation',
      object: 'test-value',
      valid_from: today,
      agent_id: 'remote-agent',
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    };

    const palace = makePalace('different-remote-hash');
    // Return the remote triple for the watched subject
    (palace.kgTimeline as jest.Mock).mockResolvedValue([remoteTriple]);

    const monitor = new KGSyncMonitor(kg, palace, {
      intervalMs: 100,
      watchedSubjects: ['sync-subject'],
    });

    await monitor.checkHash();

    // Verify the remote triple was inserted locally
    const local = kg.queryEntity('sync-subject', today);
    expect(local.some((t) => t.subject === 'sync-subject' && t.relation === 'test_relation')).toBe(true);

    monitor.stop();
    kg.close();
  });

  it('writePaused is false after reconcile completes', async () => {
    const kg = makeKg();
    const palace = makePalace('diverged-hash');
    const monitor = new KGSyncMonitor(kg, palace, { intervalMs: 100 });

    await monitor.checkHash();

    expect(monitor.writePaused).toBe(false);
    monitor.stop();
    kg.close();
  });

  it('handles palace offline gracefully (no crash, no reconcile)', async () => {
    const kg = makeKg();
    const palace = new MemPalaceClient('http://localhost:9999');
    jest.spyOn(palace, 'getStatus').mockRejectedValue(new Error('Connection refused'));

    const monitor = new KGSyncMonitor(kg, palace, { intervalMs: 100 });
    // Should not throw
    await expect(monitor.checkHash()).resolves.toBeUndefined();
    expect(monitor.status.reconcileCount).toBe(0);
    monitor.stop();
    kg.close();
  });

  it('does not start duplicate timer on second start()', () => {
    const kg = makeKg();
    const monitor = new KGSyncMonitor(kg, makePalace(), { intervalMs: 100 });
    monitor.start();
    monitor.start(); // second call — should be a no-op
    monitor.stop();
    kg.close();
  });

  it('DCR: resolveConflict prefers later valid_from', async () => {
    const kg = makeKg();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    // Insert local triple with yesterday's date
    kg.addTriple({
      subject: 'dcr-subject',
      relation: 'dcr_rel',
      object: 'old-value',
      valid_from: yesterday,
      agent_id: 'local-agent',
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    });

    // Remote has newer valid_from
    const newerRemote = {
      id: 8888,
      subject: 'dcr-subject',
      relation: 'dcr_rel',
      object: 'new-value',
      valid_from: today,
      agent_id: 'remote-agent',
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    };

    const palace = makePalace('diverged');
    (palace.kgTimeline as jest.Mock).mockResolvedValue([newerRemote]);

    const monitor = new KGSyncMonitor(kg, palace, {
      intervalMs: 100,
      watchedSubjects: ['dcr-subject'],
    });

    await monitor.checkHash();

    // Both entries present; queryEntity returns current-valid ones
    const results = kg.queryEntity('dcr-subject', today);
    const newEntry = results.find((t) => t.object === 'new-value');
    expect(newEntry).toBeDefined();

    monitor.stop();
    kg.close();
  });
});
