import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listComb, writeComb } from '../../src/gascity/comb';

describe('Gas City comb storage', () => {
  const oldComb = process.env.NOS_COMB_DIR;
  let combDir: string;

  beforeEach(() => {
    combDir = path.join(os.tmpdir(), `nos-comb-hardening-${Date.now()}-${Math.random()}`);
    process.env.NOS_COMB_DIR = combDir;
  });

  afterEach(() => {
    if (oldComb === undefined) delete process.env.NOS_COMB_DIR;
    else process.env.NOS_COMB_DIR = oldComb;
    fs.rmSync(combDir, { recursive: true, force: true });
  });

  it('writes comb records atomically with restrictive permissions and secret redaction', () => {
    const file = writeComb({
      run_id: 'nos-hardening',
      bead_id: 'gc-1',
      created_at: '2026-05-02T00:00:00.000Z',
      request: {
        apiKey: 'gsk_supersecret12345',
        instructions: `use Bearer abcdefghijklmnop and ${'x'.repeat(9000)}`,
      },
      responses: [{ raw: 'y'.repeat(9000) }],
    });

    expect(path.basename(file)).toBe('nos-hardening.json');
    expect(fs.readdirSync(combDir).some((entry) => entry.endsWith('.tmp'))).toBe(false);

    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('gsk_supersecret');
    expect(content).not.toContain('abcdefghijklmnop');
    expect(content).toContain('[redacted]');
    expect(content).toContain('[truncated ');

    if (process.platform !== 'win32') {
      expect(fs.statSync(combDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('skips corrupt comb records when rendering trails', () => {
    writeComb({
      run_id: 'nos-good',
      bead_id: 'gc-1',
      created_at: '2026-05-02T00:00:00.000Z',
    });
    fs.writeFileSync(path.join(combDir, 'broken.json'), '{not json', 'utf8');

    expect(listComb()).toHaveLength(1);
    expect(listComb()[0].run_id).toBe('nos-good');
  });

  it('removes temp files when an atomic rename fails', () => {
    fs.mkdirSync(combDir, { recursive: true });
    fs.mkdirSync(path.join(combDir, 'nos-rename-fail.json'));

    expect(() => writeComb({
      run_id: 'nos-rename-fail',
      bead_id: 'gc-1',
      created_at: '2026-05-02T00:00:00.000Z',
    })).toThrow();

    expect(fs.readdirSync(combDir).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });
});
