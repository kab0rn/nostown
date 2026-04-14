// NOS Town — CLI UI Primitives
// ANSI color/format utilities matching Gas Town look and feel.
// Gracefully degrades to plain text when stdout is not a TTY.

const USE_COLOR = process.stdout.isTTY && process.env.NO_COLOR === undefined;

// ── ANSI codes ────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
export const ansi = {
  reset:     USE_COLOR ? `${ESC}0m`  : '',
  bold:      USE_COLOR ? `${ESC}1m`  : '',
  dim:       USE_COLOR ? `${ESC}2m`  : '',
  italic:    USE_COLOR ? `${ESC}3m`  : '',

  black:     USE_COLOR ? `${ESC}30m` : '',
  red:       USE_COLOR ? `${ESC}31m` : '',
  green:     USE_COLOR ? `${ESC}32m` : '',
  yellow:    USE_COLOR ? `${ESC}33m` : '',
  blue:      USE_COLOR ? `${ESC}34m` : '',
  magenta:   USE_COLOR ? `${ESC}35m` : '',
  cyan:      USE_COLOR ? `${ESC}36m` : '',
  white:     USE_COLOR ? `${ESC}37m` : '',
  gray:      USE_COLOR ? `${ESC}90m` : '',

  bgRed:     USE_COLOR ? `${ESC}41m` : '',
  bgGreen:   USE_COLOR ? `${ESC}42m` : '',
  bgYellow:  USE_COLOR ? `${ESC}43m` : '',
  bgBlue:    USE_COLOR ? `${ESC}44m` : '',
  bgMagenta: USE_COLOR ? `${ESC}45m` : '',
  bgCyan:    USE_COLOR ? `${ESC}46m` : '',

  clearLine: USE_COLOR ? `\r${ESC}2K` : '\r',
  up1:       USE_COLOR ? `${ESC}1A`  : '',
  saveCursor:    USE_COLOR ? '\x1b7' : '',
  restoreCursor: USE_COLOR ? '\x1b8' : '',
};

export function c(color: keyof typeof ansi, text: string): string {
  if (!USE_COLOR) return text;
  return `${ansi[color]}${text}${ansi.reset}`;
}

export function bold(text: string): string  { return c('bold', text); }
export function dim(text: string): string   { return c('dim', text); }
export function green(text: string): string { return c('green', text); }
export function red(text: string): string   { return c('red', text); }
export function yellow(text: string): string { return c('yellow', text); }
export function cyan(text: string): string  { return c('cyan', text); }
export function gray(text: string): string  { return c('gray', text); }
export function blue(text: string): string  { return c('blue', text); }
export function magenta(text: string): string { return c('magenta', text); }

// ── Role icons ─────────────────────────────────────────────────────────────────
export const ROLE_ICON: Record<string, string> = {
  mayor:     '🎩',
  polecat:   '🐾',
  witness:   '👁 ',
  safeguard: '🛡 ',
  historian: '📚',
  refinery:  '⚗️ ',
  deacon:    '🐺',
};

// ── Status icons ───────────────────────────────────────────────────────────────
export const STATUS_ICON = {
  running:     green('●'),
  idle:        gray('○'),
  busy:        cyan('⚙'),
  done:        green('✓'),
  failed:      red('✗'),
  blocked:     yellow('⏸'),
  pending:     gray('⏳'),
  in_progress: cyan('⚙'),
  warn:        yellow('⚠'),
};

// ── Section divider ────────────────────────────────────────────────────────────
export function divider(label = '', width = 60): string {
  if (!label) return gray('─'.repeat(width));
  const line = gray('─── ') + bold(label) + ' ';
  const fill = Math.max(0, width - label.length - 5);
  return line + gray('─'.repeat(fill));
}

// ── Box / panel helpers ────────────────────────────────────────────────────────
export function header(title: string, subtitle = ''): string {
  const sub = subtitle ? gray(`  ${subtitle}`) : '';
  return `\n${bold(cyan(title))}${sub}`;
}

// ── Time formatting ────────────────────────────────────────────────────────────
export function relativeTime(date: Date | string | undefined): string {
  if (!date) return gray('—');
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 0) return gray('now');
  if (ms < 2000) return gray('just now');
  if (ms < 60_000) return gray(`${Math.floor(ms / 1000)}s ago`);
  if (ms < 3600_000) return gray(`${Math.floor(ms / 60_000)}m ago`);
  if (ms < 86_400_000) return gray(`${Math.floor(ms / 3600_000)}h ago`);
  return gray(`${Math.floor(ms / 86_400_000)}d ago`);
}

export function durationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

export function hhmm(date: Date | string): string {
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Table layout ──────────────────────────────────────────────────────────────
/** Strip ANSI codes for length calculation */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b7|\x1b8/g, '');
}

export function padEnd(s: string, width: number): string {
  const len = stripAnsi(s).length;
  return s + ' '.repeat(Math.max(0, width - len));
}

export function col(text: string, width: number): string {
  return padEnd(text, width);
}

// ── Spinner ───────────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private label: string;
  private active = false;

  constructor(label: string) {
    this.label = label;
  }

  start(): void {
    if (!process.stdout.isTTY || this.active) return;
    this.active = true;
    this.timer = setInterval(() => {
      const ch = cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]);
      process.stdout.write(`${ansi.clearLine}${ch} ${this.label}`);
      this.frame++;
    }, 80);
  }

  update(label: string): void {
    this.label = label;
  }

  stop(finalMsg?: string): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (process.stdout.isTTY) {
      process.stdout.write(ansi.clearLine);
    }
    if (finalMsg) process.stdout.write(finalMsg + '\n');
  }
}

// ── Progress bar ─────────────────────────────────────────────────────────────
export function progressBar(done: number, total: number, width = 20): string {
  if (total === 0) return gray('░'.repeat(width));
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return green('█'.repeat(filled)) + gray('░'.repeat(empty));
}
