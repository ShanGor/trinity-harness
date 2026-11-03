import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Recover configuration saved with the deployed containers, without exposing secrets. */
export function deployedRuntimeConfig(containers, webOverride = '') {
  const server = containers.find(
    (container) => container.Name.replace(/^\//, '') === 'trinity-server',
  );
  const gateway = containers.find(
    (container) => container.Name.replace(/^\//, '') === 'trinity-gateway',
  );
  if (!server || !gateway) throw new Error('Missing deployed server or gateway');
  const env = Object.fromEntries(
    server.Config.Env.map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  // Deployments predating the port label used 8080 by default.
  const webPort = webOverride || gateway.Config.Labels?.['io.trinity.web-port'] || '8080';
  for (const port of [env.PORT, webPort]) {
    if (!/^\d+$/.test(port ?? '') || Number(port) <= 1024 || Number(port) >= 65536)
      throw new Error('API/web ports must be unprivileged ports');
  }
  if (Number(env.PORT) === Number(webPort)) throw new Error('API/web ports must be distinct');
  return {
    ...runtimeConfig(env, env.PORT, webPort),
    webPort: Number(webPort),
    nodeToken: env.NODE_RUNTIME_TOKEN,
    browserToken: env.BROWSER_RUNTIME_TOKEN,
  };
}

/** Validate this single-host deployment before any runtime effects. */
export function runtimeConfig(env, apiPort, webPort) {
  if (env.EXECUTION_DRIVER !== 'firecracker' || env.BROWSER_DRIVER !== 'zendriver') {
    throw new Error(
      'Podman runtime deployment requires EXECUTION_DRIVER=firecracker and BROWSER_DRIVER=zendriver',
    );
  }
  const endpoint = new URL(env.BROWSER_RUNTIME_ENDPOINT);
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Managed browser endpoint must be an HTTP origin on 127.0.0.1');
  }
  const port = Number(endpoint.port || 80);
  if (port <= 1024 || [Number(apiPort), Number(webPort)].includes(port)) {
    throw new Error('Browser runtime port must be unprivileged and distinct from API/web ports');
  }
  if (env.BROWSER_CDP_ENDPOINT)
    throw new Error('Remove BROWSER_CDP_ENDPOINT for Zendriver deployment');
  for (const key of ['BROWSER_RUNTIME_TOKEN', 'NODE_RUNTIME_TOKEN']) {
    if (!env[key] || env[key].length < 32)
      throw new Error(`${key} must contain at least 32 characters`);
  }
  const nodes = JSON.parse(env.FIRECRACKER_NODES || '[]');
  if (!Array.isArray(nodes) || nodes.length !== 1)
    throw new Error('Single-host deployment requires exactly one provisioned Firecracker node');
  const node = new URL(nodes[0].endpoint);
  if (
    node.protocol !== 'http:' ||
    node.hostname !== '127.0.0.1' ||
    node.username ||
    node.password ||
    node.pathname !== '/' ||
    node.search ||
    node.hash
  ) {
    throw new Error('Node Agent must use an HTTP origin on 127.0.0.1');
  }
  if ([port, Number(apiPort), Number(webPort)].includes(Number(node.port || 80))) {
    throw new Error('Node Agent port conflicts with another service');
  }
  return { browserEndpoint: endpoint.origin, browserPort: port, nodeEndpoint: node.origin };
}

/** Invalid bodies test authenticated routing without issuing runtime operations. */
export async function probeRuntime(endpoint, token, route, fetcher = fetch) {
  const response = await fetcher(new URL(route, endpoint), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 400)
    throw new Error(`Runtime authentication/readiness check failed (${response.status})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, kind] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    if (kind === 'node') await probeRuntime(config.nodeEndpoint, config.nodeToken, '/instances');
    else if (kind === 'browser')
      await probeRuntime(config.browserEndpoint, config.browserToken, '/execute');
    else throw new Error('Unknown runtime probe');
  } catch {
    console.error(`${kind} runtime unavailable or authentication rejected`);
    process.exitCode = 1;
  }
}
