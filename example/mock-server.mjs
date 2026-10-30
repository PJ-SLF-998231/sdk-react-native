// A tiny stand-in for your proxy, for trying the example without a Shelf account. No dependencies.
// Accepts POST /api/shelf/files (multipart) and answers like the integration API; it drains the body, stores nothing.
//   node mock-server.mjs [port]
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const PREFIX = '/api/shelf';

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || '/' : null;
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (path === null) return send(404, { error: 'not_found', code: 'not_found', message: 'No such route' });
  if (!(req.headers.authorization ?? '').startsWith('Bearer ')) return send(401, { error: 'unauthorized', code: 'unauthorized', message: 'Sign in' });

  if (req.method === 'POST' && /^\/files\/?$/.test(path)) {
    let bytes = 0;
    const chunks = [];
    req.on('data', (c) => { bytes += c.length; if (chunks.length < 64) chunks.push(c); });
    req.on('end', () => {
      const head = Buffer.concat(chunks).toString('latin1');
      const name = /filename="([^"]*)"/.exec(head)?.[1] ?? 'upload';
      const clientRef = /name="client_ref"\r\n\r\n([^\r]*)/.exec(head)?.[1];
      console.log(`POST /files ${name} ${bytes} bytes client_ref=${clientRef ?? '-'}`);
      send(201, {
        id: randomUUID(),
        filename: name,
        content_type: /filename="[^"]*"\r\nContent-Type: ([^\r]*)/i.exec(head)?.[1] ?? 'application/octet-stream',
        size_bytes: bytes,
        folder_id: /name="folder_id"\r\n\r\n([^\r]*)/.exec(head)?.[1] ?? null,
        parse_status: 'pending',
        created_at: new Date().toISOString(),
        edited_at: null,
        parsed_at: null,
        preview_sizes: [],
        ...(clientRef ? { client_ref: clientRef } : {}),
      });
    });
    return;
  }
  if (req.method === 'GET' && /^\/files\/?$/.test(path)) return send(200, { items: [], total: 0 });
  if (req.method === 'GET' && /^\/folders\/?$/.test(path)) return send(200, { folders: [] });
  send(404, { error: 'not_found', code: 'not_found', message: 'No such route' });
});

server.listen(port, () => console.log(`mock Shelf proxy on http://localhost:${port}${PREFIX}`));
