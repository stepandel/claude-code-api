#!/usr/bin/env node
// Generates the ES256 key pair for application tokens.
// The private JWK belongs to the server that mints tokens; only the public JWK goes in this App's environment.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out || process.argv.length > 3) {
  console.error('Usage: npm run keys -- <private-key-path>   (for example: auth.private.jwk.json)');
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
try {
  writeFileSync(out, `${JSON.stringify(privateKey.export({ format: 'jwk' }))}\n`, { flag: 'wx', mode: 0o600 });
} catch (error) {
  console.error(error.code === 'EEXIST' ? `${out} already exists; refusing to overwrite a signing key.` : error.message);
  process.exit(1);
}
console.error(`Private signing JWK written to ${out} (mode 600). Load it into the token-minting server's secret store; never into this App.`);
console.log(`AUTH_PUBLIC_JWK=${JSON.stringify({ kty, crv, x, y })}`);
