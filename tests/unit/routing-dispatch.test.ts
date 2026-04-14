// Tests: KG-backed routing dispatch (Gate 2)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { RoutingDispatcher, getTaskComplexity } from '../../src/routing/dispatch';
import { KnowledgeGraph } from '../../src/kg/index';
import type { PlaybookEntry } from '../../src/types/index';

const TEST_KG = path.join(os.tmpdir(), `nos-routing-kg-${Date.now()}.sqlite`);

let kg: KnowledgeGraph;
let dispatcher: RoutingDispatcher;

beforeAll(() => {
  kg = new KnowledgeGraph(TEST_KG);
  dispatcher = new RoutingDispatcher(kg);
});

afterAll(() => {
  kg.close();
  fs.rmSync(TEST_KG, { force: true });
});

describe('RoutingDispatcher', () => {
  it('routes to complexity-appropriate model with no KG data', () => {
    const decision = dispatcher.dispatch({
      role: 'polecat',
      taskType: 'unit_test',
      rigName: 'test-rig',
    });

    // unit_test is 'low' complexity → llama-3.1-8b-instant
    expect(decision.model).toBe('llama-3.1-8b-instant');
    expect(decision.locked).toBe(false);
    expect(decision.playbookUsed).toBe(false);
  });

  it('routes high complexity tasks to appropriate model', () => {
    const decision = dispatcher.dispatch({
      role: 'polecat',
      taskType: 'security',
      rigName: 'test-rig',
    });

    expect(decision.model).toBe('qwen/qwen3-32b');
    expect(decision.reason).toMatch(/Complexity routing.*high/);
  });

  it('uses playbook shortcut when playbook is provided', () => {
    const playbook: PlaybookEntry = {
      id: 'pb-001',
      title: 'Unit Test Playbook',
      task_type: 'unit_test',
      steps: ['Write test', 'Assert'],
      model_hint: 'llama-3.1-8b-instant',
      created_at: new Date().toISOString(),
    };

    const decision = dispatcher.dispatch({
      role: 'polecat',
      taskType: 'unit_test',
      rigName: 'test-rig',
      playbookHit: playbook,
    });

    expect(decision.playbookUsed).toBe(true);
    expect(decision.reason).toMatch(/Playbook shortcut/);
  });

  it('uses KG routing lock when present', () => {
    const today = new Date().toISOString().slice(0, 10);

    // Write a routing lock: llama-3.1-8b-instant locked_to 'execute'
    kg.addTriple({
      subject: 'llama-3.1-8b-instant',
      relation: 'locked_to',
      object: 'execute',
      valid_from: today,
      agent_id: 'historian_test',
      metadata: { class: 'critical', success_rate: 0.95 },
      created_at: new Date().toISOString(),
    });

    const decision = dispatcher.dispatch({
      role: 'polecat',
      taskType: 'execute',
      rigName: 'test-rig',
    });

    expect(decision.locked).toBe(true);
    expect(decision.model).toBe('llama-3.1-8b-instant');
    expect(decision.reason).toMatch(/KG routing lock/);
  });

  it('provides fallback model in all decisions', () => {
    const decision = dispatcher.dispatch({
      role: 'polecat',
      taskType: 'unit_test',
      rigName: 'test-rig',
    });

    expect(decision.fallback).toBeDefined();
    expect(typeof decision.fallback).toBe('string');
  });
});

describe('preferred_for tiebreaker (GAP M2)', () => {
  let prefKg: KnowledgeGraph;
  let prefDispatcher: RoutingDispatcher;
  const PREF_KG = path.join(os.tmpdir(), `nos-pref-kg-${Date.now()}.sqlite`);

  beforeAll(() => {
    prefKg = new KnowledgeGraph(PREF_KG);
    prefDispatcher = new RoutingDispatcher(prefKg);
  });

  afterAll(() => {
    prefKg.close();
    fs.rmSync(PREF_KG, { force: true });
  });

  it('uses preferred_for model as tiebreaker when no lock or demotion', () => {
    const today = new Date().toISOString().slice(0, 10);
    const preferredModel = 'meta-llama/llama-4-scout-17b-16e-instruct';

    prefKg.addTriple({
      subject: preferredModel,
      relation: 'preferred_for',
      object: 'preferred-rig',
      valid_from: today,
      agent_id: 'historian_01',
      metadata: { class: 'advisory', success_rate: 0.92, qualifying_task_types: 6 },
      created_at: new Date().toISOString(),
    });

    const decision = prefDispatcher.dispatch({
      role: 'polecat',
      taskType: 'unit_test',
      rigName: 'preferred-rig',
    });

    expect(decision.model).toBe(preferredModel);
    expect(decision.reason).toMatch(/preferred_for tiebreaker/);
    expect(decision.locked).toBe(false);
  });

  it('does not use preferred_for when model with 90% success on only 2 task types', () => {
    // The preferred_for triple is only written when ≥5 qualifying task types — this
    // test verifies the dispatcher does NOT apply it if no such triple exists for a rig.
    const decision = prefDispatcher.dispatch({
      role: 'polecat',
      taskType: 'execute',
      rigName: 'non-preferred-rig',  // no preferred_for triple for this rig
    });

    // Should fall back to complexity routing, not preferred_for
    expect(decision.reason).toMatch(/Complexity routing/);
  });
});

describe('getTaskComplexity', () => {
  it('returns correct complexity for known task types', () => {
    expect(getTaskComplexity('unit_test')).toBe('low');
    expect(getTaskComplexity('execute')).toBe('medium');
    expect(getTaskComplexity('security')).toBe('high');
    expect(getTaskComplexity('architecture')).toBe('critical');
  });

  it('defaults to medium for unknown task types', () => {
    expect(getTaskComplexity('unknown_task_type')).toBe('medium');
  });
});
