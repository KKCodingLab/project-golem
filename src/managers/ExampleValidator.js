'use strict';

const ExampleRegistry = require('./ExampleRegistry');

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function validateExampleEntry(entry) {
  const issues = [];
  if (!entry || typeof entry !== 'object') {
    issues.push('entry_not_object');
    return issues;
  }

  if (!entry.id) issues.push('missing_id');
  if (!entry.lane) issues.push('missing_lane');
  if (!entry.target) issues.push('missing_target');
  if (!entry.example) issues.push('missing_example');

  const lane = String(entry.lane || '').trim();
  const raw = String(entry.example || '').trim();
  const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
  const first = lines[0] || '';
  const parsed = parseJsonLine(first);

  if (!parsed || typeof parsed !== 'object') {
    issues.push('example_not_json_object');
    return issues;
  }

  if (lane === 'command') {
    if (parsed.action !== 'command') issues.push('command_action_mismatch');
    if (typeof parsed.parameter !== 'string' || !parsed.parameter.trim()) issues.push('command_missing_parameter');
  }

  if (lane === 'skill') {
    if (!parsed.action) issues.push('skill_missing_action');
    if (parsed.action === 'mcp_call' || parsed.action === 'command') issues.push('skill_lane_wrong_action_type');
  }

  if (lane === 'mcp') {
    if (parsed.action !== 'mcp_call') issues.push('mcp_action_mismatch');
    if (!parsed.server) issues.push('mcp_missing_server');
    if (!parsed.tool) issues.push('mcp_missing_tool');
    if (!Object.prototype.hasOwnProperty.call(parsed, 'parameters')) issues.push('mcp_missing_parameters');
  }

  return issues;
}

class ExampleValidator {
  validateAll() {
    const entries = ExampleRegistry.listAll();
    const results = [];
    let invalid = 0;

    for (const entry of entries) {
      const issues = validateExampleEntry(entry);
      if (issues.length > 0) invalid += 1;
      results.push({ id: entry.id, lane: entry.lane, target: entry.target, issues });
    }

    return {
      total: entries.length,
      valid: entries.length - invalid,
      invalid,
      results
    };
  }
}

module.exports = new ExampleValidator();
