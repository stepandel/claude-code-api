import { randomUUID, randomBytes, createHash } from 'node:crypto';
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const hash = token => createHash('sha256').update(token).digest('hex');
export class Service {
  users = new Map(); sessions = new Map();
  constructor(runtime) { this.runtime = runtime; }
  async allocate() {
    if (this.users.size >= 100) throw new ApiError(429, 'User capacity reached');
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    const user = { id, tokenHash: hash(token), container: await this.runtime.provision(id) };
    this.users.set(user.tokenHash, user);
    return { userId: id, token, workspace: '/workspace',
      login: { command: ['docker', 'exec', '-it', user.container, 'claude', 'auth', 'login'],
        terminal: ['docker', 'exec', '-it', user.container, 'bash'],
        instructions: 'Sign in directly through Claude Code in your isolated terminal, then POST /v1/auth/complete. All native authentication methods remain available.' } };
  }
  user(token) {
    const user = this.users.get(hash(token));
    if (!user) throw new ApiError(401, 'Invalid Cantelop token');
    return user;
  }
  async authenticate(user) {
    if (!await this.runtime.auth(user)) throw new ApiError(401, 'Complete native Claude Code authentication first');
    return { authenticated: true, userId: user.id, workspace: '/workspace' };
  }
  async create(user, config) {
    await this.authenticate(user);
    if ([...this.sessions.values()].filter(s => s.userId === user.id).length >= 20)
      throw new ApiError(429, 'Session capacity reached');
    const session = { id: randomUUID(), userId: user.id, ...config, resume: false,
      messages: [], queue: [], active: null, events: [], sequence: 0 };
    this.sessions.set(session.id, session);
    return this.view(session);
  }
  session(user, id) {
    const s = this.sessions.get(id);
    if (!s || s.userId !== user.id) throw new ApiError(404, 'Session not found');
    return s;
  }
  view(s) { return { id: s.id, workspace: '/workspace', tools: s.tools,
    mcpNames: Object.keys(s.mcps), activeMessageId: s.active?.message.id ?? null,
    messages: s.messages.map(({ id, text, status }) => ({ id, text, status })) }; }
  event(s, type, data) {
    s.events.push({ id: ++s.sequence, type, data });
    if (s.events.length > 1000) s.events.shift();
  }
  send(user, s, text, mode) {
    if (s.messages.length >= 1000) throw new ApiError(429, 'Session message capacity reached');
    const m = { id: randomUUID(), text, status: 'queued' };
    s.messages.push(m);
    if (mode === 'steer') {
      s.queue.unshift(m);
      if (s.active) this.stop(s, 'steered');
    } else s.queue.push(m);
    this.event(s, 'message.queued', { messageId: m.id, mode });
    this.pump(user, s);
    return { ...m };
  }
  stop(s, status) {
    const active = s.active;
    if (!active || active.stopping) return;
    active.stopping = true; active.finalStatus = status;
    // A failed stop must not release the queue or start an overlapping turn.
    active.stopPromise = active.handle.stop().catch(() => {
      this.event(s, 'cancel.failed', { messageId: active.message.id });
      active.stopping = false; active.finalStatus = undefined;
    });
  }
  cancel(s, id) {
    const m = s.messages.find(m => m.id === id);
    if (!m) throw new ApiError(404, 'Message not found');
    if (s.active?.message.id === id) this.stop(s, 'cancelled');
    else if (m.status === 'queued') {
      s.queue = s.queue.filter(item => item !== m); m.status = 'cancelled';
      this.event(s, 'message.cancelled', { messageId: id });
    }
    return { ...m };
  }
  pump(user, s) {
    if (s.active || !s.queue.length) return;
    const message = s.queue.shift(); message.status = 'running';
    const active = { message }; s.active = active;
    this.event(s, 'message.running', { messageId: message.id });
    void (async () => {
      try {
        active.handle = this.runtime.run(user, s, message, event => this.event(s, 'claude', { messageId: message.id, event }));
        await active.handle.done;
        message.status = active.finalStatus ?? 'completed';
      } catch { message.status = active.finalStatus ?? 'failed'; }
      // Stop may still be escalating signals; never start the next turn before it returns.
      await active.stopPromise;
      this.event(s, `message.${message.status}`, { messageId: message.id });
      s.active = null; this.pump(user, s);
    })();
  }
  async close() {
    // Drop queues before stopping processes so shutdown cannot launch another turn.
    for (const s of this.sessions.values()) { s.queue = []; if (s.active) this.stop(s, 'cancelled'); }
    await Promise.all([...this.sessions.values()].map(s => s.active?.stopPromise));
    await Promise.all([...this.users.values()].map(u => this.runtime.remove(u)));
  }
}
