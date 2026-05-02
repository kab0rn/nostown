import { handleQueenInput } from '../../src/cli/queen-shell';

describe('Queen shell commands', () => {
  it('renders the Gas City config snippet', async () => {
    let output = '';
    const keepGoing = await handleQueenInput('/gas', (text) => { output += text; });

    expect(keepGoing).toBe(true);
    expect(output).toContain('[[agent]]');
    expect(output).toContain('sling_query = "nt gascity swarm --bead {} --mode apply --json"');
  });

  it('renders doctor output as a human table instead of raw JSON', async () => {
    let output = '';
    const keepGoing = await handleQueenInput('/doctor', (text) => { output += text; });

    expect(keepGoing).toBe(true);
    expect(output).toContain('Gas City Bridge Doctor');
    expect(output).toContain('nos_home');
    expect(output.trim().startsWith('{')).toBe(false);
  });

  it('leaves the shell on /exit', async () => {
    let output = '';
    const keepGoing = await handleQueenInput('/exit', (text) => { output += text; });

    expect(keepGoing).toBe(false);
    expect(output).toBe('');
  });

  it('documents /quit in help and exits with it', async () => {
    let output = '';
    expect(await handleQueenInput('/help', (text) => { output += text; })).toBe(true);
    expect(output).toContain('/quit');

    output = '';
    expect(await handleQueenInput('/quit', (text) => { output += text; })).toBe(false);
    expect(output).toBe('');
  });

  it('does not start /swarm work when already interrupted', async () => {
    let output = '';
    const controller = new AbortController();
    controller.abort();

    const keepGoing = await handleQueenInput('/swarm gc-123', (text) => { output += text; }, { signal: controller.signal });

    expect(keepGoing).toBe(true);
    expect(output).toContain('interrupted');
    expect(output).toContain('gc-123');
  });

  it('keeps free-form text out of legacy role orchestration', async () => {
    let output = '';
    const keepGoing = await handleQueenInput('please swarm gc-123 after checking context', (text) => { output += text; });

    expect(keepGoing).toBe(true);
    expect(output).toContain('Queen is bridge-first');
    expect(output).toContain('/swarm <bead>');
  });
});
