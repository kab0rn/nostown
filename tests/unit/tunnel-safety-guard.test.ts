// Tests: Tunnel safety guard and stack detection (ROUTING.md §Tunnel Safety Guard)
// Cross-rig tunnel results with incompatible stacks must be logged as advisory-only,
// not used as routing locks. Stack detection is based on bead task metadata.

import { detectStackFamily, areStacksCompatible } from '../../src/swarm/tools';
import type { Bead } from '../../src/types/index';
import { Ledger } from '../../src/ledger/index';

function makeBead(partial: Partial<Bead> & { task_type: string }): Bead {
  return Ledger.createBead({
    role: 'polecat',
    model: 'llama-3.1-8b-instant',
    status: 'done',
    outcome: 'SUCCESS',
    task_description: '',
    ...partial,
  });
}

// ── detectStackFamily ─────────────────────────────────────────────────────────

describe('detectStackFamily (ROUTING.md §Tunnel Safety Guard)', () => {
  it('returns "generic" for empty bead set', () => {
    expect(detectStackFamily([])).toBe('generic');
  });

  it('detects typescript from task_type', () => {
    const beads = [
      makeBead({ task_type: 'typescript_refactor' }),
      makeBead({ task_type: 'typescript_migration' }),
    ];
    expect(detectStackFamily(beads)).toBe('typescript');
  });

  it('detects typescript from task_description keywords', () => {
    const beads = [
      makeBead({ task_type: 'execute', task_description: 'Refactor auth middleware in TypeScript using Jest' }),
    ];
    expect(detectStackFamily(beads)).toBe('typescript');
  });

  it('detects python from task_description', () => {
    const beads = [
      makeBead({ task_type: 'execute', task_description: 'Add pytest tests for the FastAPI endpoint' }),
      makeBead({ task_type: 'execute', task_description: 'Fix pydantic validation in django view' }),
    ];
    expect(detectStackFamily(beads)).toBe('python');
  });

  it('detects go from task_description', () => {
    const beads = [
      makeBead({ task_type: 'execute', task_description: 'Fix goroutine leak in gin handler' }),
    ];
    expect(detectStackFamily(beads)).toBe('go');
  });

  it('detects rust from task_description', () => {
    const beads = [
      makeBead({ task_type: 'execute', task_description: 'Add tokio async runtime for actix handler' }),
    ];
    expect(detectStackFamily(beads)).toBe('rust');
  });

  it('detects java from task_type', () => {
    const beads = [
      makeBead({ task_type: 'java_spring_refactor', task_description: 'Update Spring Boot controller with JUnit tests' }),
    ];
    expect(detectStackFamily(beads)).toBe('java');
  });

  it('returns the dominant stack when mixed signals exist', () => {
    const beads = [
      makeBead({ task_type: 'typescript_migration', task_description: 'Convert JS to TypeScript using npm' }),
      makeBead({ task_type: 'typescript_test', task_description: 'Add jest unit tests for Node.js service' }),
      makeBead({ task_type: 'execute', task_description: 'Add one python helper script' }),
    ];
    // typescript appears more often than python
    expect(detectStackFamily(beads)).toBe('typescript');
  });

  it('returns "generic" when no stack signals detected', () => {
    const beads = [
      makeBead({ task_type: 'execute', task_description: 'Rename variables in the codebase' }),
    ];
    expect(detectStackFamily(beads)).toBe('generic');
  });

  it('detects from model name hints (npm/node model in model field)', () => {
    const beads = [
      makeBead({ task_type: 'execute', task_description: 'configure eslint rules', model: 'llama-3.1-8b-instant' }),
    ];
    // eslint signals typescript/node
    expect(detectStackFamily(beads)).toBe('typescript');
  });
});

// ── areStacksCompatible ───────────────────────────────────────────────────────

describe('areStacksCompatible (ROUTING.md §Tunnel Safety Guard)', () => {
  it('same stack is compatible', () => {
    expect(areStacksCompatible('typescript', 'typescript')).toBe(true);
    expect(areStacksCompatible('python', 'python')).toBe(true);
    expect(areStacksCompatible('go', 'go')).toBe(true);
  });

  it('generic is compatible with anything', () => {
    expect(areStacksCompatible('generic', 'typescript')).toBe(true);
    expect(areStacksCompatible('typescript', 'generic')).toBe(true);
    expect(areStacksCompatible('generic', 'generic')).toBe(true);
    expect(areStacksCompatible('generic', 'python')).toBe(true);
  });

  it('typescript and javascript are compatible (same ecosystem)', () => {
    expect(areStacksCompatible('typescript', 'javascript')).toBe(true);
    expect(areStacksCompatible('javascript', 'typescript')).toBe(true);
  });

  it('typescript and python are incompatible', () => {
    expect(areStacksCompatible('typescript', 'python')).toBe(false);
  });

  it('python and go are incompatible', () => {
    expect(areStacksCompatible('python', 'go')).toBe(false);
  });

  it('rust and java are incompatible', () => {
    expect(areStacksCompatible('rust', 'java')).toBe(false);
  });

  it('go and typescript are incompatible', () => {
    expect(areStacksCompatible('go', 'typescript')).toBe(false);
  });
});
