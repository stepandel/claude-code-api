import { claudeAuth } from '@cantelop/sdk/harnesses/claude';
import { once } from 'node:events';
export interface LoginProcess {done:Promise<number|null>;write(data:string):Promise<void>;stop():void}
export type LoginLauncher = (signal:AbortSignal, output:(text:string)=>Promise<void>)=>LoginProcess;

/** The demo's existing link/code UI wraps the SDK's stock native auth process. */
export function nativeLogin(_workspace = '/workspace', helper = '/opt/app/login-pty.py', binary = '/usr/local/bin/claude'): LoginLauncher {
  return (signal,output) => {
    signal.throwIfAborted();
    let child:Awaited<ReturnType<typeof claudeAuth.terminal>>|undefined;
    const stop = () => {child?.kill('SIGTERM');};
    signal.addEventListener('abort',stop,{once:true});
    const launched = Promise.resolve(claudeAuth.terminal({signal,session:{id:'auth',keepAliveSeconds:900},
      env:{CLAUDE_PATH:binary,LOGIN_PTY_HELPER:helper}})).then(process => {child=process;if(signal.aborted) stop();return process;});
    const done = launched.then(async process => {
      const exited = new Promise<number|null>((resolve,reject) => {
        process.once('close',resolve);process.once('error',reject);
      });
      void exited.catch(()=>{});
      try {
        let bytes=0;
        for await (const chunk of process.stdout!) {
          const text=Buffer.from(chunk).toString('utf8');bytes+=Buffer.byteLength(text);
          if(bytes>512*1024) throw new Error('Login output limit');
          for(let index=0;index<text.length;index+=4000) await output(text.slice(index,index+4000));
        }
        return await exited;
      } finally {stop();await exited.catch(()=>{});signal.removeEventListener('abort',stop);}
    });
    void done.catch(()=>{signal.removeEventListener('abort',stop);});
    return {done,stop,write:async data => {
      signal.throwIfAborted();const process=await launched;
      if(!process.stdin?.writable) throw new Error('Login ended');
      if(!process.stdin.write(data)) await once(process.stdin,'drain');
    }};
  };
}
