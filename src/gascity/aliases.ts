export function pureSwarmAliasArgs(args: string[]): string[] {
  const next: string[] = [];
  let hasJson = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mode') {
      i++;
      continue;
    }
    if (arg.startsWith('--mode=')) continue;
    if (arg === '--json') {
      hasJson = true;
      next.push(arg);
      continue;
    }
    next.push(arg);
  }

  if (!hasJson) next.push('--json');
  return [...next, '--mode', 'pure'];
}
