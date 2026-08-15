import { getRuntime } from '$lib/server/runtime';

const encoder = new TextEncoder();

function event(name: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

export function GET({ request }) {
  const runtime = getRuntime();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      controller.enqueue(event('scan', runtime.status()));

      unsubscribe = runtime.subscribe((status) => controller.enqueue(event('scan', status)));
      heartbeat = setInterval(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), 15_000);

      request.signal.addEventListener(
        'abort',
        () => {
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // The transport may already have closed the stream.
          }
        },
        { once: true },
      );
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
