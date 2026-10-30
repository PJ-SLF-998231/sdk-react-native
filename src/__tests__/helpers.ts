export interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: ArrayBuffer };

/** A scripted fetch: each call takes the next reply (or the function's answer) and is recorded. */
export function mockFetch(replies: Reply[] | ((call: Call) => Reply)) {
  const calls: Call[] = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  const fn = (async (input: unknown, init: unknown) => {
    const call = { url: String(input), init: init as Call['init'] };
    calls.push(call);
    const r = (queue ? queue.shift() : (replies as (c: Call) => Reply)(call)) ?? { status: 500 };
    const status = r.status ?? 200;
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
      json: async () => {
        if (r.body === undefined) throw new Error('no body');
        return r.body;
      },
      arrayBuffer: async () => r.raw ?? new ArrayBuffer(0),
    };
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

export const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  filename: `${id}.pdf`,
  content_type: 'application/pdf',
  size_bytes: 10,
  folder_id: null,
  parse_status: 'done',
  created_at: '2026-01-01T00:00:00Z',
  edited_at: null,
  parsed_at: null,
  preview_sizes: ['small'],
  ...extra,
});

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
