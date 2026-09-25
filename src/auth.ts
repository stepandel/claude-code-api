import type { ApiEnvironment } from '@cantelop/sdk/api';
import { ApiError } from './validation.js';
const encoder = new TextEncoder();
const DEMO_ISSUER = 'cantelop-blog-demo';
const DEMO_AUDIENCE = 'cantelop-claude-api-demo';
function decode(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid base64url');
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
// Verify an externally issued application identity. Only the public key enters
// Cantelop: a compromised native agent must not be able to mint tenant tokens.
export async function identity(request: Request, env: ApiEnvironment) {
  try {
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token || token.length > 8192) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const [head, body, signature] = parts as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(decode(head)));
    const claims = JSON.parse(new TextDecoder().decode(decode(body)));
    if (header.alg !== 'ES256' || header.crit !== undefined) throw new Error();
    const demo = header.jwk !== undefined;
    const jwk = demo ? publicJwk(header.jwk) : configuredJwk(env);
    const key = await crypto.subtle.importKey('jwk', jwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['verify']);
    if (!await crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, key, decode(signature), encoder.encode(`${head}.${body}`))) throw new Error();
    const now = Date.now()/1000;
    if (demo) {
      const thumbprint = await jwkThumbprint(jwk);
      if (claims.iss !== DEMO_ISSUER || claims.aud !== DEMO_AUDIENCE || claims.sub !== thumbprint ||
        !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 || claims.iat < now - 10 * 60 ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp - claims.iat > 10 * 60) throw new Error();
    } else if (claims.iss !== env.AUTH_ISSUER || claims.aud !== env.AUTH_AUDIENCE || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now))) throw new Error();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([claims.iss, claims.sub]))));
    const userId = Array.from(hash.slice(0,24), b => b.toString(16).padStart(2,'0')).join('');
    return { userId, workspaceSlug: `u-${userId}`, demo };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, 'Valid application bearer token required');
  }
}

function configuredJwk(env: ApiEnvironment): JsonWebKey {
  if (!env.AUTH_PUBLIC_JWK || !env.AUTH_ISSUER || !env.AUTH_AUDIENCE) throw new ApiError(503, 'Application identity is not configured');
  return publicJwk(JSON.parse(env.AUTH_PUBLIC_JWK));
}

function publicJwk(value: unknown): JsonWebKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const jwk = value as JsonWebKey;
  if (jwk.d || jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
    typeof jwk.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y)) throw new Error();
  return {kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y};
}

async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify({crv:'P-256',kty:'EC',x:jwk.x,y:jwk.y})));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
