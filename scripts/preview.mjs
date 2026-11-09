// local development only: node serves the html and club logo on this computer.
// look up only known public files; arbitrary paths cannot download private files.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
// explicit public-file list: never serve .env, backend source, or test artifacts.
const publicFiles = new Map([
  ['/', ['../index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['../index.html', 'text/html; charset=utf-8']],
  ['/assets/computing-club-logo.png', ['../assets/computing-club-logo.png', 'image/png']],
]);
createServer(async (req, res) => {
  const file = publicFiles.get(req.url?.split('?')[0]);
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const content = await readFile(new URL(file[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }).end(content);
  } catch {
    res.writeHead(500).end('Cannot read public file');
  }
}).listen(4173, '127.0.0.1', () => console.log('Preview: http://localhost:4173'));
