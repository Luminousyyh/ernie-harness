// Local SDK fixture only. This file never calls a model or external service.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'ernie-local-extension-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
let calls = 0;
let cancellations = 0;
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo', description: 'Echo local input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'slow', description: 'Wait for cancellation', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'stats', description: 'Fixture stats', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'environment', description: 'Fixture env', inputSchema: { type: 'object', additionalProperties: false } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'echo') { calls++; return { content: [{ type: 'text', text: request.params.arguments.text }] }; }
  if (request.params.name === 'stats') return { content: [{ type: 'text', text: JSON.stringify({ calls, cancellations }) }] };
  if (request.params.name === 'environment') return { content: [{ type: 'text', text: JSON.stringify({ inheritedSecret: process.env.OPENROUTER_API_KEY ?? null, fixtureAuth: process.env.FIXTURE_AUTH ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null }) }] };
  if (request.params.name === 'slow') {
    calls++;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 10000);
      const cancel = () => { cancellations++; clearTimeout(timer); resolve(); };
      if (extra.signal.aborted) cancel(); else extra.signal.addEventListener('abort', cancel, { once: true });
    });
    return { content: [{ type: 'text', text: 'completed' }] };
  }
  throw new Error('Unknown tool');
});
await server.connect(new StdioServerTransport());
