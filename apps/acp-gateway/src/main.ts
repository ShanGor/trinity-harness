import { loadGatewayEnv } from './env.js';
import { createAcpGateway, createHttp, createStdioStream } from './gateway.js';

/**
 * Composition root for the ACP stdio gateway (docs/design.md §11.1): Zed
 * spawns this process; NDJSON over stdio in, official SDK agent app, HTTP
 * binding of the trinity-harness server out.
 */
function main(): void {
  const env = loadGatewayEnv();
  const http = createHttp(env.ACP_SERVER_URL, env.ACP_TOKEN);
  const gateway = createAcpGateway(http);

  gateway.connect(createStdioStream());
  console.error(`[acp-gateway] connected to ${env.ACP_SERVER_URL} over stdio`);
}

main();
