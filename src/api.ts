import { defineApi, type HttpMethod } from '@cantelop/sdk/api';
import type { Command } from './contracts.js';
import { identity } from './auth.js';
import { ApiError, config, fail, fields, readBody, uuid } from './validation.js';

export default defineApi<Command>(({ app, router, env }) => {
  const route = (method: HttpMethod, path: string, handle: (r: Request) => Promise<Response>) => {
    router.route(method, path, async ({ request }) => {
      try { return await handle(request); }
      catch (error) {
        return Response.json({error: error instanceof ApiError ? error.message : 'Operation failed'},
          {status: error instanceof ApiError ? error.status : 500, headers:{'cache-control':'no-store'}});
      }
    });
  };
  const userSession = async (request: Request, sessionId: unknown) => {
    const user = await identity(request, env);
    if (typeof sessionId !== 'string' || !sessionId.startsWith(`${user.userId}:`)) throw new ApiError(404, 'Session not found');
    const suffix = sessionId.slice(user.userId.length + 1);
    if (suffix !== 'auth') uuid(suffix);
    return app.sessions.open({id: sessionId, workspaceSlug: user.workspaceSlug, keepAliveSeconds: 300});
  };
  const accepted = (sessionId: string, message: {id:string}, extra = {}) => Response.json(
    {sessionId, receiptId: message.id, ...extra}, {status:202, headers:{'cache-control':'no-store'}});
  route('GET', '/health', async () => Response.json({ok:true}));
  route('POST', '/v1/auth', async request => {
    const user = await identity(request, env);
    fields(await readBody(request), []);
    const workspace = await app.workspaces.open({slug:user.workspaceSlug});
    const session = app.sessions.open({id:`${user.userId}:auth`, workspaceSlug:user.workspaceSlug, keepAliveSeconds:900});
    const receipt = await session.dispatch({type:'auth.prepare'});
    return accepted(session.id, receipt, {workspaceId:workspace.id, workspaceSlug:workspace.slug, workspace:'/workspace',
      nativeLogin: 'CLAUDE_CONFIG_DIR=/workspace/.claude claude auth login',
      next: 'Use a trusted terminal attached to this user workspace, complete native sign-in, then POST /v1/auth/complete. Terminal access is not provided by this scaffold.'});
  });
  route('POST', '/v1/auth/complete', async request => {
    const user = await identity(request, env); fields(await readBody(request), []);
    const session = app.sessions.open({id:`${user.userId}:auth`, workspaceSlug:user.workspaceSlug, keepAliveSeconds:300});
    return accepted(session.id, await session.dispatch({type:'auth.check'}));
  });
  route('POST', '/v1/sessions', async request => {
    const user = await identity(request, env), settings = config(await readBody(request));
    const session = app.sessions.open({id:`${user.userId}:${crypto.randomUUID()}`, workspaceSlug:user.workspaceSlug, keepAliveSeconds:300});
    return accepted(session.id, await session.dispatch({type:'configure', config:settings}));
  });
  route('POST', '/v1/messages', async request => {
    const b = await readBody(request); fields(b, ['sessionId','text','mode','messageId']);
    const session = await userSession(request, b.sessionId);
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 8000) fail('text must contain 1–8000 characters');
    if (b.mode !== undefined && b.mode !== 'queue' && b.mode !== 'steer') fail('Invalid message mode');
    const id = b.messageId === undefined ? crypto.randomUUID() : uuid(b.messageId);
    return accepted(session.id, await session.dispatch({type:b.mode ?? 'queue', id, text:b.text}), {messageId:id});
  });
  route('POST', '/v1/cancel', async request => {
    const b = await readBody(request); fields(b,['sessionId','messageId']);
    const session = await userSession(request,b.sessionId), id = uuid(b.messageId);
    return accepted(session.id, await session.dispatch({type:'cancel',id}), {messageId:id});
  });
  route('POST', '/v1/snapshot', async request => {
    const b = await readBody(request); fields(b,['sessionId']);
    const session = await userSession(request,b.sessionId);
    return accepted(session.id, await session.dispatch({type:'snapshot'}));
  });
  route('GET', '/v1/events', async request => {
    const session = await userSession(request,new URL(request.url).searchParams.get('sessionId'));
    return session.events(request);
  });
});
