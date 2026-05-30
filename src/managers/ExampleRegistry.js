'use strict';

const fs = require('fs');
const path = require('path');

const BASE_EXAMPLES_PATH = path.resolve(process.cwd(), 'src', 'config', 'action-examples.json');
const CUSTOM_EXAMPLES_PATHS = [
  path.resolve(process.cwd(), 'golem_memory', 'examples', 'custom-action-examples.json'),
  path.resolve(process.cwd(), 'data', 'examples', 'custom-action-examples.json')
];

function normalizeLane(value) {
  const lane = String(value || '').trim().toLowerCase();
  if (lane === 'skill' || lane === 'mcp' || lane === 'command') return lane;
  return 'skill';
}

function normalizeExample(entry = {}) {
  const lane = normalizeLane(entry.lane);
  const target = String(entry.target || '').trim();
  return {
    id: String(entry.id || '').trim() || `example:${lane}:${target || 'generic'}`,
    lane,
    target,
    intent_tags: Array.isArray(entry.intent_tags) ? entry.intent_tags.map(v => String(v).trim()).filter(Boolean) : [],
    error_tags: Array.isArray(entry.error_tags) ? entry.error_tags.map(v => String(v).trim()).filter(Boolean) : [],
    example: String(entry.example || '').trim(),
    anti_pattern: String(entry.anti_pattern || '').trim()
  };
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

class ExampleRegistry {
  constructor() {
    this._cache = null;
    this._cacheAt = 0;
    this._ttlMs = 5000;
  }

  _load() {
    const now = Date.now();
    if (this._cache && (now - this._cacheAt) < this._ttlMs) return this._cache;

    const base = readJsonSafe(BASE_EXAMPLES_PATH);
    const baseEntries = Array.isArray(base && base.examples) ? base.examples : [];
    const customEntries = [];
    for (const customPath of CUSTOM_EXAMPLES_PATHS) {
      const custom = readJsonSafe(customPath);
      if (custom && Array.isArray(custom.examples)) {
        customEntries.push(...custom.examples);
      }
    }

    const merged = [...baseEntries, ...customEntries].map(normalizeExample).filter(item => item.example);

    this._cache = merged;
    this._cacheAt = now;
    return merged;
  }

  listAll() {
    return this._load();
  }

  listByLane(lane) {
    const safeLane = normalizeLane(lane);
    return this._load().filter(item => item.lane === safeLane);
  }
}

module.exports = new ExampleRegistry();
