const ResponseParser = require('../../../src/utils/ResponseParser');

function stripEnvelope(text) {
    return String(text || '')
        .replace(/\[\[BEGIN:[^\]]+\]\]/gi, '')
        .replace(/\[\[END:[^\]]+\]\]/gi, '')
        .trim();
}

function extractTagContent(text, tagName) {
    const pattern = new RegExp(`\\[${tagName}\\]([\\s\\S]*?)(?=\\[GOLEM_[A-Z]+\\]|$)`, 'i');
    const match = String(text || '').match(pattern);
    return match && match[1] ? stripEnvelope(match[1]) : '';
}

function unwrapCodeFence(text) {
    const cleaned = String(text || '').trim();
    const match = cleaned.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```/i);
    return (match && match[1] ? match[1] : cleaned).trim();
}

function stripJsonLeadToken(text) {
    const cleaned = String(text || '').trim();
    // Gemini 有時會回「JSON」一行再接大括號
    return cleaned.replace(/^json\s*(?=[\{\[])/i, '').trim();
}

function extractBalancedJson(text, startIndex) {
    const source = String(text || '');
    const openChar = source[startIndex];
    const closeChar = openChar === '{' ? '}' : ']';
    const stack = [];
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < source.length; i++) {
        const ch = source[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{' || ch === '[') {
            stack.push(ch);
            continue;
        }
        if (ch === '}' || ch === ']') {
            const expectedOpen = ch === '}' ? '{' : '[';
            if (stack.pop() !== expectedOpen) return '';
            if (stack.length === 0) return source.slice(startIndex, i + 1);
        }
    }
    return '';
}

function extractJsonPayload(text) {
    const source = stripJsonLeadToken(unwrapCodeFence(text));
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '{' || source[i] === '[') {
            const json = extractBalancedJson(source, i);
            if (json) return json.trim();
        }
    }
    return '';
}

function startsLikeJson(text) {
    const payload = extractJsonPayload(text);
    return payload.startsWith('{') || payload.startsWith('[');
}

function normalizeRpgOutput(rawText) {
    const cleaned = stripEnvelope(rawText);
    if (!/\[GOLEM_(?:MEMORY|ACTION|REPLY)\]/i.test(cleaned)) {
        return startsLikeJson(cleaned) ? extractJsonPayload(cleaned) : cleaned;
    }

    const parsed = ResponseParser.parse(cleaned);
    const reply = stripEnvelope(parsed.reply || '');
    if (startsLikeJson(reply)) return extractJsonPayload(reply);

    const action = extractTagContent(cleaned, 'GOLEM_ACTION');
    if (startsLikeJson(action)) return extractJsonPayload(action);

    return reply || cleaned
        .replace(/\[GOLEM_MEMORY\][\s\S]*?(?=\[GOLEM_ACTION\]|\[GOLEM_REPLY\]|$)/gi, '')
        .replace(/\[GOLEM_ACTION\][\s\S]*?(?=\[GOLEM_REPLY\]|$)/gi, '')
        .replace(/\[GOLEM_REPLY\]/gi, '')
        .trim();
}

module.exports = {
    normalizeRpgOutput,
    stripEnvelope,
    extractTagContent,
};
