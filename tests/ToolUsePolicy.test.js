const ToolUsePolicy = require('../src/managers/ToolUsePolicy');

describe('ToolUsePolicy', () => {
    test('blocks passive explanation requests from routing', () => {
        const policy = new ToolUsePolicy();
        const decision = policy.evaluateCandidate('請解釋 git commit 是什麼', {
            id: 'git',
            name: 'git',
            score: 20,
        });

        expect(decision.include).toBe(false);
        expect(decision.reason).toBe('passive_request');
    });

    test('allows read tools for explicit inspection requests', () => {
        const policy = new ToolUsePolicy();
        const decision = policy.evaluateCandidate('幫我檢查錯誤日誌', {
            id: 'log-reader',
            name: 'log-reader',
            description: 'read logs',
            score: 12,
        });

        expect(decision.include).toBe(true);
        expect(decision.risk).toBe('read');
        expect(decision.requiresConfirmation).toBe(false);
    });

    test('requires confirmation for high risk tools', () => {
        const policy = new ToolUsePolicy();
        const decision = policy.evaluateCandidate('幫我刪除頁面', {
            id: 'wiki-delete',
            name: 'delete',
            description: 'delete a page',
            score: 15,
        });

        expect(decision.include).toBe(true);
        expect(decision.risk).toBe('high');
        expect(decision.requiresConfirmation).toBe(true);
    });
});
