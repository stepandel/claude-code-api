import test from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../src/service.js';
import { server, config } from '../src/server.js';
import { cliArgs } from '../src/runtime.js';
class FakeRuntime {
  signedIn = false; runs = [];
  async provision(id) { return `cantelop-${id}`; }
  async auth() { return this.signedIn; }
  async remove() {}
  run(user, session, message, emit) {
    let resolve, reject;
    const done = new Promise((a,b) => { resolve = a; reject = b; });
    session.resume = true;
    const run = { message, resolve, reject, emit, done,
      stop: async () => { reject(new Error('cancelled')); await done.catch(() => {}); } };
    this.runs.push(run); return run;
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const runtime = new FakeRuntime(), service = new Service(runtime);
  const auth = await service.allocate(), user = service.user(auth.token);
  runtime.signedIn = true;
  const view = await service.create(user, config({ tools: ['Read'] }));
  return { runtime, service, user, s: service.session(user, view.id) };
}
test('queue is FIFO; steering interrupts then runs before pending messages', async () => {
  const {runtime, service, user, s} = await fixture();
  const a = service.send(user,s,'a','queue');
  service.send(user,s,'b','queue');
  service.send(user,s,'c','steer');
  await tick();
  assert.equal(s.messages.find(m => m.id === a.id).status, 'steered');
  assert.deepEqual(runtime.runs.map(r => r.message.text), ['a','c']);
  runtime.runs[1].resolve(); await tick();
  assert.deepEqual(runtime.runs.map(r => r.message.text), ['a','c','b']);
  runtime.runs[2].resolve(); await tick(); assert.equal(s.active, null);
});
test('queued cancellation does not interrupt current turn; failure releases queue', async () => {
  const {runtime, service, user, s} = await fixture();
  service.send(user,s,'a','queue'); const b = service.send(user,s,'b','queue');
  service.cancel(s,b.id); service.send(user,s,'c','queue');
  runtime.runs[0].reject(new Error('failure')); await tick();
  assert.deepEqual(s.messages.map(m => m.status), ['failed','cancelled','running']);
  assert.equal(runtime.runs[1].message.text,'c');
  service.cancel(s,s.active.message.id); await tick(); assert.equal(s.active,null);
});
test('failed cancellation never starts overlapping work', async () => {
  const {runtime, service, user, s} = await fixture();
  service.send(user,s,'a','queue');
  runtime.runs[0].stop = async () => { throw new Error('unreachable'); };
  service.send(user,s,'b','steer'); await tick();
  assert.equal(runtime.runs.length,1); assert.equal(s.active.message.text,'a');
  runtime.runs[0].resolve(); await tick(); assert.equal(runtime.runs.length,2);
});
test('CLI arguments isolate MCP configuration and retain conversation identity', () => {
  const s = {id:'abc', tools:[], allowedTools:[], mcps:{}, resume:false};
  const args = cliArgs(s);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--tools')+1], '');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(cliArgs({...s,resume:true}).includes('--resume'));
});
test('HTTP auth, ownership, validation, events and credential rejection', async t => {
  const runtime = new FakeRuntime(), service = new Service(runtime), admin = 'a'.repeat(32);
  const app = server(service,admin); await new Promise(r => app.listen(0,'127.0.0.1',r));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.address().port}`;
  const req = async (path, token, data, method = 'POST') => {
    const res = await fetch(url+path,{method,headers:{authorization:`Bearer ${token}`}, ...(method==='POST'?{body:JSON.stringify(data ?? {})}:{})});
    return {status:res.status, body:await res.json()};
  };
  assert.equal((await req('/v1/auth','wrong')).status,401);
  assert.equal((await req('/v1/auth',admin,{claudeToken:'secret'})).status,400);
  const a = (await req('/v1/auth',admin)).body;
  assert.equal((await req('/v1/auth/complete',a.token)).status,401);
  runtime.signedIn = true;
  assert.equal((await req('/v1/auth/complete',a.token)).status,200);
  assert.equal((await req('/v1/sessions',a.token,{mcps:{bad:{type:'http',url:'file:///etc/passwd'}}})).status,400);
  const s = (await req('/v1/sessions',a.token,{tools:['Read']})).body;
  const b = (await req('/v1/auth',admin)).body;
  assert.equal((await req(`/v1/sessions/${s.id}`,b.token,null,'GET')).status,404);
  const m = await req(`/v1/sessions/${s.id}/messages`,a.token,{text:'hello'});
  assert.equal(m.status,202);
  runtime.runs[0].resolve(); await tick();
  const events = await req(`/v1/sessions/${s.id}/events?after=0`,a.token,null,'GET');
  assert.ok(events.body.events.some(e => e.type==='message.completed'));
  assert.equal((await req(`/v1/sessions/${s.id}/events?after=-1`,a.token,null,'GET')).status,400);
});
