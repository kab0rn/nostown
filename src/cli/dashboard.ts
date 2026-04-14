// NOS Town — `nt dash` live dashboard
// Refreshes the terminal with current status + active beads every N seconds.

import type { WorkerRuntime } from '../runtime/worker-loop.js';
import { renderStatus, renderQueue } from './status.js';
import { renderTrail } from './trail.js';
import { ansi, cyan, gray, bold } from './ui.js';

interface DashboardOptions {
  agentId: string;
  rigName: string;
  runtime: WorkerRuntime;
  historianCron: string;
  uptime: Date;
  refreshMs?: number;  // default 2000
}

export class Dashboard {
  private opts: Required<DashboardOptions>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private firstRender = true;
  private lastLineCount = 0;

  constructor(opts: DashboardOptions) {
    this.opts = { refreshMs: 2000, ...opts };
  }

  start(): void {
    if (!process.stdout.isTTY) {
      // Non-TTY: render once and exit
      this.render();
      return;
    }

    this.running = true;
    // Hide cursor
    process.stdout.write('\x1b[?25l');

    this.render();
    this.timer = setInterval(() => {
      if (!this.running) return;
      this.render();
    }, this.opts.refreshMs);

    const cleanup = (): void => {
      this.stop();
      process.stdout.write('\x1b[?25h'); // restore cursor
      process.stdout.write('\n');
      process.exit(0);
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Restore cursor
    process.stdout.write('\x1b[?25h');
  }

  private render(): void {
    const { agentId, rigName, runtime, historianCron, uptime } = this.opts;

    const content =
      renderStatus({ agentId, rigName, runtime, historianCron, uptime }) +
      renderQueue(rigName, 6) +
      renderTrail(15);

    const lines = content.split('\n');

    if (this.firstRender) {
      this.firstRender = false;
      process.stdout.write(content);
    } else {
      // Move cursor up by however many lines we wrote last time
      process.stdout.write(`\x1b[${this.lastLineCount}A`);
      // Overwrite with new content — pad each line to clear old content
      const cols = process.stdout.columns ?? 80;
      const cleared = lines.map((l) => {
        // Strip ANSI then measure
        const plain = l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b[78]/g, '');
        const pad = Math.max(0, cols - plain.length);
        return l + ' '.repeat(pad);
      });
      process.stdout.write(cleared.join('\n'));
    }

    this.lastLineCount = lines.length;

    // Footer: refresh indicator
    const refreshSec = this.opts.refreshMs / 1000;
    const footer = `\n${gray('  refreshes every ' + refreshSec + 's · ')}${cyan('ctrl-c')}${gray(' to exit')}`;
    process.stdout.write(footer);
    this.lastLineCount += 2;
  }
}
