const skillManager = require('./SkillManager');
const SkillPackageRegistry = require('./SkillPackageRegistry');
const { toolsetManager, SCENE_TOOLSETS } = require('./ToolsetManager');

const BUILTIN_ACTIONS = new Set(['command', 'mcp_call', 'multi_agent', 'toolset']);
const REMOVED_ACTIONS = new Set(['schedule', 'list-schedules']);

function normalizeActionName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');
}

function extractCommand(act) {
    return String(
        act.cmd ||
        act.parameter ||
        act.command ||
        act.parameters?.command ||
        act.parameters?.cmd ||
        act.parameters?.parameter ||
        ''
    ).trim();
}

function hasValidMcpShape(action) {
    const server = action.server || action.parameters?.server;
    const tool = action.tool || action.parameters?.tool;
    return Boolean(String(server || '').trim() && String(tool || '').trim());
}

function findSkillByAction(actionName) {
    const normalized = normalizeActionName(actionName);
    if (!normalized) return null;

    const dynamic = skillManager.getSkill(normalized)
        || skillManager.getSkill(String(actionName || '').trim());
    if (dynamic) {
        return { kind: 'dynamic', id: dynamic.name || normalized };
    }

    const pkg = SkillPackageRegistry.listSkillPackages()
        .find((item) => {
            const id = normalizeActionName(item && item.id);
            const action = normalizeActionName(item && item.action);
            return id === normalized || action === normalized;
        });

    if (pkg) {
        return { kind: 'package', id: pkg.id };
    }

    return null;
}

function suggestScenesForAction(actionName, skillId = '') {
    const normalizedAction = normalizeActionName(actionName);
    const normalizedSkillId = normalizeActionName(skillId);
    const scenes = [];

    for (const [sceneName, scene] of Object.entries(SCENE_TOOLSETS || {})) {
        const includes = new Set((scene && Array.isArray(scene.includes) ? scene.includes : []).map(normalizeActionName));
        if (includes.has(normalizedAction) || (normalizedSkillId && includes.has(normalizedSkillId))) {
            scenes.push(sceneName);
        }
    }
    return scenes.slice(0, 4);
}

class ActionExecutionGate {
    static validate(action, options = {}) {
        const rawAction = action && action.action ? action.action : '';
        const normalizedAction = normalizeActionName(rawAction);
        const hasCommandPayload = extractCommand(action).length > 0;

        if (!normalizedAction && hasCommandPayload) {
            return { ok: true, lane: 'command', normalizedAction: 'command' };
        }

        if (!normalizedAction) {
            return { ok: false, code: 'MISSING_ACTION', error: 'Missing action field' };
        }

        if (normalizedAction === 'command') {
            if (!hasCommandPayload) {
                return { ok: false, code: 'EMPTY_COMMAND', error: 'action=command but no command payload found' };
            }
            return { ok: true, lane: 'command', normalizedAction };
        }

        if (normalizedAction === 'mcp-call') {
            // Auto-normalize alias: mcp-call -> mcp_call
            if (!hasValidMcpShape(action)) {
                return {
                    ok: false,
                    code: 'INVALID_MCP_CALL',
                    error: 'mcp_call requires both server and tool fields',
                };
            }
            return { ok: true, lane: 'mcp', normalizedAction: 'mcp_call' };
        }

        if (normalizedAction === 'mcp_call' || normalizedAction === 'multi-agent') {
            if (normalizedAction === 'multi-agent') {
                return { ok: true, lane: 'framework', normalizedAction: 'multi_agent' };
            }
            if (!hasValidMcpShape(action)) {
                return {
                    ok: false,
                    code: 'INVALID_MCP_CALL',
                    error: 'mcp_call requires both server and tool fields',
                };
            }
            return { ok: true, lane: 'mcp', normalizedAction: 'mcp_call' };
        }

        if (BUILTIN_ACTIONS.has(normalizedAction)) {
            if (normalizedAction === 'toolset') {
                return { ok: true, lane: 'framework', normalizedAction: 'toolset' };
            }
            return { ok: true, lane: 'framework', normalizedAction };
        }

        if (REMOVED_ACTIONS.has(normalizedAction)) {
            return {
                ok: false,
                code: 'UNKNOWN_ACTION',
                error:
                    `Action "${normalizedAction}" has been removed permanently and is no longer supported.\n` +
                    `Use collab-calendar instead.\n` +
                    `Example (this week): {"action":"collab-calendar","args":{"action":"upcoming","days":7}}\n` +
                    `Sub-actions:\n` +
                    `- list: list all events\n` +
                    `- today: list today events\n` +
                    `- upcoming: list next N days\n` +
                    `- add: create event\n` +
                    `- update: update event\n` +
                    `- delete: delete event\n` +
                    `- search: keyword search`,
            };
        }

        const skill = findSkillByAction(normalizedAction);
        if (!skill) {
            const scenes = Object.keys(SCENE_TOOLSETS || {}).join(', ');
            return {
                ok: false,
                code: 'UNKNOWN_ACTION',
                error: `Unknown action "${normalizedAction}". Use command / mcp_call / multi_agent / toolset / installed skill action. ` +
                    `Toolset example: {"action":"toolset","args":{"scene":"research"}}. Available scenes: ${scenes}. ` +
                    `You can also use slash: /toolset list`,
            };
        }

        const activeTools = new Set(options.activeTools || toolsetManager.getActiveTools());
        if (activeTools.size > 0 && !activeTools.has(normalizedAction) && !activeTools.has(skill.id)) {
            const currentScene = String(toolsetManager.getActiveScene() || 'assistant');
            const suggestions = suggestScenesForAction(normalizedAction, skill.id);
            const suggestionText = suggestions.length > 0
                ? ` Suggested scene(s): ${suggestions.join(', ')} (current: ${currentScene}).`
                : ` Current scene: ${currentScene}.`;
            return {
                ok: false,
                code: 'TOOLSET_DISABLED',
                error: `Action "${normalizedAction}" exists but is disabled in current toolset.${suggestionText} Use /toolset <scene> to switch.`,
            };
        }

        return { ok: true, lane: 'skill', normalizedAction };
    }
}

module.exports = ActionExecutionGate;
