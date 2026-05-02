const fs = require('fs');
const path = require('path');
const persona = require('./core/persona');
const CORE_DEFINITION = require('./core/definition');
const SkillPackageRegistry = require('../managers/SkillPackageRegistry');

// ============================================================
// 2. 技能庫 - 自動發現版 (SKILL LIBRARY v9.1+)
// ============================================================

// 🎯 v9.1.5 解耦：不再於模組加載時自動掃描技能
const SKILLS = {};
let _isLoaded = false;

function loadSkills(force = false) {
    if (_isLoaded && !force) return SKILLS;

    const coreDir = path.join(__dirname, 'core');
    if (fs.existsSync(coreDir)) {
        const files = fs.readdirSync(coreDir);
        files.forEach(file => {
            if (!file.endsWith('.js')) return;
            const skillName = file.replace('.js', '').toUpperCase().replace(/-/g, '_');
            try {
                const skillModule = require(`./core/${file}`);
                SKILLS[skillName] = skillModule;
                // 只有在非 dashboard 模式或強制加載時才打日誌，避免啟動干擾
                if (!process.argv.includes('dashboard') || force) {
                    console.log(`✅ [Skills:Core] 已加載: ${skillName}`);
                }
            } catch (e) {
                console.warn(`⚠️ [Skills:Core] 加載失敗: ${file} - ${e.message}`);
            }
        });
    }

    for (const pkg of SkillPackageRegistry.listSkillPackages()) {
        if (!pkg.enabled) continue;
        const skillName = pkg.id.toUpperCase().replace(/-/g, '_');
        try {
            let skillModule = {};
            if (fs.existsSync(pkg.indexPath)) {
                delete require.cache[require.resolve(pkg.indexPath)];
                skillModule = require(pkg.indexPath);
            }
            const prompt = SkillPackageRegistry.readPackagePrompt(pkg);
            SKILLS[skillName] = {
                ...skillModule,
                PROMPT: skillModule.PROMPT || prompt,
                paramsSchema: skillModule.paramsSchema,
            };
            if (!process.argv.includes('dashboard') || force) {
                console.log(`✅ [Skills:Package] 已加載: ${skillName}`);
            }
        } catch (e) {
            console.warn(`⚠️ [Skills:Package] 加載失敗: ${pkg.id} - ${e.message}`);
        }
    }

    if (!process.argv.includes('dashboard') || force) {
        console.log(`📚 [Skills] 共加載 ${Object.keys(SKILLS).length} 個技能`);
    }

    _isLoaded = true;
    return SKILLS;
}

// ============================================================
// 3. 匯出邏輯
// ============================================================
module.exports = {
    persona: persona,
    loadSkills,
    getSKILLS: () => SKILLS,

    getSystemPrompt: (systemInfo) => {
        const currentSkills = loadSkills(); // 確保已加載
        let fullPrompt = CORE_DEFINITION(systemInfo) + "\n";
        const userDataDir = systemInfo && typeof systemInfo === 'object' ? systemInfo.userDataDir : null;

        for (const [name, module] of Object.entries(currentSkills)) {
            const prompt = typeof module === 'string' ? module : (module.PROMPT || "");
            if (!prompt) continue;

            const lines = prompt.trim().split('\n');
            const firstLine = lines.length > 1 ? lines[1] : (lines[0] || "（無描述）");
            fullPrompt += `> [${name}]: ${firstLine.replace('【已載入技能：', '').replace('】', '')}\n`;
        }

        fullPrompt += "\n📚 **技能詳細手冊:**\n";
        for (const [name, module] of Object.entries(currentSkills)) {
            const prompt = typeof module === 'string' ? module : (module.PROMPT || "");
            if (!prompt) continue;

            fullPrompt += `\n--- Skill: ${name} ---\n${prompt}`;

            // 📋 [OpenHarness-inspired] paramsSchema 自動附加參數說明
            if (module.paramsSchema && typeof module.paramsSchema === 'object') {
                const schemaLines = Object.entries(module.paramsSchema).map(([param, def]) => {
                    const req = def.required ? '(必填)' : '(選填)';
                    const enumStr = def.enum ? ` 可選值: [${def.enum.join('|')}]` : '';
                    return `  - ${param} ${req}: ${def.description || ''}${enumStr}`;
                });
                fullPrompt += `\n📌 **參數格式**:\n${schemaLines.join('\n')}\n`;
            }
        }

        fullPrompt += `\n[系統就緒] 請等待 ${persona.get(userDataDir).userName} 的指令。`;
        return fullPrompt;
    }
};
