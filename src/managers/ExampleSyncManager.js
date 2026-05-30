'use strict';

const fs = require('fs');
const path = require('path');
const CapabilityRegistry = require('./CapabilityRegistry');
const ExampleRegistry = require('./ExampleRegistry');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pickWritablePath(primaryPath, fallbackPath) {
  try {
    ensureDir(primaryPath);
    return primaryPath;
  } catch (_) {
    ensureDir(fallbackPath);
    return fallbackPath;
  }
}

function canWritePath(filePath) {
  try {
    ensureDir(filePath);
    const dir = path.dirname(filePath);
    fs.accessSync(dir, fs.constants.W_OK);
    if (fs.existsSync(filePath)) fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function getCustomExamplesPath(userDataDir) {
  const { primary, fallback } = getCustomExamplesPaths(userDataDir);
  return canWritePath(primary) ? primary : pickWritablePath(fallback, primary);
}

function getCustomExamplesPaths(userDataDir) {
  const base = userDataDir || path.resolve(process.cwd(), 'golem_memory');
  return {
    primary: path.join(base, 'examples', 'custom-action-examples.json'),
    fallback: path.resolve(process.cwd(), 'data', 'examples', 'custom-action-examples.json')
  };
}

function writeCustomExamples(userDataDir, payload) {
  const { primary, fallback } = getCustomExamplesPaths(userDataDir);
  const preferred = pickWritablePath(primary, fallback);
  try {
    fs.writeFileSync(preferred, JSON.stringify(payload, null, 2), 'utf8');
    return preferred;
  } catch (e) {
    if (preferred !== fallback) {
      ensureDir(fallback);
      fs.writeFileSync(fallback, JSON.stringify(payload, null, 2), 'utf8');
      return fallback;
    }
    throw e;
  }
}

function readCustomExamples(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { version: 1, examples: [] };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      version: 1,
      examples: Array.isArray(parsed.examples) ? parsed.examples : []
    };
  } catch (_) {
    return { version: 1, examples: [] };
  }
}

function hasCoverage(existingExamples, lane, target) {
  return existingExamples.some(ex => {
    const exLane = String(ex.lane || '').trim();
    const exTarget = String(ex.target || '').trim();
    return exLane === lane && exTarget === target;
  });
}

function buildSkillTemplate(cap) {
  return {
    id: `example:skill:${cap.target}`,
    lane: 'skill',
    target: cap.target,
    intent_tags: ['skill', cap.target],
    error_tags: ['invalid_field', 'missing_required'],
    example: `{"action":"${cap.target}","args":{"input":"..."}}`,
    anti_pattern: '請使用 args 物件，避免把參數塞在 parameters.command 或自創欄位。'
  };
}

function extractJsonSnippetsFromSkill(content, limit = 4) {
  const hits = [];
  const seen = new Set();
  const text = String(content || '');

  const blockRegex = /```json\s*([\s\S]*?)```/gi;
  let m;
  while ((m = blockRegex.exec(text)) && hits.length < limit) {
    const snippet = String(m[1] || '').trim();
    if (!snippet) continue;
    if (seen.has(snippet)) continue;
    seen.add(snippet);
    hits.push(snippet);
  }

  const inlineRegex = /`(\{[\s\S]*?\})`/g;
  while ((m = inlineRegex.exec(text)) && hits.length < limit) {
    const snippet = String(m[1] || '').trim();
    if (!snippet.startsWith('{') || !snippet.endsWith('}')) continue;
    if (seen.has(snippet)) continue;
    seen.add(snippet);
    hits.push(snippet);
  }

  return hits;
}

function buildCoreSkillDetailedTemplate(cap) {
  const promptPath = String(cap.promptPath || '').trim();
  const content = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';
  const snippets = extractJsonSnippetsFromSkill(content, 4);
  const fallback = `{"action":"${cap.target}","args":{"input":"請描述要執行的任務"}}`;
  const examplePayload = snippets.length > 0 ? snippets.join('\n') : fallback;
  return {
    id: `example:skill:${cap.target}:core-detailed`,
    lane: 'skill',
    target: cap.target,
    intent_tags: ['skill', 'core', cap.target],
    error_tags: ['invalid_field', 'missing_required', 'invalid_json_shape'],
    example: examplePayload,
    anti_pattern: '請優先遵循技能內建協議；勿混用 parameters.command，並避免自行發明欄位名稱。'
  };
}

function buildMcpTemplate(cap) {
  const server = String(cap.server || '').trim();
  const tool = String(cap.tool || '').trim();
  const fallbackExample = `{"action":"mcp_call","server":"${server}","tool":"${tool}","parameters":{}}`;
  return {
    id: `example:mcp:${server}/${tool}`,
    lane: 'mcp',
    target: `${server}/${tool}`,
    intent_tags: ['mcp', server, tool],
    error_tags: ['invalid_mcp_call', 'unknown_tool'],
    example: cap.example ? JSON.stringify(cap.example) : fallbackExample,
    anti_pattern: 'mcp_call 必須同時包含 server、tool、parameters。'
  };
}

function upsertExample(entries, nextEntry) {
  const lane = String(nextEntry.lane || '').trim();
  const target = String(nextEntry.target || '').trim();
  const idx = entries.findIndex(item => String(item.lane || '').trim() === lane && String(item.target || '').trim() === target);
  if (idx >= 0) {
    entries[idx] = nextEntry;
    return 'updated';
  }
  entries.push(nextEntry);
  return 'added';
}

function dedupeExamples(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    const lane = String(entry.lane || '').trim();
    const target = String(entry.target || '').trim();
    const key = `${lane}:${target}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, entry);
      continue;
    }
    const prevDetailed = String(prev.id || '').includes(':core-detailed');
    const nextDetailed = String(entry.id || '').includes(':core-detailed');
    if (!prevDetailed && nextDetailed) map.set(key, entry);
  }
  return Array.from(map.values());
}

class ExampleSyncManager {
  sync(userDataDir) {
    const { registry } = CapabilityRegistry.sync(userDataDir);
    const customPath = getCustomExamplesPath(userDataDir);

    const custom = readCustomExamples(customPath);
    const currentAll = ExampleRegistry.listAll();

    let added = 0;
    let updated = 0;
    for (const cap of registry.capabilities || []) {
      if (cap.lane === 'skill' && String(cap.type || '').toLowerCase() === 'core') {
        const detailed = buildCoreSkillDetailedTemplate(cap);
        const result = upsertExample(custom.examples, detailed);
        if (result === 'added') added += 1;
        else updated += 1;
        continue;
      }

      if (cap.exampleCovered) continue;
      if (hasCoverage(custom.examples, cap.lane, cap.target)) continue;
      if (hasCoverage(currentAll, cap.lane, cap.target)) continue;

      if (cap.lane === 'skill') {
        custom.examples.push(buildSkillTemplate(cap));
        added += 1;
      } else if (cap.lane === 'mcp') {
        custom.examples.push(buildMcpTemplate(cap));
        added += 1;
      }
    }

    let writtenPath = customPath;
    if (added > 0 || updated > 0) {
      custom.examples = dedupeExamples(custom.examples);
      writtenPath = writeCustomExamples(userDataDir, custom);
    }

    return {
      customPath: writtenPath,
      added,
      updated,
      totalCustom: custom.examples.length,
      missingAfterSync: Math.max(0, (registry.capabilities || []).length - ((registry.capabilities || []).filter(c => c.exampleCovered).length + added))
    };
  }
}

module.exports = new ExampleSyncManager();
