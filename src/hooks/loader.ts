// NOS Town — Hook Loader

import fs from 'fs';
import path from 'path';
import type { Hook } from '../types/index.js';
import { validateHook } from './validator.js';

const HOOKS_DIR = process.env.NOS_HOOKS_DIR ?? 'hooks';

export function loadHooks(hooksDir?: string): Hook[] {
  const dir = path.resolve(hooksDir ?? HOOKS_DIR);
  if (!fs.existsSync(dir)) return [];

  const hookFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.hook'));
  const hooks: Hook[] = [];

  for (const file of hookFiles) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const validated = validateHook(parsed);
      if (validated.enabled !== false) {
        hooks.push(validated);
      }
    } catch (err) {
      console.error(`[HookLoader] Failed to load ${file}: ${String(err)}`);
    }
  }

  // Sort by priority descending (higher = first)
  hooks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return hooks;
}

export function loadHookById(id: string, hooksDir?: string): Hook | null {
  const all = loadHooks(hooksDir);
  return all.find((h) => h.id === id) ?? null;
}

export function loadHooksForRole(role: string, hooksDir?: string): Hook[] {
  const all = loadHooks(hooksDir);
  return all.filter((h) => h.role.toLowerCase() === role.toLowerCase());
}
