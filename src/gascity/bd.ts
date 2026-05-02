import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GasCityBead } from './types.js';
import { CONSENSUS_METADATA_KEY_SET } from './metadata.js';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

export const defaultRunner: CommandRunner = async (cmd, args) => {
  const result = await execFileAsync(cmd, args, {
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8',
    env: process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export class BdClient {
  constructor(private readonly runner: CommandRunner = defaultRunner) {}

  async show(beadId: string): Promise<GasCityBead> {
    let jsonErr: unknown;
    try {
      const { stdout } = await this.runner('bd', ['show', '--id', beadId, '--json']);
      return normalizeBead(JSON.parse(stdout) as Record<string, unknown>, beadId);
    } catch (err) {
      jsonErr = err;
    }

    try {
      const { stdout } = await this.runner('bd', ['show', '--id', beadId]);
      return {
        id: beadId,
        title: firstLabeledLine(stdout, 'Title') ?? firstNonEmptyLine(stdout) ?? beadId,
        description: stdout.trim(),
        raw: stdout,
      };
    } catch (textErr) {
      throw new Error(`bd show failed for ${beadId}; json=${describeError(jsonErr)}; text=${describeError(textErr)}`);
    }
  }

  async ready(): Promise<GasCityBead[]> {
    try {
      const { stdout } = await this.runner('bd', ['ready', '--json']);
      const parsed = JSON.parse(stdout) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item, idx) => normalizeBead(item as Record<string, unknown>, `ready-${idx}`));
      }
    } catch {
      // Fall through to text mode.
    }
    const { stdout } = await this.runner('bd', ['ready']);
    return stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ id: line.split(/\s+/)[0], title: line, raw: line }));
  }

  async setMetadata(beadId: string, metadata: Record<string, string>): Promise<void> {
    const args = ['update', beadId, '--json', '--quiet'];
    for (const [key, value] of Object.entries(metadata)) {
      if (!CONSENSUS_METADATA_KEY_SET.has(key)) {
        throw new Error(`refusing to write unsupported NOSTown consensus metadata key: ${key}`);
      }
      args.push('--set-metadata', `${key}=${value}`);
    }
    if (args.length > 4) await this.runner('bd', args);
  }
}

function normalizeBead(raw: Record<string, unknown>, fallbackId: string): GasCityBead {
  const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
    ? Object.fromEntries(Object.entries(raw.metadata as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
    : undefined;
  return {
    id: stringField(raw, 'id') ?? stringField(raw, 'ID') ?? fallbackId,
    title: stringField(raw, 'title') ?? stringField(raw, 'Title'),
    description: stringField(raw, 'description') ?? stringField(raw, 'Description'),
    status: stringField(raw, 'status') ?? stringField(raw, 'Status'),
    type: stringField(raw, 'type') ?? stringField(raw, 'Type'),
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : undefined,
    metadata,
    raw,
  };
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function firstLabeledLine(text: string, label: string): string | undefined {
  const prefix = `${label}:`;
  return text.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split('\n').map((line) => line.trim()).find(Boolean);
}

function describeError(err: unknown): string {
  if (!err) return 'unknown';
  if (err instanceof Error) return err.message;
  return String(err);
}
