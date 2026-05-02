const ResponseParser = require('../src/utils/ResponseParser');

describe('ResponseParser', () => {
    test('should parse normal order (Mem -> Act -> Rep)', () => {
        const input = "[GOLEM_MEMORY] fact [GOLEM_ACTION] ```json [{\"action\": \"command\"}] ``` [GOLEM_REPLY] Hello world";
        const result = ResponseParser.parse(input);
        expect(result.memory).toBe("fact");
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0].action).toBe("command");
        expect(result.reply).toBe("Hello world");
    });

    test('should parse swapped order (Mem -> Rep -> Act)', () => {
        const input = "[GOLEM_MEMORY] fact [GOLEM_REPLY] Hello world [GOLEM_ACTION] ```json [{\"action\": \"command\"}] ```";
        const result = ResponseParser.parse(input);
        expect(result.memory).toBe("fact");
        expect(result.actions).toHaveLength(1);
        expect(result.reply).toBe("Hello world");
    });

    test('should parse action first (Act -> Rep)', () => {
        const input = "[GOLEM_ACTION] ```json [{\"action\": \"command\"}] ``` [GOLEM_REPLY] All done";
        const result = ResponseParser.parse(input);
        expect(result.actions).toHaveLength(1);
        expect(result.reply).toBe("All done");
    });

    test('should parse reply first (Rep -> Act)', () => {
        const input = "[GOLEM_REPLY] All done [GOLEM_ACTION] ```json [{\"action\": \"command\"}] ```";
        const result = ResponseParser.parse(input);
        expect(result.actions).toHaveLength(1);
        expect(result.reply).toBe("All done");
    });

    test('should handle missing tags and fallback to reply', () => {
        const input = "Just a plain text response";
        const result = ResponseParser.parse(input);
        expect(result.reply).toBe("Just a plain text response");
    });

    test('should strip leaked envelope end tag from reply', () => {
        const input = "[GOLEM_REPLY] Hello world\n[END:pu7l]]";
        const result = ResponseParser.parse(input);
        expect(result.reply).toBe("Hello world");
    });

    test('should rescue broken JSON in actions', () => {
        const input = "[GOLEM_ACTION] { \"action\": \"command\", \"parameter\": \"echo hello\" }";
        const result = ResponseParser.parse(input);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0].action).toBe("command");
    });
});
