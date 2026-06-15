import { handleApiRequest } from "./api";
import { addClient, removeClient, startBridge } from "./ws-bridge";
import { initCache, getCachedSnapshot, getCachedPerformance } from "./viz-cache";
import index from "./frontend/index.html";

export function startVizServer(port: number): { stop: () => void } {
  initCache();
  const stopBridge = startBridge();

  const server = Bun.serve({
    port,
    routes: {
      "/": index,
      "/api/snapshot": {
        GET: () => Response.json(getCachedSnapshot()),
      },
      "/api/performance": {
        GET: () => Response.json(getCachedPerformance()),
      },
      "/api/*": {
        GET: (req) => {
          const res = handleApiRequest(req);
          if (res) return res;
          return new Response("Not Found", { status: 404 });
        },
      },
    },
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Static assets
      if (url.pathname.startsWith("/assets/")) {
        const filePath = import.meta.dir + "/frontend" + url.pathname;
        const file = Bun.file(filePath);
        return new Response(file);
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        addClient(ws);
      },
      message(_ws, _message) {
        // Client messages not needed yet
      },
      close(ws) {
        removeClient(ws);
      },
    },
  });

  console.log(`Viz server running at http://localhost:${port}`);

  return {
    stop: () => {
      stopBridge();
      server.stop();
    },
  };
}
