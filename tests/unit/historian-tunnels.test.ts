// Tests: Historian tunnel discovery (ROUTING.md §Cross-Rig Routing)
// Historian.detectAndRegisterTunnels() finds shared room names across wings
// and registers tunnels via MemPalaceClient.registerTunnel().

jest.mock('groq-sdk', () => {
  const mockCreate = jest.fn();
  (globalThis as Record<string, unknown>).__historianTunnelMockCreate = mockCreate;
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
  };
});

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Historian } from '../../src/roles/historian';
import { MemPalaceClient } from '../../src/mempalace/client';
import { KnowledgeGraph } from '../../src/kg/index';

const TEST_DB = path.join(os.tmpdir(), `historian-tunnels-${Date.now()}.sqlite`);
const TEST_RIGS = path.join(os.tmpdir(), `historian-tunnels-rigs-${Date.now()}`);

beforeAll(() => {
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  fs.mkdirSync(TEST_RIGS, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
  jest.restoreAllMocks();
});

function makeHistorian() {
  return new Historian({
    agentId: 'historian_tunnel_test',
    kgPath: TEST_DB,
  });
}

describe('Historian tunnel detection (ROUTING.md §Cross-Rig Routing)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    // Reset KG between tests by using a fresh connection
  });

  it('registers a tunnel when same room exists in two wings', async () => {
    const historian = makeHistorian();

    // Pre-populate KG with a known other wing
    const kg = new KnowledgeGraph(TEST_DB);
    const today = new Date().toISOString().slice(0, 10);
    kg.addTriple({
      subject: 'historian_wings',
      relation: 'registered',
      object: 'wing_rig_other-rig',
      valid_from: today,
      agent_id: 'historian_tunnel_test',
      metadata: { class: 'advisory', room_count: '3' },
      created_at: new Date().toISOString(),
    });
    kg.close();

    const listRoomsSpy = jest.spyOn(MemPalaceClient.prototype, 'listRooms')
      .mockImplementation(async (wing: string) => {
        if (wing === 'wing_rig_my-rig') {
          return [{ id: 'auth-migration', wing_id: wing }, { id: 'ci-setup', wing_id: wing }];
        }
        if (wing === 'wing_rig_other-rig') {
          return [{ id: 'auth-migration', wing_id: wing }, { id: 'deploy-flow', wing_id: wing }];
        }
        return [];
      });

    jest.spyOn(MemPalaceClient.prototype, 'getTunnels').mockResolvedValue([]);
    const registerSpy = jest.spyOn(MemPalaceClient.prototype, 'registerTunnel').mockResolvedValue(undefined);

    // Mock other required palace calls for runNightly
    jest.spyOn(MemPalaceClient.prototype, 'addDrawer').mockResolvedValue({ id: 'mock-drawer' });
    jest.spyOn(MemPalaceClient.prototype, 'diaryWrite').mockResolvedValue({ id: 1 });
    jest.spyOn(MemPalaceClient.prototype, 'search').mockResolvedValue({ results: [], total: 0 });

    await (historian as unknown as { detectAndRegisterTunnels: (rig: string) => Promise<void> })
      .detectAndRegisterTunnels('my-rig');

    expect(listRoomsSpy).toHaveBeenCalledWith('wing_rig_my-rig');
    expect(listRoomsSpy).toHaveBeenCalledWith('wing_rig_other-rig');
    expect(registerSpy).toHaveBeenCalledWith('wing_rig_my-rig', 'wing_rig_other-rig', 'auth-migration');
    // ci-setup and deploy-flow are not shared → no tunnel
    expect(registerSpy).toHaveBeenCalledTimes(1);

    historian.close();
  });

  it('skips tunnel registration when tunnel already exists', async () => {
    const historian = makeHistorian();

    const kg = new KnowledgeGraph(TEST_DB);
    const today = new Date().toISOString().slice(0, 10);
    kg.addTriple({
      subject: 'historian_wings',
      relation: 'registered',
      object: 'wing_rig_other-rig',
      valid_from: today,
      agent_id: 'historian_tunnel_test',
      metadata: { class: 'advisory', room_count: '1' },
      created_at: new Date().toISOString(),
    });
    kg.close();

    jest.spyOn(MemPalaceClient.prototype, 'listRooms')
      .mockResolvedValue([{ id: 'shared-room', wing_id: 'any' }]);

    // Existing tunnel already registered
    jest.spyOn(MemPalaceClient.prototype, 'getTunnels').mockResolvedValue([
      { wing_a: 'wing_rig_my-rig', wing_b: 'wing_rig_other-rig', room_name: 'shared-room' },
    ]);
    const registerSpy = jest.spyOn(MemPalaceClient.prototype, 'registerTunnel').mockResolvedValue(undefined);
    jest.spyOn(MemPalaceClient.prototype, 'addDrawer').mockResolvedValue({ id: 'mock-drawer' });

    await (historian as unknown as { detectAndRegisterTunnels: (rig: string) => Promise<void> })
      .detectAndRegisterTunnels('my-rig');

    expect(registerSpy).not.toHaveBeenCalled();
    historian.close();
  });

  it('records the current wing in KG for future cross-rig discovery', async () => {
    const historian = makeHistorian();

    jest.spyOn(MemPalaceClient.prototype, 'listRooms').mockResolvedValue([]);
    jest.spyOn(MemPalaceClient.prototype, 'getTunnels').mockResolvedValue([]);
    jest.spyOn(MemPalaceClient.prototype, 'registerTunnel').mockResolvedValue(undefined);
    jest.spyOn(MemPalaceClient.prototype, 'addDrawer').mockResolvedValue({ id: 'mock-drawer' });

    await (historian as unknown as { detectAndRegisterTunnels: (rig: string) => Promise<void> })
      .detectAndRegisterTunnels('record-wing-rig');

    const kg = new KnowledgeGraph(TEST_DB);
    const today = new Date().toISOString().slice(0, 10);
    const triples = kg.queryTriples('historian_wings', today, 'registered');
    kg.close();
    historian.close();

    const recorded = triples.find((t) => t.object === 'wing_rig_record-wing-rig');
    expect(recorded).toBeDefined();
  });

  it('handles palace unavailable gracefully (non-fatal)', async () => {
    const historian = makeHistorian();

    jest.spyOn(MemPalaceClient.prototype, 'listRooms').mockRejectedValue(new Error('offline'));
    jest.spyOn(MemPalaceClient.prototype, 'getTunnels').mockRejectedValue(new Error('offline'));

    // Should not throw
    await expect(
      (historian as unknown as { detectAndRegisterTunnels: (rig: string) => Promise<void> })
        .detectAndRegisterTunnels('any-rig'),
    ).resolves.toBeUndefined();

    historian.close();
  });
});

describe('Mayor tunnel-enriched playbook search (ROUTING.md §Cross-Rig Routing)', () => {
  it('includes tunnel-connected wings in playbook search', async () => {
    // Verify that Mayor.orchestrate() calls getTunnels() before playbook search
    const { Mayor } = await import('../../src/roles/mayor');
    const { generateKeyPair } = await import('../../src/convoys/sign');

    const keyDir = path.join(os.tmpdir(), `mayor-tunnel-keys-${Date.now()}`);
    fs.mkdirSync(keyDir, { recursive: true });
    process.env.NOS_ROLE_KEY_DIR = keyDir;
    await generateKeyPair('mayor_tunnel_test');

    const getTunnelsSpy = jest.spyOn(MemPalaceClient.prototype, 'getTunnels')
      .mockResolvedValue([
        { wing_a: 'wing_rig_my-rig', wing_b: 'wing_rig_sister-rig', room_name: 'auth-task' },
      ]);

    jest.spyOn(MemPalaceClient.prototype, 'wakeup').mockRejectedValue(new Error('offline'));
    jest.spyOn(MemPalaceClient.prototype, 'search').mockResolvedValue({ results: [], total: 0 });
    jest.spyOn(MemPalaceClient.prototype, 'saveCheckpoint').mockResolvedValue('ckpt-tun-001');

    const mockCreate = (globalThis as Record<string, unknown>).__historianTunnelMockCreate as jest.Mock;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        beads: [{ task_type: 'execute', task_description: 'do stuff', role: 'polecat', needs: [], critical_path: false, witness_required: false, fan_out_weight: 1 }],
      }) } }],
    });

    const mayor = new Mayor({ agentId: 'mayor_tunnel_test', rigName: 'my-rig', kgPath: TEST_DB });
    await mayor.orchestrate({ description: 'Test tunnel search' });
    mayor.close();

    expect(getTunnelsSpy).toHaveBeenCalled();

    fs.rmSync(keyDir, { recursive: true, force: true });
  });
});
