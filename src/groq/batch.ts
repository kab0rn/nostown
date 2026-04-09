// NOS Town — Groq Batch API Client
// Per GROQ_INTEGRATION.md §Batch API Implementation:
// Historian uses Batch API for 70B playbook synthesis at 50% cost reduction.
// Uploads beads_log.jsonl → creates batch job → polls for completion → distills results.

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export interface BatchRequest {
  custom_id: string;
  method: 'POST';
  url: '/v1/chat/completions';
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
  };
}

export interface BatchResult {
  custom_id: string;
  response?: {
    status_code: number;
    body?: {
      choices?: Array<{ message: { content: string } }>;
    };
  };
  error?: { message: string; code?: string };
}

export interface BatchJob {
  id: string;
  status: 'validating' | 'in_progress' | 'completed' | 'failed' | 'expired' | 'cancelling' | 'cancelled';
  output_file_id?: string;
  error_file_id?: string;
  request_counts?: { total: number; completed: number; failed: number };
}

/** Maximum poll attempts before giving up (24h window @ 60s intervals = 1440) */
const MAX_POLL_ATTEMPTS = 1440;
const POLL_INTERVAL_MS = 60_000;

export class GroqBatchClient {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.GROQ_API_KEY ?? '';
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Upload a JSONL file of batch requests and create a batch job.
   * Returns the batch job ID.
   * (GROQ_INTEGRATION.md §Batch API — Job Creation)
   */
  async createBatch(requests: BatchRequest[]): Promise<string> {
    if (requests.length === 0) throw new Error('No requests to batch');

    // Serialize requests to JSONL
    const jsonl = requests.map((r) => JSON.stringify(r)).join('\n');

    // Upload file via multipart/form-data
    const formData = new FormData();
    const blob = new Blob([jsonl], { type: 'application/jsonl' });
    formData.append('file', blob, 'beads_log.jsonl');
    formData.append('purpose', 'batch');

    const uploadRes = await fetch(`${GROQ_BASE_URL}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      throw new Error(`File upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
    }
    const uploadJson = await uploadRes.json() as { id: string };
    const fileId = uploadJson.id;

    // Create batch job
    const batchRes = await fetch(`${GROQ_BASE_URL}/batches`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        input_file_id: fileId,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    });

    if (!batchRes.ok) {
      throw new Error(`Batch creation failed: ${batchRes.status} ${await batchRes.text()}`);
    }
    const batchJson = await batchRes.json() as BatchJob;
    return batchJson.id;
  }

  /**
   * Poll a batch job until completion or failure.
   * Returns results array when job completes.
   * (GROQ_INTEGRATION.md §Batch API — Result Distillation)
   */
  async pollBatch(
    jobId: string,
    options: { intervalMs?: number; maxAttempts?: number } = {},
  ): Promise<BatchResult[]> {
    const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    const maxAttempts = options.maxAttempts ?? MAX_POLL_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await fetch(`${GROQ_BASE_URL}/batches/${encodeURIComponent(jobId)}`, {
        headers: this.headers,
      });

      if (!res.ok) {
        throw new Error(`Batch status check failed: ${res.status}`);
      }
      const job = await res.json() as BatchJob;

      if (job.status === 'completed' && job.output_file_id) {
        return this.downloadResults(job.output_file_id);
      }

      if (job.status === 'failed' || job.status === 'expired' || job.status === 'cancelled') {
        throw new Error(`Batch job ${jobId} ended with status: ${job.status}`);
      }

      // Still in progress — wait before next poll
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }

    throw new Error(`Batch job ${jobId} did not complete within polling window`);
  }

  /**
   * Download and parse batch output JSONL file.
   */
  private async downloadResults(fileId: string): Promise<BatchResult[]> {
    const res = await fetch(`${GROQ_BASE_URL}/files/${encodeURIComponent(fileId)}/content`, {
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(`Result download failed: ${res.status}`);
    }
    const text = await res.text();
    const results: BatchResult[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed) as BatchResult);
      } catch {
        // Malformed line — skip
      }
    }
    return results;
  }

  /**
   * Convenience: create a batch job and wait for results.
   * Used by Historian for nightly 70B playbook synthesis.
   */
  async runBatch(
    requests: BatchRequest[],
    options: { intervalMs?: number; maxAttempts?: number } = {},
  ): Promise<BatchResult[]> {
    const jobId = await this.createBatch(requests);
    console.log(`[GroqBatch] Job created: ${jobId} (${requests.length} requests)`);
    const results = await this.pollBatch(jobId, options);
    console.log(`[GroqBatch] Job ${jobId} complete: ${results.length} results`);
    return results;
  }
}
