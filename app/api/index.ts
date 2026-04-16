import Elysia from "elysia";
import { cors } from "@elysiajs/cors";
import { statusRoutes } from "./src/routes/status";
import { marketRoutes } from "./src/routes/markets";
import { positionRoutes } from "./src/routes/positions";
import { orderRoutes } from "./src/routes/orders";
import { signalRoutes } from "./src/routes/signals";
import { performanceRoutes } from "./src/routes/performance";
import { logRoutes, startLogCapture } from "./src/routes/logs";
import { wsRoute, startWsBridge } from "./src/ws";

export { startConsoleLogger } from "./src/console-logger";

/**
 * Start the Elysia API server.
 * Returns a stop function to gracefully shut down.
 */
export function startApiServer(port = 3100): { stop: () => void } {
  // Start capturing logs into the ring buffer
  const stopLogCapture = startLogCapture();

  const app = new Elysia()
    .use(cors())
    .use(statusRoutes)
    .use(marketRoutes)
    .use(positionRoutes)
    .use(orderRoutes)
    .use(signalRoutes)
    .use(performanceRoutes)
    .use(logRoutes)
    .use(wsRoute)
    .get("/api/health", () => ({ ok: true, ts: Date.now() }))
    .listen(port);

  // Start forwarding bus events to WebSocket clients
  const stopWsBridge = startWsBridge();

  console.log(`API server listening on http://localhost:${port}`);

  return {
    stop: () => {
      stopWsBridge();
      stopLogCapture();
      app.stop();
    },
  };
}
