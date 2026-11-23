// The demo database as an MCP server over stdio, so any MCP client can be pointed at it.
//
//   node demo/mcp.js [actor]        actor defaults to $GENDB_ACTOR, then user:kim
//
// Newline-delimited JSON-RPC on stdin and stdout, in either protocol era (see src/mcp.js). stdout
// carries protocol messages only; everything else goes to stderr. The database lives in memory and
// starts from the scenario on every launch.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createMcpServer } from '../src/mcp.js';
import { createDatabase, KIM } from './scenario.js';

const actor = process.argv[2] ?? process.env.GENDB_ACTOR ?? KIM;
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const server = createMcpServer(createDatabase(), { actor, name: 'gendb-demo', version });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
server.onMessage(send);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const response = server.handle(message);
  if (response) send(response);
});
// End of stdin is the client's shutdown signal; with nothing else pending, the process then exits.
lines.on('close', () => server.close());

console.error(`gendb mcp: serving the demo database for ${actor} on stdio`);
