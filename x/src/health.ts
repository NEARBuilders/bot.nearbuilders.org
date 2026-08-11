import { createServer, type Server } from "node:http";

export interface HealthState {
  connected: boolean;
}

export function startHealthServer(
  port: number,
  state: HealthState,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", connected: state.connected }));
      return;
    }
    if (request.url === "/ready") {
      response.writeHead(state.connected ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ ready: state.connected }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
