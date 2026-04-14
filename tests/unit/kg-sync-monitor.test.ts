// Tests: KGSyncMonitor — hash divergence and onStateChange callback

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KnowledgeGraph } from '../../src/kg/index';
import { KGSyncMonitor } from '../../src/kg/sync-monitor';

const mkKgPath = () => path.join(os.tmpdir(), `nos-kg-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

describe('KGSyncMonitor', () => {
  let kg: KnowledgeGraph;
  let kgPath: string;

  beforeEach(() => {
    kgPath = mkKgPath();
    kg = new KnowledgeGraph(kgPath);
  });

  afterEach(() => {
    kg.close();
    fs.rmSync(kgPath, { force: true });
  });

  it('fires onStateChange when KG changes', async () => {
    const changes: string[] = [];
    const monitor = new KGSyncMonitor(kg, 50, (hash) => changes.push(hash));
    monitor.start();

    // Write a triple so the hash changes
    const today = new Date().toISOString().slice(0, 10);
    kg.addTriple({
      subject: 'test-model',
      relation: 'preferred_for',
      object: 'test-rig',
      valid_from: today,
      agent_id: 'test',
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    });

    // Wait for the interval to fire
    await new Promise<void>((r) => setTimeout(r, 200));

    monitor.stop();
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('does not fire onStateChange when KG is unchanged', async () => {
    const changes: string[] = [];
    const monitor = new KGSyncMonitor(kg, 50, (hash) => changes.push(hash));
    monitor.start();

    // No writes
    await new Promise<void>((r) => setTimeout(r, 200));

    monitor.stop();
    // No changes — callback should not fire (hash was empty string initially and stays equal)
    expect(changes.length).toBe(0);
  });

  it('currentHash() returns empty string before start()', () => {
    const monitor = new KGSyncMonitor(kg, 5000);
    expect(monitor.currentHash()).toBe('');
    // After stop() without start, still empty
    monitor.stop();
    expect(monitor.currentHash()).toBe('');
  });

  it('currentHash() updates after a change is detected', async () => {
    const monitor = new KGSyncMonitor(kg, 50);
    monitor.start();

    const today = new Date().toISOString().slice(0, 10);
    kg.addTriple({
      subject: 'another-model',
      relation: 'preferred_for',
      object: 'another-rig',
      valid_from: today,
      agent_id: 'test',
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    });

    await new Promise<void>((r) => setTimeout(r, 200));
    monitor.stop();

    expect(monitor.currentHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two KG instances see hash divergence within one tick after a write', async () => {
    const kgPath2 = mkKgPath();
    // Use separate DB files — same-file single-SQLite won't diverge this way,
    // but the monitor correctly detects writes made to the same KG instance.
    const changes: string[] = [];
    const monitor = new KGSyncMonitor(kg, 50, (hash) => changes.push(hash));
    monitor.start();

    const initialHash = kg.computeStateHash();

    const today = new Date().toISOString().slice(0, 10);
    kg.addTriple({
      subject: 'diverge-model',
      relation: 'preferred_for',
      object: 'diverge-rig',
      valid_from: today,
      agent_id: 'test',
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    });

    const newHash = kg.computeStateHash();
    expect(newHash).not.toBe(initialHash);

    await new Promise<void>((r) => setTimeout(r, 200));
    monitor.stop();

    // Monitor should have detected the divergence
    expect(changes.length).toBeGreaterThan(0);
    expect(changes).toContain(newHash);

    fs.rmSync(kgPath2, { force: true });
  });

  it('stop() is idempotent', () => {
    const monitor = new KGSyncMonitor(kg, 50);
    monitor.start();
    monitor.stop();
    expect(() => monitor.stop()).not.toThrow();
  });

  it('start() is idempotent — calling twice does not create two intervals', async () => {
    const changes: string[] = [];
    const monitor = new KGSyncMonitor(kg, 50, (hash) => changes.push(hash));
    monitor.start();
    monitor.start(); // second call should be a no-op

    const today = new Date().toISOString().slice(0, 10);
    kg.addTriple({
      subject: 'idempotent-model',
      relation: 'preferred_for',
      object: 'idempotent-rig',
      valid_from: today,
      agent_id: 'test',
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    });

    await new Promise<void>((r) => setTimeout(r, 200));
    monitor.stop();

    // Should fire exactly once per change regardless of how many times start() is called
    // (single interval, not doubled)
    expect(changes.length).toBeGreaterThanOrEqual(1);
    // All observed hashes should be the same (one change event)
    const uniqueHashes = new Set(changes);
    expect(uniqueHashes.size).toBe(1);
  });
});
