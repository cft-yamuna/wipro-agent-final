import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { createReadStream, statSync, existsSync } from 'fs';
import { resolve, extname, join } from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import type { Logger } from '../lib/logger.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

export class StaticServer {
  private port: number;
  private distPath: string;
  private serverUrl: string;
  private logger: Logger;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(port: number, distPath: string, serverUrl: string, logger: Logger) {
    this.port = port;
    this.distPath = distPath;
    this.serverUrl = serverUrl;
    this.logger = logger;
  }

  start(): void {
    if (!existsSync(this.distPath)) {
      this.logger.warn(`StaticServer: dist path not found: ${this.distPath}`);
      return;
    }

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handle(req, res);
    });

    // Proxy WebSocket upgrades (/ws/*) to the real server
    this.server.on('upgrade', (req, socket, head) => {
      const upstream = new URL(req.url || '/', this.serverUrl);
      const wsUrl = upstream.toString().replace(/^http/, 'ws');
      this.logger.debug(`WS proxy: ${req.url} → ${wsUrl}`);

      const upstreamWs = new WebSocket(wsUrl, {
        headers: { ...req.headers, host: new URL(this.serverUrl).host },
      });

      upstreamWs.on('open', () => {
        const wss = new WebSocketServer({ noServer: true });
        wss.handleUpgrade(req, socket, head, (clientWs) => {
          // Pipe client ↔ upstream
          clientWs.on('message', (data, isBinary) => {
            if (upstreamWs.readyState === WebSocket.OPEN) {
              upstreamWs.send(data, { binary: isBinary });
            }
          });
          upstreamWs.on('message', (data, isBinary) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(data, { binary: isBinary });
            }
          });
          clientWs.on('close', () => upstreamWs.close());
          upstreamWs.on('close', () => clientWs.close());
          clientWs.on('error', () => upstreamWs.close());
          upstreamWs.on('error', () => clientWs.close());
        });
      });

      upstreamWs.on('error', (err) => {
        this.logger.warn(`WS proxy error: ${err.message}`);
        socket.destroy();
      });
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.info(`Display static server listening on port ${this.port} (proxy → ${this.serverUrl})`);
    });

    this.server.on('error', (err) => {
      this.logger.error(`StaticServer error: ${err.message}`);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.logger.info('Display static server stopped');
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url || '/';
    const path = rawUrl.split('?')[0];

    // Proxy /api/* and /storage/* to the real server
    if (path.startsWith('/api/') || path.startsWith('/storage/')) {
      this.proxyHttp(req, res);
      return;
    }

    // Proxy /display/* to the server first (always get latest build).
    // Only fall back to local files if server is unreachable.
    if (path.startsWith('/display')) {
      this.proxyWithFallback(req, res);
      return;
    }

    // Serve static files for non-display paths
    this.serveStatic(req, res);
  }

  private proxyHttp(req: IncomingMessage, res: ServerResponse): void {
    const target = new URL(this.serverUrl);
    const options = {
      hostname: target.hostname,
      port: target.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    };

    const proxy = httpRequest(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    proxy.on('error', (err) => {
      this.logger.warn(`HTTP proxy error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    req.pipe(proxy);
  }

  /**
   * Try to proxy the request to the real server (latest display build).
   * If the server is unreachable, fall back to local static files.
   */
  private proxyWithFallback(req: IncomingMessage, res: ServerResponse): void {
    const target = new URL(this.serverUrl);
    let fell = false;
    const fallback = () => {
      if (fell || res.headersSent) return;
      fell = true;
      this.logger.debug(`Proxy failed for ${req.url}, serving from local files`);
      this.serveStatic(req, res);
    };

    const options = {
      hostname: target.hostname,
      port: target.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
      timeout: 3000,
    };

    const proxy = httpRequest(options, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode || 502;

      // If upstream display route is unavailable/misconfigured,
      // serve the local bundled display instead of surfacing server errors.
      if (statusCode >= 400) {
        upstreamRes.resume();
        fallback();
        return;
      }

      res.writeHead(statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    proxy.on('error', fallback);
    proxy.on('timeout', () => { proxy.destroy(); fallback(); });

    req.pipe(proxy);
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = (req.url || '/').split('?')[0];

    // Strip /display prefix to map to dist files
    let filePath = rawUrl.startsWith('/display')
      ? rawUrl.slice('/display'.length) || '/'
      : rawUrl;

    let absPath = resolve(this.distPath, filePath.replace(/^\//, ''));

    // Security: stay inside distPath
    if (!absPath.startsWith(this.distPath)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // SPA fallback
    if (!existsSync(absPath) || statSync(absPath).isDirectory()) {
      absPath = join(this.distPath, 'index.html');
    }

    if (!existsSync(absPath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = extname(absPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mime });
    createReadStream(absPath).pipe(res);
  }
}
