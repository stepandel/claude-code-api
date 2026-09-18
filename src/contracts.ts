export type McpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
export interface SessionConfig {
  tools: string[];
  allowedTools: string[];
  mcps: Record<string, McpServer>;
}
export type Command =
  | { type: 'auth.prepare' | 'auth.check' | 'snapshot' | 'drain' }
  | { type: 'configure'; config: SessionConfig }
  | { type: 'queue' | 'steer'; id: string; text: string }
  | { type: 'cancel'; id: string };
export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'steered' | 'interrupted';
export interface Message { id: string; text: string; status: Status }
export type Event =
  | { type: 'auth.required'; command: string; workspace: string }
  | { type: 'auth.status'; authenticated: boolean }
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.state'; messages: Message[]; configured: boolean; truncated: boolean }
  | { type: 'message.status'; id: string; status: Status }
  | { type: 'claude'; id: string; event: unknown }
  | { type: 'claude.fragment'; id: string; eventId: string; index: number; total: number; json: string }
  | { type: 'error'; code: string };
