// the build copies static files; it does not compile a framework or deploy supabase.
import { mkdir, copyFile } from 'node:fs/promises';
// resolve paths from this script so the build does not depend on the terminal folder.
const root = new URL('../', import.meta.url);
// copy only public frontend assets into the directory that vercel publishes.
await mkdir(new URL('dist/', root), { recursive: true });
await copyFile(new URL('index.html', root), new URL('dist/index.html', root));
await mkdir(new URL('dist/assets/', root), { recursive: true });
await copyFile(
  new URL('assets/computing-club-logo.png', root),
  new URL('dist/assets/computing-club-logo.png', root),
);
console.log(
  'Built dist/index.html and the Computing Club logo. Only frontend assets are published.',
);
