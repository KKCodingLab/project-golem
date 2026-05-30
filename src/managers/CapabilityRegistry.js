'use strict';

const fs = require('fs');
const path = require('path');
const SkillPackageRegistry = require('./SkillPackageRegistry');
const MCPToolCatalog = require('../mcp/MCPToolCatalog');
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

function getRegistryPaths(userDataDir) {
  const base = userDataDir || path.resolve(process.cwd(), 'golem_memory');
  const primary = path.join(base, 'capabilities', 'registry.json');
  const fallback = path.resolve(process.cwd(), 'data', 'capabilities', 'registry.json');
  return { primary, fallback };
}

function writeRegistryFile(userDataDir, payload) {
  const { primary, fallback } = getRegistryPaths(userDataDir);
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

function collectSkills(userDataDir) {
  return SkillPackageRegistry.listSkillPackages({ userDataDir })
    .filter(pkg => pkg.enabled !== false)
    .map(pkg => ({
      id: pkg.id,
      lane: 'skill',
      action: pkg.action || pkg.id,
      name: pkg.name || pkg.id,
      description: pkg.description || '',
      type: pkg.type || '',
      promptPath: pkg.promptPath || ''
    }));
}

function collectMcpTools() {
  const catalog = MCPToolCatalog.buildCatalog();
  const tools = Array.isArray(catalog && catalog.tools) ? catalog.tools : [];
  return tools.map(tool => ({
    id: `${tool.server}/${tool.name}`,
    lane: 'mcp',
    server: tool.server,
    tool: tool.name,
    name: tool.name,
    description: tool.description || '',
    example: tool.example || null
  }));
}

function buildCoverage(capabilities, examples) {
  const byId = new Set();
  const byTarget = new Set();
  for (const ex of examples) {
    byId.add(String(ex.id || '').trim());
    byTarget.add(`${String(ex.lane || '').trim()}:${String(ex.target || '').trim()}`);
  }

  return capabilities.map(cap => {
    const lane = String(cap.lane || '').trim();
    const target = lane === 'skill'
      ? String(cap.action || cap.id || '').trim()
      : lane === 'mcp'
        ? `${String(cap.server || '').trim()}/${String(cap.tool || '').trim()}`
        : String(cap.id || '').trim();

    const covered = byTarget.has(`${lane}:${target}`) || byId.has(`example:${lane}:${target}`);
    return { ...cap, target, exampleCovered: covered };
  });
}

class CapabilityRegistry {
  sync(userDataDir) {
    const skills = collectSkills(userDataDir);
    const mcpTools = collectMcpTools();
    const examples = ExampleRegistry.listAll();

    const capabilities = buildCoverage([...skills, ...mcpTools], examples);
    const registry = {
      version: 1,
      generatedAt: new Date().toISOString(),
      summary: {
        skills: skills.length,
        mcpTools: mcpTools.length,
        total: capabilities.length,
        coveredExamples: capabilities.filter(c => c.exampleCovered).length
      },
      capabilities
    };

    const outPath = writeRegistryFile(userDataDir, registry);

    return { path: outPath, registry };
  }
}

module.exports = new CapabilityRegistry();
