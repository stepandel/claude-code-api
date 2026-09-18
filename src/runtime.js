import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function cliArgs(session) {
  return ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--setting-sources', '',
    '--tools', session.tools.join(','), '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: session.mcps }),
    ...(session.allowedTools.length ? ['--allowedTools', session.allowedTools.join(',')] : []),
    ...(session.resume ? ['--resume', session.id] : ['--session-id', session.id])];
}

export class DockerRuntime {
  constructor(image = 'cantelop-runner:local') { this.image = image; }
  async docker(args) {
    return (await exec('docker', args, { timeout: 30_000, maxBuffer: 2 ** 20 })).stdout;
  }
  async provision(id) {
    const container = `cantelop-${id}`;
    try {
      await this.docker(['run', '-d', '--name', container, '--init',
        '--label', 'app=cantelop', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--memory=2g', '--cpus=2', '--pids-limit=256', this.image]);
      return container;
    } catch (error) {
      await this.docker(['rm', '-f', container]).catch(() => {});
      throw error;
    }
  }
  async auth(user) {
    try {
      const result = JSON.parse(await this.docker(['exec', user.container, 'claude', 'auth', 'status']));
      return result.loggedIn === true;
    } catch { return false; }
  }
  async remove(user) { await this.docker(['rm', '-f', user.container]); }
  run(user, session, message, emit) {
    const pidFile = `/tmp/cantelop-${message.id}.pid`;
    const child = spawn('docker', ['exec', '-i', user.container, 'setsid', 'sh', '-c',
      'echo $$ > "$1"; shift; exec "$@"', 'cantelop', pidFile, 'claude', ...cliArgs(session)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', result = false, failure = false, settled = false;
    child.stdout.setEncoding('utf8');
    child.stdin.on('error', () => {});
    child.stdin.end(message.text);
    // Do not send stderr to the API: diagnostics may contain credentials from MCP servers.
    child.stderr.resume();
    const done = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        if (buffer.length > 4 * 1024 * 1024) { failure = true; void stop(); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'system' && event.subtype === 'init') session.resume = true;
            if (event.type === 'result') { result = true; failure ||= event.is_error === true; }
            emit(event);
          } catch { /* Ignore non-protocol diagnostic lines. */ }
        }
      });
      child.once('error', () => { settled = true; reject(new Error('Unable to start Claude Code')); });
      child.once('close', code => {
        settled = true;
        void this.docker(['exec', user.container, 'rm', '-f', pidFile]).catch(() => {});
        if (code === 0 && result && !failure) resolve();
        else reject(new Error('Claude Code turn did not complete successfully'));
      });
    });
    let stopping;
    const stop = () => stopping ??= (async () => {
      // Wait for the pid file if cancellation races process startup. Signal the entire
      // process group inside the container, not just the local docker client.
      if (settled) return;
      await this.docker(['exec', user.container, 'sh', '-c',
        'i=0; while [ ! -s "$1" ] && [ "$i" -lt 100 ]; do sleep .05; i=$((i+1)); done; ' +
        '[ -s "$1" ] || exit 1; p=$(cat "$1"); /bin/kill -TERM -- "-$p" 2>/dev/null || true; ' +
        'sleep 1; /bin/kill -KILL -- "-$p" 2>/dev/null || true', 'cantelop', pidFile]);
      await done.catch(() => {});
    })();
    return { done, stop };
  }
}
