import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { identity } from '../src/auth.js';

test('generated key pair signs tokens the API accepts and keeps the private key out of stdout', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cantelop-keys-')); t.after(() => rm(dir, {recursive:true, force:true}));
  const out = join(dir, 'auth.private.jwk.json');
  const {stdout} = await promisify(execFile)(process.execPath, ['scripts/generate-auth-keys.mjs', out]);
  const publicJwk = /^AUTH_PUBLIC_JWK=(.+)$/m.exec(stdout)![1]!;
  assert.deepEqual(Object.keys(JSON.parse(publicJwk)).sort(), ['crv','kty','x','y']);
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  const key = await crypto.subtle.importKey('jwk', JSON.parse(await readFile(out, 'utf8')), {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${encode({alg:'ES256'})}.${encode({sub:'alice', iss:'test', aud:'api', exp:Math.floor(Date.now()/1000)+900})}`;
  const signature = Buffer.from(await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, new TextEncoder().encode(input))).toString('base64url');
  const user = await identity(new Request('https://app.example', {headers:{authorization:`Bearer ${input}.${signature}`}}),
    {AUTH_PUBLIC_JWK:publicJwk, AUTH_ISSUER:'test', AUTH_AUDIENCE:'api'});
  assert.match(user.workspaceSlug, /^u-[a-f0-9]{48}$/);
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/generate-auth-keys.mjs', out]));
});
