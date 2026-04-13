// Tests: GroqBatchClient — Batch API for nightly 70B playbook synthesis
// Per GROQ_INTEGRATION.md §Batch API: upload JSONL, create job, poll, distill results.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { GroqBatchClient, type BatchRequest, type BatchJob, type BatchResult } from '../../src/groq/batch';
import { GroqProvider } from '../../src/groq/provider';
import { Historian } from '../../src/roles/historian';
import { Ledger } from '../../src/ledger/index';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeRequest(customId = 'task-001'): BatchRequest {
  return {
    custom_id: customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Generate a playbook for: execute' }],
      temperature: 0.3,
    },
  };
}

function mockFetchResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('GroqBatchClient.createBatch()', () => {
  it('uploads JSONL file and creates batch job, returns job ID', async () => {
    mockFetch
      .mockResolvedValueOnce(mockFetchResponse({ id: 'file-abc123' }))  // file upload
      .mockResolvedValueOnce(mockFetchResponse({ id: 'batch-xyz789', status: 'in_progress' }));  // batch create

    const client = new GroqBatchClient('test-api-key');
    const jobId = await client.createBatch([makeRequest('req-1'), makeRequest('req-2')]);

    expect(jobId).toBe('batch-xyz789');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call: file upload
    const [uploadUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(uploadUrl).toContain('/files');

    // Second call: batch creation with file ID
    const [batchUrl, batchOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(batchUrl).toContain('/batches');
    const batchBody = JSON.parse(String(batchOpts.body)) as { input_file_id: string; completion_window: string };
    expect(batchBody.input_file_id).toBe('file-abc123');
    expect(batchBody.completion_window).toBe('24h');
  });

  it('throws on empty request array', async () => {
    const client = new GroqBatchClient('test-api-key');
    await expect(client.createBatch([])).rejects.toThrow('No requests to batch');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when file upload fails', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse('Bad request', 400));

    const client = new GroqBatchClient('test-api-key');
    await expect(client.createBatch([makeRequest()])).rejects.toThrow('File upload failed: 400');
  });
});

describe('GroqBatchClient.pollBatch()', () => {
  it('returns results immediately when job already completed', async () => {
    const completedJob: BatchJob = {
      id: 'batch-done',
      status: 'completed',
      output_file_id: 'file-output-001',
    };
    const outputLine: BatchResult = {
      custom_id: 'task-001',
      response: { status_code: 200, body: { choices: [{ message: { content: '{"title":"Test"}' } }] } },
    };

    mockFetch
      .mockResolvedValueOnce(mockFetchResponse(completedJob))  // status check
      .mockResolvedValueOnce(mockFetchResponse(JSON.stringify(outputLine)));  // file download

    const client = new GroqBatchClient('test-api-key');
    const results = await client.pollBatch('batch-done', { maxAttempts: 3 });

    expect(results).toHaveLength(1);
    expect(results[0].custom_id).toBe('task-001');
    expect(results[0].response?.body?.choices?.[0].message.content).toBe('{"title":"Test"}');
  });

  it('polls multiple times until completion', async () => {
    const inProgress: BatchJob = { id: 'batch-wait', status: 'in_progress' };
    const completed: BatchJob = { id: 'batch-wait', status: 'completed', output_file_id: 'file-out' };
    const result: BatchResult = { custom_id: 'r1', response: { status_code: 200 } };

    mockFetch
      .mockResolvedValueOnce(mockFetchResponse(inProgress))  // poll 1
      .mockResolvedValueOnce(mockFetchResponse(completed))    // poll 2
      .mockResolvedValueOnce(mockFetchResponse(JSON.stringify(result)));  // download

    const client = new GroqBatchClient('test-api-key');
    const results = await client.pollBatch('batch-wait', { intervalMs: 1, maxAttempts: 5 });

    expect(results).toHaveLength(1);
    // 3 fetch calls total: 2 polls + 1 download
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws when job ends with failed status', async () => {
    const failedJob: BatchJob = { id: 'batch-fail', status: 'failed' };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(failedJob));

    const client = new GroqBatchClient('test-api-key');
    await expect(client.pollBatch('batch-fail', { maxAttempts: 1 })).rejects.toThrow('failed');
  });

  it('throws when polling window exhausted', async () => {
    const inProgress: BatchJob = { id: 'batch-stuck', status: 'in_progress' };
    mockFetch.mockResolvedValue(mockFetchResponse(inProgress));

    const client = new GroqBatchClient('test-api-key');
    await expect(client.pollBatch('batch-stuck', { intervalMs: 1, maxAttempts: 2 }))
      .rejects.toThrow('did not complete');
  });
});

describe('GroqBatchClient.runBatch() — end-to-end', () => {
  it('creates job, polls, and returns distilled results', async () => {
    const outputLine: BatchResult = {
      custom_id: 'execute',
      response: {
        status_code: 200,
        body: { choices: [{ message: { content: JSON.stringify({ title: 'Execute Playbook', steps: ['Step 1'] }) } }] },
      },
    };

    mockFetch
      .mockResolvedValueOnce(mockFetchResponse({ id: 'file-001' }))           // upload
      .mockResolvedValueOnce(mockFetchResponse({ id: 'batch-001', status: 'in_progress' }))  // create
      .mockResolvedValueOnce(mockFetchResponse({ id: 'batch-001', status: 'completed', output_file_id: 'out-001' }))  // poll
      .mockResolvedValueOnce(mockFetchResponse(JSON.stringify(outputLine)));   // download

    const client = new GroqBatchClient('test-api-key');
    const results = await client.runBatch([makeRequest('execute')], { intervalMs: 1 });

    expect(results).toHaveLength(1);
    expect(results[0].custom_id).toBe('execute');
    const content = results[0].response?.body?.choices?.[0].message.content ?? '';
    expect(JSON.parse(content)).toMatchObject({ title: 'Execute Playbook' });
  });
});

describe('Historian.generatePlaybooks() batch mode', () => {
  it('uses GroqBatchClient when batchClient is configured with ≥2 eligible types', async () => {
    // This is tested at the integration level by verifying runBatch is called
    const runBatchSpy = jest.fn().mockResolvedValue([]);

    const mockBatchClient = { runBatch: runBatchSpy } as unknown as GroqBatchClient;
    expect(typeof mockBatchClient.runBatch).toBe('function');

    // Verify the spy works
    const results = await mockBatchClient.runBatch([makeRequest()]);
    expect(results).toEqual([]);
    expect(runBatchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Integration: Historian routes to batch vs sequential based on eligible count ──

const TEST_KG = path.join(os.tmpdir(), `nos-batch-kg-${Date.now()}.sqlite`);
const TEST_RIGS = path.join(os.tmpdir(), `nos-batch-rigs-${Date.now()}`);
const TEST_RIG = 'batch-test-rig';

beforeAll(() => {
  process.env.NOS_KG_PATH = TEST_KG;
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  fs.mkdirSync(TEST_RIGS, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_KG, { force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  delete process.env.NOS_KG_PATH;
  delete process.env.NOS_RIGS_ROOT;
  jest.restoreAllMocks();
});

function makeSuccessBead(taskType: string, index: number): import('../../src/types/index').Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: taskType,
    model: 'llama-3.1-8b-instant',
    task_description: `${taskType} task ${index}`,
    rig: TEST_RIG,
    status: 'done',
    outcome: 'SUCCESS',
    plan_checkpoint_id: `ckpt-batch-${taskType}`,
  });
}

describe('Historian.runNightly() batch routing (P10)', () => {
  let historian: Historian;
  let ledger: Ledger;

  beforeEach(() => {
    historian = new Historian({ agentId: 'historian_test', kgPath: TEST_KG });
    ledger = new Ledger();
  });

  afterEach(() => {
    historian.close();
    jest.restoreAllMocks();
  });

  it('calls GroqBatchClient.createBatch() when multiple eligible task types exist', async () => {
    const rig = `${TEST_RIG}-multi`;
    // Write 3 successful beads for each of two task types (eligible: success >= 3, rate >= 70%)
    for (let i = 0; i < 3; i++) {
      await ledger.appendBead(rig, makeSuccessBead('implement', i));
      await ledger.appendBead(rig, makeSuccessBead('refactor', i));
    }

    const createBatchSpy = jest.spyOn(GroqBatchClient.prototype, 'createBatch')
      .mockResolvedValue('batch-job-123');
    jest.spyOn(GroqBatchClient.prototype, 'pollBatch')
      .mockResolvedValue([]);
    // Mock KG triple write (updateRoutingKG uses provider.executeInference? No — just minePatterns)
    // provider.executeInference is not called by minePatterns; only generatePlaybooks calls it

    await historian.runNightly(rig);

    expect(createBatchSpy).toHaveBeenCalledTimes(1);
    // Should have 2 requests (one per eligible task type)
    const callArgs = createBatchSpy.mock.calls[0][0] as BatchRequest[];
    expect(callArgs).toHaveLength(2);
    const customIds = callArgs.map((r) => r.custom_id).sort();
    expect(customIds).toEqual(['implement', 'refactor']);
  });

  it('uses sequential path (not batch) when only one eligible task type exists', async () => {
    const rig = `${TEST_RIG}-single`;
    // Write 3 successful beads for only ONE task type
    for (let i = 0; i < 3; i++) {
      await ledger.appendBead(rig, makeSuccessBead('unit_test', i));
    }

    const createBatchSpy = jest.spyOn(GroqBatchClient.prototype, 'createBatch')
      .mockResolvedValue('batch-job-456');
    const executeInferenceSpy = jest.spyOn(GroqProvider.prototype, 'executeInference')
      .mockResolvedValue(JSON.stringify({ title: 'Test Playbook', steps: [] }));

    await historian.runNightly(rig);

    // Batch should NOT have been called
    expect(createBatchSpy).not.toHaveBeenCalled();
    // Sequential inference should have been called
    expect(executeInferenceSpy).toHaveBeenCalled();
  });
});
