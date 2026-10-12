// Servidor local simples: serve public/ com as mesmas regras do vercel.json.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('public');
const port = Number(process.env.PORT) || 3000;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

http
  .createServer(async (req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (/^\/sala\/[^/]+$/.test(pathname)) pathname = '/room.html';
    if (pathname === '/') pathname = '/index.html';
    const candidates = [pathname, `${pathname}.html`];
    for (const candidate of candidates) {
      const file = path.join(root, candidate);
      if (!file.startsWith(root)) break;
      try {
        const body = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        return res.end(body);
      } catch {
        // tenta o próximo
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  })
  .listen(port, () => console.log(`Sistema RPG em http://localhost:${port}`));
