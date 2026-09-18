import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeClaude, cliArgs, claudeEnv } from '../src/claude.js';
const config = {tools:['Read'],allowedTools:['Read'],mcps:{}};
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(),'cantelop-native-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const binary = join(root,'fake-claude');
  await writeFile(binary,`#!/usr/bin/env node
const {spawn} = require('node:child_process');
if(process.argv[2]==='auth') {console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
let text='';process.stdin.on('data',chunk=>text+=chunk);
process.stdin.on('end',()=>{
 console.log(JSON.stringify({type:'system',subtype:'init'}));
 if(text==='wait') {
   const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'tool.ready'}));setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
   setInterval(()=>{},1000);
 } else {
   console.log(JSON.stringify({type:'assistant',text:'Hello 😀'}));
   process.stdout.write(JSON.stringify({type:'result',is_error:text==='fail'}));
 }
});
`,{mode:0o755});
  return new NativeClaude(root,binary);
}
test('native runner verifies auth, parses Unicode and final non-newline frame',async t => {
  const runtime = await fixture(t), events:unknown[] = []; let initialized = false;
  assert.equal(await runtime.authenticated(),true);
  await runtime.run({config,conversationId:crypto.randomUUID(),resume:false,text:'hello',signal:new AbortController().signal,
    emit:async e=>{events.push(e);},initialized:async()=>{initialized=true;}});
  assert.equal(initialized,true);assert.ok(events.some((e:any)=>e.text==='Hello 😀'));assert.equal((events.at(-1) as any).type,'result');
});
test('native process-group cancellation escalates and waits for stubborn tool descendants',async t => {
  const runtime = await fixture(t), controller = new AbortController();
  const deadline = setTimeout(()=>controller.abort(),4000);t.after(()=>clearTimeout(deadline));
  let ready = false, abortedAt = 0;
  const run = runtime.run({config,conversationId:crypto.randomUUID(),resume:false,text:'wait',signal:controller.signal,
    emit:async (e:any)=>{if(e.type==='tool.ready'){ready=true;abortedAt=Date.now();controller.abort();}},initialized:async()=>{}});
  await assert.rejects(run);
  assert.equal(ready,true);assert.ok(Date.now()-abortedAt>=900,'waited for SIGKILL escalation');
});
test('CLI flags retain explicit tools and MCPs, no shared credentials inherited',()=>{
  const args=cliArgs(config,'id',true);
  assert.ok(args.includes('--strict-mcp-config'));assert.ok(args.includes('--resume'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  process.env.ANTHROPIC_API_KEY='must-not-be-inherited';
  try {assert.equal(claudeEnv('/workspace').ANTHROPIC_API_KEY,undefined);}
  finally {delete process.env.ANTHROPIC_API_KEY;}
});
