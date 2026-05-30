'use strict';

const ExampleRegistry = require('./ExampleRegistry');

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function lexicalScore(example, ctx) {
  let score = 0;
  const target = normalizeText(ctx.target);
  const errorText = normalizeText(ctx.errorText);
  const intentText = normalizeText(ctx.userQuery);

  if (target && normalizeText(example.target) === target) score += 30;
  if (target && normalizeText(example.target).includes(target)) score += 12;

  for (const tag of example.error_tags || []) {
    if (errorText.includes(normalizeText(tag))) score += 10;
  }
  for (const tag of example.intent_tags || []) {
    if (intentText.includes(normalizeText(tag))) score += 6;
  }

  if ((ctx.lane || '') === example.lane) score += 10;
  if ((ctx.attempt || 0) > 0 && (example.error_tags || []).length > 0) score += 4;

  return score;
}

async function vectorBoost(examples, ctx) {
  const vectorIndex = ctx.toolVectorIndex;
  if (!vectorIndex || typeof vectorIndex.search !== 'function') return new Map();
  const query = [ctx.lane, ctx.target, ctx.errorText, ctx.userQuery].filter(Boolean).join(' | ');
  if (!query.trim()) return new Map();

  try {
    const hits = await vectorIndex.search(query, { limit: 12 });
    const map = new Map();
    for (const hit of hits) {
      if (!String(hit.id || '').startsWith('example:')) continue;
      map.set(hit.id, Math.max(0, Number(hit.score || 0)) * 20);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

class ExampleResolver {
  async resolve(ctx = {}) {
    const lane = String(ctx.lane || 'skill').trim().toLowerCase();
    const candidates = ExampleRegistry.listByLane(lane);
    if (candidates.length === 0) return [];

    const boosts = await vectorBoost(candidates, ctx);
    return candidates
      .map(item => ({
        ...item,
        score: lexicalScore(item, ctx) + (boosts.get(item.id) || 0)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(ctx.limit || 3));
  }

  async resolveText(ctx = {}) {
    const items = await this.resolve({ ...ctx, limit: 3 });
    if (!items.length) return '';
    return items.map(item => item.example).join('\n');
  }
}

module.exports = new ExampleResolver();
