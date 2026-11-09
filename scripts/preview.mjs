import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
// Serve only the public HTML. Never accidentally serve .env or test artifacts.
createServer(async (req, res) => {
  if (!['/', '/index.html'].includes(req.url?.split('?')[0])) { res.writeHead(404).end('Not found'); return; }
  try {
    const html = await readFile(new URL('../index.html', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
  } catch { res.writeHead(500).end('Cannot read index.html'); }
}).listen(4173, '127.0.0.1', () => console.log('Preview: http://localhost:4173'));
