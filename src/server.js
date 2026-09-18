import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './service.js';
const fail = message => { throw new ApiError(400, message); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function fields(v, names) {
  if (!object(v) || Object.keys(v).some(k => !names.includes(k))) fail('Invalid object fields');
}
const strings = v => Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 200 && !x.includes(','));
export function config(body) {
  fields(body, ['tools', 'allowedTools', 'mcps']);
  const tools = body.tools ?? [], allowedTools = body.allowedTools ?? [], mcps = body.mcps ?? {};
  if (!strings(tools) || !strings(allowedTools)) fail('tools and allowedTools must be string arrays');
  if (!object(mcps) || Object.keys(mcps).length > 20) fail('Invalid MCP configuration');
  for (const [name, m] of Object.entries(mcps)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) fail('Invalid MCP name');
    if (m?.type === 'stdio') {
      fields(m, ['type', 'command', 'args', 'env']);
      if (typeof m.command !== 'string' || !m.command || m.command.length > 500) fail('Invalid MCP command');
      if (m.args !== undefined && (!Array.isArray(m.args) || m.args.length > 100 || m.args.some(a => typeof a !== 'string'))) fail('Invalid MCP args');
      if (m.env !== undefined && (!object(m.env) || Object.entries(m.env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string'))) fail('Invalid MCP env');
    } else {
      fields(m, ['type', 'url', 'headers']);
      if (!['http', 'sse'].includes(m.type)) fail('MCP type must be stdio, http or sse');
      let url; try { url = new URL(m.url); } catch { fail('Invalid MCP URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Invalid MCP URL');
      if (m.headers !== undefined && (!object(m.headers) || Object.values(m.headers).some(v => typeof v !== 'string'))) fail('Invalid MCP headers');
    }
  }
  return { tools, allowedTools, mcps };
}
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail('Invalid JSON'); }
}
function same(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function server(service, adminToken) {
  return createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost'), method = req.method;
      if (method === 'GET' && url.pathname === '/health') return reply(200, { ok: true });
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (method === 'POST' && url.pathname === '/v1/auth') {
        if (!same(token, adminToken)) throw new ApiError(401, 'Admin token required');
        fields(await body(req), []);
        return reply(201, await service.allocate());
      }
      const user = service.user(token);
      if (method === 'POST' && url.pathname === '/v1/auth/complete') {
        fields(await body(req), []); return reply(200, await service.authenticate(user));
      }
      if (method === 'POST' && url.pathname === '/v1/sessions')
        return reply(201, await service.create(user, config(await body(req))));
      const match = /^\/v1\/sessions\/([a-f0-9-]+)(?:\/(messages|events)(?:\/([a-f0-9-]+)\/(cancel))?)?$/.exec(url.pathname);
      if (!match) throw new ApiError(404, 'Route not found');
      const s = service.session(user, match[1]);
      if (method === 'GET' && !match[2]) return reply(200, service.view(s));
      if (method === 'GET' && match[2] === 'events' && !match[3]) {
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) fail('Invalid event cursor');
        if (s.events.length && after < s.events[0].id - 1) throw new ApiError(410, 'Event cursor expired; fetch session state');
        return reply(200, { events: s.events.filter(e => e.id > after), cursor: s.sequence });
      }
      if (method === 'POST' && match[2] === 'messages' && !match[3]) {
        const b = await body(req); fields(b, ['text', 'mode']);
        if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 32_000) fail('text must contain 1–32000 characters');
        if (b.mode !== undefined && !['queue', 'steer'].includes(b.mode)) fail('mode must be queue or steer');
        return reply(202, service.send(user, s, b.text, b.mode ?? 'queue'));
      }
      if (method === 'POST' && match[2] === 'messages' && match[4] === 'cancel') {
        fields(await body(req), []); return reply(202, service.cancel(s, match[3]));
      }
      throw new ApiError(404, 'Route not found');
    } catch (error) { reply(error.status ?? 500, { error: error.status ? error.message : 'Runtime operation failed' }); }
  });
}
