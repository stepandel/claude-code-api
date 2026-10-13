import type { SessionRef } from '@cantelop/sdk';
import { ApiError } from './validation.js';

/** Adapt the SDK subscription to browser SSE; disconnecting never cancels work. */
export function eventsResponse(session: Pick<SessionRef<unknown, unknown>, 'stream'>, request: Request): Response {
  const last = request.headers.get('last-event-id');
  const match = last?.match(/^(.+):(\d+)$/);
  if (last && (!match || !Number.isSafeInteger(Number(match[2])))) throw new ApiError(400, 'Invalid event cursor');
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, {once:true});
  if (request.signal.aborted) abort();
  const iterator = session.stream({signal:controller.signal,
    ...(match ? {after:{streamId:match[1]!,sequence:Number(match[2])}} : {})})[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const cleanup = () => {controller.abort();request.signal.removeEventListener('abort',abort);};
  return new Response(new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const next = await iterator.next();
        if (next.done) {cleanup();stream.close();return;}
        const event = next.value;
        stream.enqueue(encoder.encode(`id: ${event.cursor.streamId}:${event.cursor.sequence}\ndata: ${JSON.stringify(event)}\n\n`));
      } catch (error) {cleanup();stream.error(error);}
    },
    async cancel() {cleanup();await iterator.return?.();},
  }), {headers:{'content-type':'text/event-stream','cache-control':'no-cache, no-transform'}});
}
