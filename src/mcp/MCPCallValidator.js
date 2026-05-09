const MCPToolCatalog = require('./MCPToolCatalog');

function typeMatches(value, schema = {}) {
    if (value === null || value === undefined) return false;
    const type = Array.isArray(schema.type) ? schema.type : [schema.type || 'string'];
    if (type.includes('string')) return typeof value === 'string';
    if (type.includes('boolean')) return typeof value === 'boolean';
    if (type.includes('number')) return typeof value === 'number' && Number.isFinite(value);
    if (type.includes('integer')) return Number.isInteger(value);
    if (type.includes('array')) return Array.isArray(value);
    if (type.includes('object')) return typeof value === 'object' && !Array.isArray(value);
    return true;
}

function validateMcpCall({ server, tool, parameters = {} }, options = {}) {
    const servers = options.servers;
    const errors = [];
    const normalized = MCPToolCatalog.normalizeToolCall({ server, tool, parameters }, servers);
    const effectiveServer = normalized.server;
    const effectiveTool = normalized.tool;
    const effectiveParams = normalized.parameters;

    if (!server) errors.push('Missing required field: server');
    if (!tool) errors.push('Missing required field: tool');
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
        errors.push('parameters must be an object');
    }

    const catalogTool = effectiveServer && effectiveTool ? MCPToolCatalog.findTool(effectiveServer, effectiveTool, servers) : null;
    if (effectiveServer && effectiveTool && !catalogTool) {
        errors.push(`Unknown MCP tool: ${effectiveServer}/${effectiveTool}`);
    }

    const schema = catalogTool?.inputSchema || null;
    const props = schema?.properties || {};
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const params = effectiveParams && typeof effectiveParams === 'object' && !Array.isArray(effectiveParams) ? effectiveParams : {};

    for (const key of required) {
        if (params[key] === undefined || params[key] === null || params[key] === '') {
            errors.push(`Missing required parameter: ${key}`);
        }
    }

    for (const [key, value] of Object.entries(params)) {
        if (props[key] && props[key].type && !typeMatches(value, props[key])) {
            errors.push(`Invalid type for parameter "${key}": expected ${Array.isArray(props[key].type) ? props[key].type.join('|') : props[key].type}`);
        }
        if (props[key]?.enum && !props[key].enum.includes(value)) {
            errors.push(`Invalid value for parameter "${key}": expected one of ${props[key].enum.join(', ')}`);
        }
    }

    if (schema && schema.additionalProperties === false) {
        for (const key of Object.keys(params)) {
            if (!Object.prototype.hasOwnProperty.call(props, key)) {
                errors.push(`Unknown parameter not allowed by schema: ${key}`);
            }
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        tool: catalogTool,
        normalizedCall: {
            server: effectiveServer,
            tool: effectiveTool,
            parameters: params,
            aliasedFrom: normalized.aliasedFrom,
            paramFixes: normalized.paramFixes || []
        },
        example: catalogTool?.example || (effectiveServer && effectiveTool ? MCPToolCatalog.buildActionExample(effectiveServer, effectiveTool, schema || {}) : null),
    };
}

function formatValidationError(validation) {
    const lines = ['[MCP Validation Error]', ...validation.errors.map(error => `- ${error}`)];
    if (validation.example) {
        lines.push('', 'Correct action format:', JSON.stringify(validation.example, null, 2));
    }
    return lines.join('\n');
}

module.exports = {
    validateMcpCall,
    formatValidationError,
    typeMatches,
};
