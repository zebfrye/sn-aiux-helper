// Static server for the demo/test harness.
//   node test/serve.mjs [port]  ->  open http://localhost:<port>/test/harness.html
// Panel and sidebar pages requested with ?mock get a chrome.devtools mock
// injected so they run outside DevTools against the demo page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..')) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = await readFile(join(ROOT, path || 'test/harness.html'));
      if (url.searchParams.has('mock') && path.endsWith('.html')) {
        body = Buffer.from(String(body).replace('<head>', '<head><script src="/test/chrome-mock.js"></script>'));
      }
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.argv[2]) || 5173);
  console.log(`Demo harness: http://localhost:${server.address().port}/test/harness.html`);
}
