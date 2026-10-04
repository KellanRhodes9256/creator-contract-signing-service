import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { InfraiError, infraiFromEnv } from "./infrai_contracts.ts";
import { signAndDeliver } from "./contract_workflow.ts";

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export function creatorContractServer() {
  const infrai = infraiFromEnv();
  return createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/creator-contracts") {
        const delivery = await signAndDeliver(await readJson(request), infrai);
        sendJson(response, 201, delivery);
        return;
      }
      sendJson(response, 404, { error: "route_not_found" });
    } catch (error) {
      if (error instanceof ZodError) {
        sendJson(response, 400, { error: "invalid_contract", issues: error.issues });
        return;
      }
      if (error instanceof InfraiError) {
        const status = error.status >= 400 && error.status < 500 ? error.status : 502;
        sendJson(response, status, { error: error.code, message: error.message });
        return;
      }
      sendJson(response, 502, { error: "contract_delivery_failed" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  creatorContractServer().listen(port, () => {
    console.log(`Creator contract service listening on http://localhost:${port}`);
  });
}
