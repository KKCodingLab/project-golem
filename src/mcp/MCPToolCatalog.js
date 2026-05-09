const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'data', 'mcp-servers.json');
const CATALOG_PATH = path.resolve(process.cwd(), 'golem_memory', 'mcp', 'tool-catalog.json');
const TOOL_ALIASES = {
    'chrome-devtools': {
        navigate: 'navigate_page',
        goto: 'navigate_page',
        open: 'navigate_page',
        open_page: 'navigate_page',
        list_tabs: 'list_pages',
        list_tab: 'list_pages',
        tabs: 'list_pages',
        new_tab: 'new_page',
        open_tab: 'new_page',
        create_tab: 'new_page',
        activate_tab: 'select_page',
        switch_tab: 'select_page',
        select_tab: 'select_page',
        focus_tab: 'select_page',
        close_tab: 'close_page',
        type: 'type_text',
        screenshot: 'take_screenshot',
        snapshot: 'take_snapshot',
        eval: 'evaluate_script',
        evaluate: 'evaluate_script',
        wait: 'wait_for',
    },
};

function normalizeServerName(value) {
    return String(value || '').trim();
}

function normalizeToolName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

function getSchemaType(schema = {}) {
    if (Array.isArray(schema.type)) return schema.type[0] || 'string';
    return schema.type || (schema.properties ? 'object' : 'string');
}

function exampleValueForSchema(schema = {}, name = 'value') {
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

    const type = getSchemaType(schema);
    if (type === 'boolean') return false;
    if (type === 'integer' || type === 'number') return 1;
    if (type === 'array') return [exampleValueForSchema(schema.items || {}, name.replace(/s$/, ''))];
    if (type === 'object') {
        const output = {};
        const properties = schema.properties || {};
        const required = Array.isArray(schema.required) ? schema.required : Object.keys(properties).slice(0, 3);
        for (const key of required) {
            output[key] = exampleValueForSchema(properties[key] || {}, key);
        }
        return output;
    }
    if (/url/i.test(name)) return 'https://example.com';
    if (/repo|repository/i.test(name)) return 'owner/repo';
    if (/path/i.test(name)) return 'path/to/file';
    if (/title/i.test(name)) return 'Title';
    if (/query|search/i.test(name)) return 'search query';
    if (/body|content|message|text/i.test(name)) return 'Text content';
    return `<${name}>`;
}

function buildExampleParameters(inputSchema = {}) {
    const properties = inputSchema.properties || {};
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    const keys = required.length > 0 ? required : Object.keys(properties).slice(0, 3);
    const params = {};

    for (const key of keys) {
        params[key] = exampleValueForSchema(properties[key] || {}, key);
    }

    return params;
}

function buildActionExample(serverName, toolName, inputSchema = {}) {
    return {
        action: 'mcp_call',
        server: serverName,
        tool: toolName,
        parameters: buildExampleParameters(inputSchema),
    };
}

function normalizeTool(server, tool) {
    const inputSchema = tool.inputSchema || tool.schema || null;
    return {
        server: server.name,
        name: tool.name,
        tool: tool.name,
        id: `${server.name}/${tool.name}`,
        description: tool.description || '',
        inputSchema,
        required: inputSchema && Array.isArray(inputSchema.required) ? inputSchema.required : [],
        example: buildActionExample(server.name, tool.name, inputSchema || {}),
    };
}

function readServers(configPath = DEFAULT_CONFIG_PATH) {
    try {
        if (!fs.existsSync(configPath)) return [];
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function buildCatalog(servers = readServers()) {
    const tools = [];
    for (const server of servers.filter(item => item && item.enabled !== false)) {
        for (const tool of server.cachedTools || []) {
            if (!tool || !tool.name) continue;
            tools.push(normalizeTool(server, tool));
        }
    }
    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        tools,
    };
}

function writeCatalog(servers = readServers(), catalogPath = CATALOG_PATH) {
    const catalog = buildCatalog(servers);
    const dir = path.dirname(catalogPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
    return catalog;
}

function findTool(serverName, toolName, servers = readServers()) {
    const server = servers.find(item => item && item.enabled !== false && item.name === serverName);
    if (!server) return null;
    const tool = (server.cachedTools || []).find(item => item.name === toolName);
    return tool ? normalizeTool(server, tool) : null;
}

function resolveToolName(serverName, toolName, servers = readServers()) {
    const server = servers.find(item => item && item.enabled !== false && item.name === serverName);
    if (!server) return { toolName, aliasedFrom: null };

    const tools = Array.isArray(server.cachedTools) ? server.cachedTools : [];
    if (tools.some(item => item && item.name === toolName)) {
        return { toolName, aliasedFrom: null };
    }

    const normalized = normalizeToolName(toolName);
    const aliasMap = TOOL_ALIASES[normalizeServerName(serverName)] || {};
    const aliased = aliasMap[normalized];
    if (aliased && tools.some(item => item && item.name === aliased)) {
        return { toolName: aliased, aliasedFrom: toolName };
    }

    // If alias table missed but only case/format differs (e.g. list-pages), try normalized exact.
    if (tools.some(item => normalizeToolName(item && item.name) === normalized)) {
        const matched = tools.find(item => normalizeToolName(item && item.name) === normalized);
        return { toolName: matched.name, aliasedFrom: toolName === matched.name ? null : toolName };
    }

    return { toolName, aliasedFrom: null };
}

function toNumberOrNull(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    }
    return null;
}

function normalizeParametersForTool(serverName, toolName, parameters = {}) {
    const params = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
        ? { ...parameters }
        : {};
    const fixes = [];

    if (normalizeServerName(serverName) === 'chrome-devtools') {
        if (toolName === 'select_page' || toolName === 'close_page') {
            if (params.pageId === undefined) {
                const candidate = params.tabId ?? params.page ?? params.page_id ?? params.pageIndex ?? params.index;
                const pageId = toNumberOrNull(candidate);
                if (pageId !== null) {
                    params.pageId = pageId;
                    fixes.push('pageId<=alias');
                }
            }
        } else if (toolName === 'type_text') {
            if (params.text === undefined) {
                const candidate = params.value ?? params.content ?? params.message;
                if (candidate !== undefined && candidate !== null) {
                    params.text = String(candidate);
                    fixes.push('text<=alias');
                }
            }
        } else if (toolName === 'wait_for') {
            if (typeof params.text === 'string') {
                params.text = [params.text];
                fixes.push('wait_for.text=>array');
            }
        } else if (toolName === 'navigate_page' || toolName === 'new_page') {
            if (params.url === undefined) {
                const candidate = params.link ?? params.href ?? params.targetUrl ?? params.target;
                if (candidate !== undefined && candidate !== null) {
                    params.url = String(candidate);
                    fixes.push('url<=alias');
                }
            }
        } else if (toolName === 'evaluate_script') {
            if (params.function === undefined) {
                const candidate = params.script ?? params.code;
                if (candidate !== undefined && candidate !== null) {
                    params.function = String(candidate);
                    fixes.push('function<=alias');
                }
            }
        } else if (toolName === 'press_key') {
            if (params.key === undefined) {
                const candidate = params.text ?? params.value;
                if (candidate !== undefined && candidate !== null) {
                    params.key = String(candidate);
                    fixes.push('key<=alias');
                }
            }
        }
    }

    return { parameters: params, fixes };
}

function normalizeToolCall(call = {}, servers = readServers()) {
    const server = String(call.server || '').trim();
    const tool = String(call.tool || '').trim();
    const parameters = call.parameters || {};

    const resolved = resolveToolName(server, tool, servers);
    const normalizedParams = normalizeParametersForTool(server, resolved.toolName, parameters);

    return {
        server,
        tool: resolved.toolName,
        parameters: normalizedParams.parameters,
        aliasedFrom: resolved.aliasedFrom,
        paramFixes: normalizedParams.fixes
    };
}

module.exports = {
    DEFAULT_CONFIG_PATH,
    CATALOG_PATH,
    buildCatalog,
    writeCatalog,
    findTool,
    resolveToolName,
    normalizeToolCall,
    buildActionExample,
    buildExampleParameters,
    exampleValueForSchema,
};
