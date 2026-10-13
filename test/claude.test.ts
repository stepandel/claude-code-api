import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeClaude,NativeAuthRequired,type Turn} from '../src/claude.js';
const config={tools:['Read'],allowedTools:['Read'],mcps:{}};
async function fixture(t:any) {
  const root=await mkdtemp(join(tmpdir(),'demo-sdk-claude-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const binary=join(root,'claude');
  await writeFile(binary,`#!/usr/bin/env node
if(process.argv[2]==='auth') {console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
const fs=require('node:fs');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{
const args=process.argv.slice(2),index=args.indexOf('--system-prompt-file'),promptPath=index>=0?args[index+1]:undefined;
console.log(JSON.stringify({type:'system',subtype:'init',args,promptPath,systemPrompt:promptPath?fs.readFileSync(promptPath,'utf8'):undefined,promptMode:promptPath?fs.statSync(promptPath).mode&0o777:undefined}));
if(text==='wait') {process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'ready'}));setInterval(()=>{},1000);return;}
if(text==='auth-failure') console.log(JSON.stringify({type:'assistant',error:'authentication_failed'}));
console.log(JSON.stringify({type:'assistant',text:'Hello 😀'}));process.stdout.write(JSON.stringify({type:'result',is_error:text==='fail'}));
});`,{mode:0o755});
  return {runtime:new NativeClaude(root,binary),root};
}
function turn(input:Partial<Turn> & {text:string}):Turn {
  const controller=new AbortController();
  const payload={type:'snapshot' as const};
  return {config,conversationId:crypto.randomUUID(),resume:false,signal:controller.signal,initialized:async()=>{},emit:async()=>{},
    context:{session:{id:'demo-session',keepAliveSeconds:300},env:{},message:{id:crypto.randomUUID(),sequence:1,payload},
      signal:controller.signal,command:{type:'dispatch'},output:{send:async()=>{}},reply:()=>{},send:async()=>{},
      view:{commit:async()=>{}},database:async()=>{throw new Error('Unused');},activity:{} as any},...input};
}
test('imported runner retains file tools, model, turns, MCP limits and native conversation',async t=>{
  const {runtime}=await fixture(t),events:any[]=[],id=crypto.randomUUID();
  await runtime.run(turn({text:'hello',conversationId:id,resume:true,config:{...config,model:'claude-sonnet-5',maxTurns:8},emit:async e=>{events.push(e);}}));
  const args=events[0].args;
  for(const [flag,value] of [['--model','claude-sonnet-5'],['--max-turns','8'],['--tools','Read'],['--allowedTools','Read'],['--permission-mode','dontAsk'],['--resume',id]])
    assert.equal(args[args.indexOf(flag)+1],value);
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config')+1]),{mcpServers:{}});
  assert.ok(events.some(e=>e.text==='Hello 😀'));
});
test('imported runner keeps private system prompts out of args and removes their files',async t=>{
  const {runtime}=await fixture(t),events:any[]=[];
  await runtime.run(turn({text:'hello',config:{...config,systemPrompt:'private instructions'},emit:async e=>{events.push(e);}}));
  const init=events[0];assert.equal(init.systemPrompt,'private instructions');assert.equal(init.promptMode,0o600);
  assert.ok(!init.args.includes('private instructions'));await assert.rejects(access(init.promptPath));
});
test('imported runner interrupts work and preserves native authentication failures',async t=>{
  const {runtime}=await fixture(t),controller=new AbortController();
  await assert.rejects(runtime.run(turn({text:'wait',signal:controller.signal,emit:async(e:any)=>{if(e.type==='ready')controller.abort();}})));
  await assert.rejects(runtime.run(turn({text:'auth-failure'})),NativeAuthRequired);
});
