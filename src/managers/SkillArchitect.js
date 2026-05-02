// File: lib/skill-architect.js
const fs = require('fs');
const path = require('path');
const SkillPackageRegistry = require('./SkillPackageRegistry');

class SkillArchitect {
    constructor(skillsDir) {
        this.skillsDir = skillsDir || null;
    }

    /**
     * 使用 Web Gemini (Brain) 生成技能
     * @param {Object} brain - GolemBrain 實例 (必須包含 sendMessage 方法)
     * @param {string} intent - 使用者需求
     * @param {Array} existingSkills - 現有技能列表
     */
    async designSkill(brain, intent, existingSkills = []) {
        console.log(`🏗️ Architect (Web): Designing skill for "${intent}"...`);

        // 1. 建構 System Prompt
        // 使用「雙標籤分離格式」：metadata 用 JSON，code 獨立用 [[SKILL_CODE_*]] 包住。
        // 這樣無論 JS 內含任何特殊字元，都永遠不會破壞 JSON 解析。
        const systemPrompt = `
        [SYSTEM: ACTIVATE SKILL ARCHITECT MODE - Code Generation Only]
        You are an expert Node.js Developer creating a plugin for the Golem System.

        USER REQUEST: "${intent}"

        ### CONTEXT
        - Environment: Node.js (no browser needed unless stated)
        - The skill exports: module.exports = { name, description, tags, run }
        - run(ctx, args): ctx has { log, io, metadata }
        - Existing Skills: ${existingSkills.map(s => s.name).join(', ')}

        ### STRICT OUTPUT FORMAT (follow exactly, no markdown fences)

        [[SKILL_JSON_START]]
        {
            "filename": "skill-name.js",
            "name": "SKILL_NAME",
            "description": "Short description"
        }
        [[SKILL_JSON_END]]
        [[SKILL_CODE_START]]
        module.exports = {
            name: 'SKILL_NAME',
            description: 'Short description',
            tags: ['#user-generated'],
            async run(ctx, args) {
                // your implementation here
                return 'result message';
            }
        };
        [[SKILL_CODE_END]]

        ### CODE RULES
        1. Use ctx.log.info() not console.log.
        2. Wrap async logic in try/catch.
        3. Return a clear string message.
        4. Do NOT use child_process, eval, or new Function.
        `;

        try {
            // 2. 透過 Brain 發送訊息
            // brain.sendMessage 回傳 { text, attachments }，需解構出 .text
            const brainResult = await brain.sendMessage(systemPrompt);
            const rawResponse = (brainResult && typeof brainResult === 'object')
                ? (brainResult.text || '')
                : String(brainResult || '');

            console.log(`🏗️ Architect: Received response from Web Gemini (${rawResponse.length} chars)`);

            if (!rawResponse) {
                throw new Error('Brain returned an empty response.');
            }

            // 3. 解析回應
            // 優先使用新格式 (雙標籤分離)，fallback 舊格式 (code 嵌在 JSON 內)
            let skillData;

            const jsonMatch = rawResponse.match(/\[\[SKILL_JSON_START\]\]([\s\S]*?)\[\[SKILL_JSON_END\]\]/);
            const codeBlockMatch = rawResponse.match(/\[\[SKILL_CODE_START\]\]([\s\S]*?)\[\[SKILL_CODE_END\]\]/);

            if (jsonMatch && jsonMatch[1] && codeBlockMatch && codeBlockMatch[1]) {
                // ✅ 新格式：JSON metadata + 獨立 code 區塊 (永不爆炸的解析方式)
                try {
                    const meta = JSON.parse(jsonMatch[1].trim());
                    skillData = {
                        filename: meta.filename,
                        name: meta.name,
                        description: meta.description,
                        tags: meta.tags || ['#user-generated'],
                        code: codeBlockMatch[1].trim(),
                    };
                } catch (e) {
                    throw new Error(`Failed to parse skill metadata JSON: ${e.message}`);
                }
            } else if (jsonMatch && jsonMatch[1]) {
                // ⚠️ Fallback：舊格式（code 嵌在 JSON 內），嘗試三層容錯解析
                console.warn('⚠️ Architect: Gemini used legacy format (code inside JSON), attempting fallback parse...');
                const rawBlock = jsonMatch[1].trim();

                // 【第一層】直接 parse
                let parsed = false;
                try { skillData = JSON.parse(rawBlock); parsed = true; } catch (_) {}

                // 【第二層】修復尾隨逗號
                if (!parsed) {
                    try {
                        skillData = JSON.parse(rawBlock.replace(/,(\s*[}\]])/g, '$1'));
                        parsed = true;
                    } catch (_) {}
                }

                // 【第三層】逐欄位 regex 提取
                if (!parsed) {
                    const ex = (key) => {
                        const m = rawBlock.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)"`));
                        return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
                    };
                    const exArr = (key) => {
                        const m = rawBlock.match(new RegExp(`"${key}"\\s*:\\s*(\\[[^\\]]*\\])`));
                        try { return m ? JSON.parse(m[1]) : []; } catch { return []; }
                    };
                    const cm = rawBlock.match(/"code"\s*:\s*"([\s\S]*)"\s*\}?\s*$/);
                    skillData = {
                        filename: ex('filename'),
                        name: ex('name'),
                        description: ex('description'),
                        tags: exArr('tags'),
                        code: cm ? cm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null,
                    };
                    if (!skillData.filename || !skillData.code) {
                        throw new Error('Could not extract skill data from Gemini response after all fallback attempts.');
                    }
                }
            } else {
                throw new Error('Could not find [[SKILL_JSON_START]] marker in Gemini response.');
            }


            // 4. 安全掃描 + 驗證與存檔
            if (!skillData.filename || !skillData.code) {
                throw new Error("Invalid generation: Missing filename or code.");
            }

            // ✅ [H-4 Fix] 寫入磁碟前進行安全掃描，防止惡意 AI 注入危險代碼
            // 注意：使用精確詞彙邊界比對，避免 regex.exec()、str.exec() 等合法呼叫被誤判
            const DANGEROUS_PATTERNS = [
                // require('child_process') — 字串比對即可，無歧義
                /require\s*\(\s*['"]child_process['"]\s*\)/,
                // execSync / spawnSync — 整詞比對
                /\bexecSync\s*\(/,
                /\bspawnSync\s*\(/,
                // exec( / spawn( — 只攔截「非方法呼叫」形式 (前面不能是 . 或識別字)
                // 正確：exec('ls')   錯誤誤判：regex.exec('...')
                /(?<![.\w])exec\s*\(/,
                /(?<![.\w])spawn\s*\(/,
                // eval( / new Function( — 整詞比對
                /\beval\s*\(/,
                /\bnew\s+Function\s*\(/,
            ];
            if (DANGEROUS_PATTERNS.some(pattern => pattern.test(skillData.code))) {
                throw new Error("⚠️ Security: Generated skill contains restricted calls. Deployment blocked.");
            }

            // 修正檔名 (限制為安全字元 + 強制 .js)
            const safeBase = path.basename(String(skillData.filename))
                .replace(/[^a-z0-9._-]/gi, '_')
                .replace(/^\.+/, '');
            skillData.filename = safeBase.endsWith('.js') ? safeBase : `${safeBase}.js`;
            if (!skillData.filename || skillData.filename === '.js') {
                skillData.filename = `learned-skill-${Date.now()}.js`;
            }

            const skillId = SkillPackageRegistry.safeSkillId(
                path.basename(skillData.filename, '.js') || skillData.name,
                `learned-skill-${Date.now()}`
            );
            const packageRoot = this.skillsDir || SkillPackageRegistry.getUserSkillPackageDir(brain && brain.userDataDir);
            if (!fs.existsSync(packageRoot)) {
                fs.mkdirSync(packageRoot, { recursive: true });
            }
            let packageDir = path.join(packageRoot, skillId);

            // 防止意外覆蓋
            if (fs.existsSync(packageDir)) {
                packageDir = path.join(packageRoot, `${skillId}-${Date.now()}`);
            }

            fs.mkdirSync(packageDir, { recursive: true });
            const finalPath = path.join(packageDir, 'index.js');
            const promptPath = path.join(packageDir, 'skill.md');
            const manifestPath = path.join(packageDir, 'manifest.json');
            const runtimeDescription = skillData.description || '由 /learn 動態生成的使用者技能';

            fs.writeFileSync(finalPath, skillData.code);
            fs.writeFileSync(promptPath, [
                `# ${skillData.name || skillId}`,
                '',
                runtimeDescription,
                '',
                '## Runtime Action',
                `- action: \`${skillId}\``,
                '',
                '## Usage Guidance',
                `當使用者需求符合「${intent}」時，優先使用此技能。`
            ].join('\n'), 'utf8');
            fs.writeFileSync(manifestPath, JSON.stringify({
                id: path.basename(packageDir).toLowerCase(),
                name: skillData.name || skillId,
                description: runtimeDescription,
                type: 'user_generated',
                enabled: true,
                action: path.basename(packageDir).toLowerCase(),
                entry: 'index.js',
                prompt: 'skill.md',
                toolsets: ['assistant'],
                triggers: [intent],
                createdBy: 'skill-architect',
                createdAt: new Date().toISOString(),
                version: '1.0.0'
            }, null, 2) + '\n', 'utf8');

            return {
                success: true,
                path: finalPath,
                packagePath: packageDir,
                id: path.basename(packageDir).toLowerCase(),
                name: skillData.name,
                preview: skillData.description,
                code: skillData.code
            };

        } catch (error) {
            console.error("❌ Architect Error:", error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = SkillArchitect;
