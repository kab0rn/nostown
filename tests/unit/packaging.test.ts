import * as fs from 'fs';

describe('packaging hardening', () => {
  it('keeps nt wrapper from sourcing .env as shell code', () => {
    const script = fs.readFileSync('scripts/nt.sh', 'utf8');

    expect(script).not.toContain('source "$PROJECT_DIR/.env"');
    expect(script).not.toContain('set -a && source');
    expect(script).toContain('while IFS= read -r line');
  });

  it('builds install artifacts outside the tracked cmd/nt path', () => {
    const script = fs.readFileSync('scripts/install-nt.sh', 'utf8');

    expect(script).toContain('mktemp -d');
    expect(script).toContain('go build -o "$TMP_DIR/nt"');
    expect(script).not.toContain('go build -o "$BUILD_DIR/nt"');
  });

  it('defines the full CI check as a single npm script', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

    expect(pkg.scripts['test:ci']).toContain('npm run typecheck');
    expect(pkg.scripts['test:ci']).toContain('npm run build');
    expect(pkg.scripts['test:ci']).toContain('npm test -- --runInBand --silent');
    expect(pkg.scripts['test:ci']).toContain('go test ./...');
  });
});
