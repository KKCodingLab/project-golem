const MCPClient = require('../src/mcp/MCPClient');

describe('MCPClient', () => {
    test('extends RPC timeout when a tool call includes a longer timeout parameter', async () => {
        const client = new MCPClient({ name: 'chrome-devtools', command: 'npx', timeout: 30000 });
        client._connected = true;
        const rpc = jest.spyOn(client, '_rpc').mockResolvedValue({ content: [] });

        await client.callTool('navigate_page', {
            type: 'url',
            url: 'https://example.com',
            timeout: 60000,
        });

        expect(rpc).toHaveBeenCalledWith(
            'tools/call',
            {
                name: 'navigate_page',
                arguments: {
                    type: 'url',
                    url: 'https://example.com',
                    timeout: 60000,
                },
            },
            65000,
        );
    });

    test('keeps configured RPC timeout when tool timeout is shorter or absent', async () => {
        const client = new MCPClient({ name: 'chrome-devtools', command: 'npx', timeout: 120000 });
        client._connected = true;
        const rpc = jest.spyOn(client, '_rpc').mockResolvedValue({ content: [] });

        await client.callTool('take_snapshot', { timeout: 1000 });

        expect(rpc).toHaveBeenCalledWith(
            'tools/call',
            {
                name: 'take_snapshot',
                arguments: { timeout: 1000 },
            },
            120000,
        );
    });

    test('parses standard MCP Content-Length framed responses', () => {
        const client = new MCPClient({ name: 'chrome-devtools', command: 'npx' });
        const handle = jest.spyOn(client, '_handleMessage').mockImplementation(() => {});
        const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });

        client._onData(Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`));

        expect(handle).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    });

});
