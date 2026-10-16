import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { HealthService } from './health.service.js';

/**
 * Readiness for the worker process, which has no Nest HTTP server: a bare node:http listener that
 * answers GET /ready with HealthService.ready() (200 or 503 JSON) and 404 to anything else. Only
 * src/worker.ts starts it, and only when WORKER_HEALTH_PORT is set. Closes on application shutdown.
 */
@Injectable()
export class WorkerHealthServer implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerHealthServer.name);
  private server: Server | null = null;

  constructor(private readonly health: HealthService) {}

  /** Starts listening; resolves with the bound port (useful when `port` is 0). */
  async listen(port: number): Promise<number> {
    const server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'GET' || path !== '/ready') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'not_found', message: 'Not found' },
          }),
        );
        return;
      }
      void this.health.ready().then((status) => {
        res.writeHead(status.status === 'ready' ? 200 : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(status));
      });
    });
    this.server = server;
    server.listen(port);
    await once(server, 'listening');
    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    this.logger.log(`Worker health listening on :${bound}`);
    return bound;
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
