#!/usr/bin/env npx tsx
// NOS Town — Key Generation Helper
// Usage: npx tsx scripts/gen-keys.ts --agent <agent_id>
// Generates Ed25519 key pair files in NOS_ROLE_KEY_DIR (default: keys/).

import { generateKeyPair } from '../src/convoys/sign.js';

const args = process.argv.slice(2);
const agentIdx = args.indexOf('--agent');

if (agentIdx === -1 || !args[agentIdx + 1]) {
  console.error('Usage: npx tsx scripts/gen-keys.ts --agent <agent_id>');
  console.error('Example: npx tsx scripts/gen-keys.ts --agent mayor_01');
  process.exit(1);
}

const agentId = args[agentIdx + 1];
const keyDir = process.env.NOS_ROLE_KEY_DIR ?? 'keys';

console.log(`Generating key pair for '${agentId}' in '${keyDir}/'...`);

const { publicKeyHex } = await generateKeyPair(agentId);

console.log(`Generated:`);
console.log(`  ${keyDir}/${agentId}.key  (private — keep secret)`);
console.log(`  ${keyDir}/${agentId}.pub  (public: ${publicKeyHex.slice(0, 16)}...)`);
