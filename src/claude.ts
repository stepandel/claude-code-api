import { NativeClaude as ClaudeHarness, claudeAuth } from '@cantelop/sdk/harnesses/claude';
import type { SessionContext } from '@cantelop/sdk/session';
import type { Command, Event, Reply, SessionConfig } from './contracts.js';

export interface Turn {
  config: SessionConfig; conversationId: string; resume: boolean; text: string; signal: AbortSignal;
  context: SessionContext<Command,Event,Reply>;
  emit(event: unknown): Promise<void>;
  initialized(): Promise<void>;
}
export interface ClaudeRuntime { authenticated(): Promise<boolean>; logout(): Promise<void>; run(turn: Turn): Promise<void> }
export { ClaudeAuthenticationRequired as NativeAuthRequired } from '@cantelop/sdk/harnesses/claude';

/** Adapt the demo's durable mailbox to the SDK-maintained native runner. */
export class NativeClaude implements ClaudeRuntime {
  constructor(private workspace = '/workspace', private binary = '/usr/local/bin/claude') {}
  private authContext() {
    return {signal:new AbortController().signal,session:{id:'auth',keepAliveSeconds:0},env:{CLAUDE_PATH:this.binary}};
  }
  authenticated(): Promise<boolean> {return Promise.resolve(claudeAuth.status(this.authContext()));}
  async logout(): Promise<void> {
    await claudeAuth.logout(this.authContext());
    if (await this.authenticated()) throw new Error('Claude sign-out could not be confirmed');
  }
  async run(turn: Turn): Promise<void> {
    const {context,config} = turn;
    const native = new ClaudeHarness({
      workspace:this.workspace, binary:this.binary, sessionId:context.session.id,
      ...(config.model && config.model !== 'default' ? {model:config.model} : {}),
      permissionMode:'dontAsk',settingSources:[],tools:config.tools,allowedTools:config.allowedTools,
      mcps:config.mcps,maxTurns:config.maxTurns,systemPrompt:config.systemPrompt,
      conversation:{id:turn.conversationId,resumable:turn.resume},
    },turn.signal);
    const message = {type:'prompt' as const,prompt:turn.text};
    await native.queue(message,{
      ...context,signal:turn.signal,message:{...context.message,payload:message},
      send:input => {void context.send({type:'queue',id:crypto.randomUUID(),text:input.prompt});},
      output:{send:async event => {
        if (event.type === 'system' && event.subtype === 'init') await turn.initialized();
        await turn.emit(event);
      }},
    });
  }
}
