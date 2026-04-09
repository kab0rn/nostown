// NOS Town — MemPalace HTTP Client

import type { KGTriple } from '../types/index.js';

const DEFAULT_URL = 'http://localhost:7474';

export interface DrawerEntry {
  id: string;
  wing_id: string;
  hall_type: string;
  room_id: string;
  content: string;
  created_at: string;
  embedding_keywords?: string;
}

export interface WakeupResult {
  wing_id: string;
  l0: string;
  l1: string;
  facts: DrawerEntry[];
}

export interface SearchResult {
  results: DrawerEntry[];
  total: number;
}

export interface PalaceStatus {
  wings: number;
  rooms: number;
  drawers: number;
  kg_triples: number;
  state_hash: string;
}

export interface Wing {
  id: string;
  metadata?: Record<string, unknown>;
}

export interface Room {
  id: string;
  wing_id: string;
  metadata?: Record<string, unknown>;
}

export interface Tunnel {
  wing_a: string;
  wing_b: string;
  room_name: string;
}

export interface DiaryEntry {
  id: number;
  wing_id: string;
  content: string;
  created_at: string;
}

export class MemPalaceClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.MEMPALACE_URL ?? DEFAULT_URL).replace(/\/$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += '?' + qs;
    }

    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MemPalace HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Wake up a wing — returns L0+L1 context for session start
   */
  async wakeup(wing: string, roles?: string[]): Promise<WakeupResult> {
    return this.request<WakeupResult>('POST', '/palace/wakeup', { wing_id: wing, roles });
  }

  /**
   * Semantic search across palace drawers
   */
  async search(query: string, wing?: string, hall?: string): Promise<SearchResult> {
    return this.request<SearchResult>('POST', '/palace/search', { query, wing_id: wing, hall_type: hall });
  }

  /**
   * Add a drawer (verbatim bead/playbook/session log)
   */
  async addDrawer(
    wing: string,
    hall: string,
    room: string,
    content: string,
    keywords?: string,
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/palace/drawer', {
      wing_id: wing,
      hall_type: hall,
      room_id: room,
      content,
      embedding_keywords: keywords,
    });
  }

  /**
   * Delete a drawer by ID
   */
  async deleteDrawer(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('DELETE', `/palace/drawer/${id}`);
  }

  /**
   * Add a KG triple
   */
  async kgAdd(triple: Omit<KGTriple, 'id' | 'created_at'>): Promise<{ triple_id: number }> {
    return this.request<{ triple_id: number }>('POST', '/kg/add', triple);
  }

  /**
   * Query KG triples for a subject
   */
  async kgQuery(
    subject: string,
    asOf?: string,
    relation?: string,
  ): Promise<KGTriple[]> {
    const params: Record<string, string> = { subject };
    if (asOf) params.as_of = asOf;
    if (relation) params.relation = relation;
    return this.request<KGTriple[]>('GET', '/kg/query', undefined, params);
  }

  /**
   * Get the full timeline of triples for a subject
   */
  async kgTimeline(subject: string): Promise<KGTriple[]> {
    return this.request<KGTriple[]>('GET', `/kg/timeline/${encodeURIComponent(subject)}`);
  }

  /**
   * Invalidate a KG triple
   */
  async kgInvalidate(
    tripleId: number,
    validTo: string,
    reason?: string,
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('POST', '/kg/invalidate', { triple_id: tripleId, valid_to: validTo, reason });
  }

  /**
   * Write a diary entry for a wing
   */
  async diaryWrite(wing: string, content: string): Promise<{ id: number }> {
    return this.request<{ id: number }>('POST', '/diary/write', { wing_id: wing, content });
  }

  /**
   * Read diary entries for a wing
   */
  async diaryRead(wing: string, limit?: number): Promise<DiaryEntry[]> {
    const params: Record<string, string> = {};
    if (limit !== undefined) params.limit = String(limit);
    return this.request<DiaryEntry[]>('GET', `/diary/read/${encodeURIComponent(wing)}`, undefined, params);
  }

  /**
   * Get palace server status
   */
  async getStatus(): Promise<PalaceStatus> {
    return this.request<PalaceStatus>('GET', '/palace/status');
  }

  /**
   * List all wings
   */
  async listWings(): Promise<Wing[]> {
    return this.request<Wing[]>('GET', '/palace/wings');
  }

  /**
   * List rooms in a wing
   */
  async listRooms(wingId: string): Promise<Room[]> {
    return this.request<Room[]>('GET', `/palace/rooms/${encodeURIComponent(wingId)}`);
  }

  /**
   * List tunnels (cross-rig connections)
   */
  async getTunnels(): Promise<Tunnel[]> {
    return this.request<Tunnel[]>('GET', '/palace/tunnels');
  }

  /**
   * Save an agent checkpoint (plan) to MemPalace.
   * Returns the checkpoint ID for use in BEAD_DISPATCH.
   * Uses /palace/checkpoint dedicated endpoint.
   */
  async saveCheckpoint(
    agentId: string,
    plan: Record<string, unknown>,
    beadIds: string[],
  ): Promise<string> {
    const result = await this.request<{ checkpoint_id: string }>('POST', '/palace/checkpoint', {
      agent_id: agentId,
      plan,
      bead_ids: beadIds,
    });
    return result.checkpoint_id;
  }

  /**
   * Verify a checkpoint exists in MemPalace.
   */
  async verifyCheckpoint(checkpointId: string): Promise<boolean> {
    try {
      const result = await this.request<{ valid?: boolean }>('GET', `/palace/checkpoint/${encodeURIComponent(checkpointId)}`);
      return result.valid === true;
    } catch {
      return false;
    }
  }
}
