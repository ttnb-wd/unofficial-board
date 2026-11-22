import { cp, writeFile } from 'node:fs/promises';

const value = process.env.MINI_APP_API_ORIGIN;
const api = URL.parse(value ?? '');
if (
  api?.protocol !== 'https:' ||
  api.username ||
  api.password ||
  value.replace(/\/$/, '') !== api.origin
) {
  throw new Error('Set MINI_APP_API_ORIGIN to the Render HTTPS origin, without a path.');
}

const output = new URL('../dist-vercel/mini-app/', import.meta.url);
await cp(new URL('../public/mini-app/', import.meta.url), output, { recursive: true });
await writeFile(
  new URL('config.js', output),
  `window.BOARD_API_ORIGIN = ${JSON.stringify(api.origin)};\n`,
);
