import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionConfig } from './contracts.js';
const exec = promisify(execFile);
export function claudeEnv(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH','HOME','TMPDIR','LANG','TERM','SSL_CERT_FILE','SSL_CERT_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.CLAUDE_CONFIG_DIR = `${workspace}/.claude`;
  return env;
}
export function cliArgs(config: SessionConfig, conversationId: string, resume: boolean): string[] {
  return ['-p','--output-format','stream-json','--verbose','--permission-mode','dontAsk',
    '--setting-sources','', '--tools',config.tools.join(','), '--strict-mcp-config',
    '--mcp-config',JSON.stringify({mcpServers:config.mcps}),
    ...(config.allowedTools.length ? ['--allowedTools', config.allowedTools.join(',')] : []),
    resume ? '--resume' : '--session-id', conversationId];
}
export interface Turn {
  config: SessionConfig; conversationId: string; resume: boolean; text: string; signal: AbortSignal;
  emit(event: unknown): Promise<void>;
  initialized(): Promise<void>;
}
export interface ClaudeRuntime { authenticated(): Promise<boolean>; run(turn: Turn): Promise<void> }
export class NativeClaude implements ClaudeRuntime {
  constructor(private workspace = '/workspace', private binary = 'claude') {}
  async authenticated(): Promise<boolean> {
    try {
      const {stdout} = await exec(this.binary,['auth','status'],{cwd:this.workspace,env:claudeEnv(this.workspace),timeout:15000,maxBuffer:65536});
      return JSON.parse(stdout).loggedIn === true;
    } catch { return false; }
  }
  async run(turn: Turn): Promise<void> {
    turn.signal.throwIfAborted();
    const child = spawn(this.binary,cliArgs(turn.config,turn.conversationId,turn.resume),{
      cwd:this.workspace,env:claudeEnv(this.workspace),detached:true,stdio:['pipe','pipe','pipe']
    });
    let exited = false, escalation: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid,signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    };
    const stop = () => {
      if (exited || escalation) return;
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'),1000);
    };
    const done = new Promise<number | null>((resolve,reject) => {
      child.once('error',reject);
      child.once('close',code => { exited = true; resolve(code); });
    });
    // Attach immediately: spawn failures can precede reading stdout.
    void done.catch(() => {});
    turn.signal.addEventListener('abort',stop,{once:true});
    if (turn.signal.aborted) stop();
    child.stdin.on('error',() => {}); child.stdin.end(turn.text);
    child.stderr.resume(); child.stdout.setEncoding('utf8');
    let pending = '', result = false, failed = false;
    const line = async (text: string) => {
      if (!text.trim()) return;
      let event: Record<string,unknown>;
      try { event = JSON.parse(text); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'system' && event.subtype === 'init') await turn.initialized();
      if (event.type === 'result') { result = true; failed ||= event.is_error === true; }
      await turn.emit(event);
    };
    try {
      for await (const chunk of child.stdout) {
        pending += chunk;
        if (pending.length > 4 * 1024 * 1024) throw new Error('Claude output frame exceeds limit');
        let index: number;
        while ((index = pending.indexOf('\n')) >= 0) {
          const text = pending.slice(0,index); pending = pending.slice(index+1); await line(text);
        }
      }
      await line(pending);
      const code = await done;
      turn.signal.throwIfAborted();
      if (code !== 0 || !result || failed) throw new Error('Claude turn failed');
    } finally {
      stop();
      // Always await the real native process, even when output transport fails.
      await done.catch(() => {});
      if (escalation) clearTimeout(escalation);
      // Remove leftover tools in this turn's process group before the next turn.
      signalGroup('SIGKILL');
      turn.signal.removeEventListener('abort',stop);
    }
  }
}
