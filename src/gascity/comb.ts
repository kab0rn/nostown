import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { redactForStorage } from './redaction.js';

export interface CombRecord {
  run_id: string;
  bead_id: string;
  created_at: string;
  [key: string]: unknown;
}

export function combDir(): string {
  return path.resolve(process.env.NOS_COMB_DIR ?? path.join(process.env.NOS_HOME ?? process.cwd(), 'comb'));
}

export function writeComb(record: CombRecord): string {
  const dir = combDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort on filesystems that do not honor POSIX permissions.
  }
  const file = path.join(dir, `${sanitize(record.run_id)}.json`);
  const tmp = path.join(dir, `${sanitize(record.run_id)}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(redactForStorage(record), null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; preserve the original write/rename failure.
    }
    throw err;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort on filesystems that do not honor POSIX permissions.
  }
  return file;
}

export function listComb(limit = 20): CombRecord[] {
  const dir = combDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(dir, file))
    .sort()
    .reverse()
    .slice(0, limit)
    .flatMap((file) => {
      try {
        return [JSON.parse(fs.readFileSync(file, 'utf8')) as CombRecord];
      } catch {
        return [];
      }
    });
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
