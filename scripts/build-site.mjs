import { mkdir, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
await copyFile(new URL('index.html', root), new URL('dist/index.html', root));
console.log('Built dist/index.html. Only this frontend is published.');
