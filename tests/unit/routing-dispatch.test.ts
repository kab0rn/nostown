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

    expect(decision.model).toBe('qwen-qwen3-32b');
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
