import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const subject = process.argv[2] ?? 'local-user';
await mkdir('.dev',{recursive:true,mode:0o700});
let privateKey;
try { privateKey = createPrivateKey(await readFile('.dev/signing-key.pem')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const pair = generateKeyPairSync('ec',{namedCurve:'P-256'}); privateKey = pair.privateKey;
  await writeFile('.dev/signing-key.pem',privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const publicJwk = pair.publicKey.export({format:'jwk'});
  await writeFile('.dev/public.env',`AUTH_PUBLIC_JWK='${JSON.stringify(publicJwk)}'\nAUTH_ISSUER=cantelop-claude-api-dev\nAUTH_AUDIENCE=cantelop-claude-api\n`,{mode:0o600});
}
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const head = encode({alg:'ES256',typ:'JWT'});
const body = encode({iss:'cantelop-claude-api-dev',aud:'cantelop-claude-api',sub:subject,exp:Math.floor(Date.now()/1000)+3600});
const signature = sign('sha256',Buffer.from(`${head}.${body}`),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
console.log(`${head}.${body}.${signature}`);
