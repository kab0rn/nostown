import { pureSwarmAliasArgs } from '../../src/gascity/aliases';

describe('Gas City aliases', () => {
  it('forces nt swarm alias into pure JSON mode without duplicating --json', () => {
    expect(pureSwarmAliasArgs(['gc-1', '--json', '--mode', 'apply', '--workers', '3'])).toEqual([
      'gc-1',
      '--json',
      '--workers',
      '3',
      '--mode',
      'pure',
    ]);
  });

  it('removes inline mode overrides and adds --json when absent', () => {
    expect(pureSwarmAliasArgs(['gc-1', '--mode=apply'])).toEqual([
      'gc-1',
      '--json',
      '--mode',
      'pure',
    ]);
  });
});
