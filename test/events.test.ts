import test from 'node:test';
import assert from 'node:assert/strict';
import { eventsResponse } from '../src/events.js';

test('SSE resumes at the SDK cursor and preserves the event envelope', async () => {
  const event = {cursor:{streamId:'stream',sequence:8},sessionId:'s',messageId:'m',createdAt:new Date(0),data:{type:'session.ready'}};
  let options: any;
  const session = {stream: async function* (input: any) {options=input;yield event;}};
  const response = eventsResponse(session,new Request('https://example/webhooks/v1/events',{headers:{'last-event-id':'stream:7'}}));
  assert.equal(await response.text(),`id: stream:8\ndata: ${JSON.stringify(event)}\n\n`);
  assert.deepEqual(options.after,{streamId:'stream',sequence:7});
  assert.equal(options.signal.aborted,true);
});

test('disconnect aborts the SDK subscription without stopping or cancelling agent work', async () => {
  let signal: AbortSignal | undefined;
  const session = {stream: async function* (options: any) {signal=options.signal;yield {cursor:{streamId:'stream',sequence:1},data:{}};}};
  const reader = eventsResponse(session,new Request('https://example/webhooks/v1/events')).body!.getReader();
  await reader.read();await reader.cancel();
  assert.equal(signal!.aborted,true);
});

test('invalid resume cursors fail before subscribing', () => {
  const session = {stream: async function* () {assert.fail('must not subscribe');}};
  for (const value of ['bad','stream:-1','stream:9007199254740992'])
    assert.throws(() => eventsResponse(session,new Request('https://example/webhooks/v1/events',{headers:{'last-event-id':value}})),/Invalid event cursor/);
});
