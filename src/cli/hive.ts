import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { bold, cyan, gray, green, red, yellow, divider } from './ui.js';
import { combDir, listComb } from '../gascity/comb.js';

export function renderHiveStatus(): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${bold(cyan('NOS Town Hive'))}  ${gray('bridge-first runtime')}`);
  lines.push(divider('', 62));
  lines.push(row('Queen shell', 'nt queen attach'));
  lines.push(row('Comb', combDir()));
  lines.push(row('bd', commandState('bd')));
  lines.push(row('Groq', process.env.GROQ_API_KEY ? green('configured') : yellow('not configured')));
  lines.push(row('DeepSeek', process.env.DEEPSEEK_API_KEY ? green('configured') : yellow('not configured')));
  lines.push(row('NOS_HOME', process.env.NOS_HOME ?? findHomeFile() ?? gray('not set')));
  lines.push('');
  return lines.join('\n');
}

export function renderCombTrail(limit = 10): string {
  const records = listComb(limit);
  const lines: string[] = [];
  lines.push(divider('Comb', 62));
  if (records.length === 0) {
    lines.push(`  ${gray('No swarm runs recorded.')}`);
  } else {
    for (const record of records) {
      const status = typeof record.result === 'object' && record.result !== null
        ? String((record.result as Record<string, unknown>).status ?? 'unknown')
        : 'unknown';
      lines.push(`  ${cyan(record.run_id)}  ${gray(record.bead_id)}  ${status}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function row(label: string, value: string): string {
  return `  ${gray(label.padEnd(12))} ${value}`;
}

function commandState(command: string): string {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return green('available');
  } catch {
    return red('missing');
  }
}

function findHomeFile(): string | null {
  const homeFile = path.join(os.homedir(), '.nostown', 'home');
  if (!fs.existsSync(homeFile)) return null;
  return fs.readFileSync(homeFile, 'utf8').trim() || null;
}
