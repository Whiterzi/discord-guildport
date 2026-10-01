import { serverUrl, type Session } from './config.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface Message {
  id: string;
  channel_id: string;
  author: { id: string; name: string; bot: boolean };
  content: string;
  created_at: string;
  attachments: { name: string; url: string }[];
}

export interface StreamEvent { event: string; data: Record<string, unknown> }

export class Api {
  server: string;
  constructor(server: string, private token?: string) { this.server = serverUrl(server); }

  static session(session: Session): Api { return new Api(session.server, session.token); }

  private async response(path: string, options: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (!path.startsWith('/v1/') || path.startsWith('//')) throw new Error('Invalid API path.');
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const response = await fetch(this.server + path, { ...options, headers, redirect: 'error',
      signal: signal ?? AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      await response.body?.cancel().catch(() => {});
      throw new ApiError(response.status, data?.error?.code ?? 'http_error',
        data?.error?.message ?? `Relay returned HTTP ${response.status}.`);
    }
    return response;
  }

  async request<T>(path: string, data?: unknown): Promise<T> {
    const response = await this.response(path, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return await response.json() as T;
  }

  async *events(channel: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.response(`/v1/channels/${id(channel)}/events`, {}, signal);
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
      await response.body?.cancel();
      throw new Error('Relay did not return an event stream.');
    }
    if (!response.body) throw new Error('Missing event stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        // Abort a stalled proxy even if the TCP connection remains open.
        const timer = setTimeout(() => { void reader.cancel(); }, 45_000);
        let part: ReadableStreamReadResult<Uint8Array>;
        try { part = await reader.read(); } finally { clearTimeout(timer); }
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }).replace(/\r/g, '');
        if (buffer.length > 1_048_576) throw new Error('Event stream exceeded its frame limit.');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length) yield { event, data: JSON.parse(data.join('\n')) };
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export function id(value: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) >= 2n ** 64n) {
    throw new Error('Use a Discord ID as a decimal string.');
  }
  return value;
}
