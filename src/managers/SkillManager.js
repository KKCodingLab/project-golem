// File: lib/skill-manager.js
/**
     * 這是「技能圖書館員」。它負責加載技能，並提供 exportSkill (打包) 與 importSkill (安裝) 功能。
     * 這實現了技能可以社群分享的功能。
     */
const fs = require('fs');
const path = require('path');
const SkillPackageRegistry = require('./SkillPackageRegistry');

class SkillManager {
    constructor() {
        this.baseDir = path.join(process.cwd(), 'src', 'skills');
        this.userDir = path.join(this.baseDir, 'user');
        this.coreDir = path.join(this.baseDir, 'core');
        this.generatedDir = path.join(this.baseDir, 'generated');
        this.modulesDir = path.join(this.baseDir, 'modules');

        this.skills = new Map();
        // 🎯 v9.1.5 解耦：不再於建構子中主動掃描，改為懶加載
    }

    /**
     * 熱重載所有技能 (清除 require 快取)
     */
    refresh() {
        // 確保目錄結構在需要加載時才建立
        [this.baseDir, this.userDir, this.coreDir, this.generatedDir, this.modulesDir].forEach(dir => {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });

        this.skills.clear();
        const isDashboard = process.argv.includes('dashboard');
        if (!isDashboard) {
            console.log("🔄 Skill Manager: Reloading skills...");
        }

        const loadFromDir = (dir, type) => {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

            for (const file of files) {
                try {
                    const fullPath = path.join(dir, file);
                    // 關鍵：清除快取以支援熱更新
                    delete require.cache[require.resolve(fullPath)];

                    const skillModule = require(fullPath);

                    // 驗證模組結構
                    if (skillModule.name && typeof skillModule.run === 'function') {
                        this.skills.set(skillModule.name, {
                            ...skillModule,
                            _filepath: fullPath,
                            _type: type
                        });
                    }
                } catch (err) {
                    console.error(`⚠️ Failed to load skill [${file}]:`, err.message);
                }
            }
        };

        loadFromDir(this.coreDir, 'CORE');
        loadFromDir(this.userDir, 'USER');
        this._loadPackageSkills();

        console.log(`📚 Skills Loaded: ${this.skills.size} (Core + User + Packages)`);
        return this.skills;
    }

    _loadPackageSkills() {
        const packages = SkillPackageRegistry.listSkillPackages();
        for (const pkg of packages) {
            if (!pkg.enabled || !fs.existsSync(pkg.indexPath)) continue;
            try {
                delete require.cache[require.resolve(pkg.indexPath)];
                const skillModule = require(pkg.indexPath);
                if (!skillModule.name && !pkg.action) continue;
                if (typeof skillModule.run !== 'function') continue;

                const normalizedSkill = {
                    ...skillModule,
                    name: pkg.action || skillModule.name || pkg.id,
                    description: skillModule.description || pkg.description || '',
                    _filepath: pkg.indexPath,
                    _type: pkg.type === 'core' ? 'CORE_PACKAGE' : 'USER_PACKAGE',
                    _package: pkg,
                };

                this.skills.set(normalizedSkill.name, normalizedSkill);
                if (pkg.id !== normalizedSkill.name) this.skills.set(pkg.id, normalizedSkill);
                if (skillModule.name && skillModule.name !== normalizedSkill.name) {
                    this.skills.set(skillModule.name, normalizedSkill);
                }
            } catch (err) {
                console.error(`⚠️ Failed to load skill package [${pkg.id}]:`, err.message);
            }
        }
    }

    /**
     * 獲取技能執行函數
     */
    getSkill(name) {
        if (this.skills.size === 0) this.refresh();
        return this.skills.get(name);
    }

    /**
     * 匯出技能為「技能膠囊」 (Base64 String)
     * 用於社群分享
     */
    exportSkill(name) {
        const skill = this.skills.get(name);
        if (!skill) throw new Error(`Skill "${name}" not found.`);
        if (skill._type === 'CORE' || skill._type === 'CORE_PACKAGE') throw new Error("Cannot export Core skills.");

        try {
            const code = fs.readFileSync(skill._filepath, 'utf-8');
            const payload = {
                n: skill.name,    // Name
                v: skill.version || "1.0",
                t: Date.now(),    // Timestamp
                c: code           // Code content
            };

            // 轉為 Base64 字串
            const buffer = Buffer.from(JSON.stringify(payload));
            return `GOLEM_SKILL::${buffer.toString('base64')}`;
        } catch (err) {
            throw new Error(`Export failed: ${err.message}`);
        }
    }

    /**
     * 匯入「技能膠囊」
     */
    importSkill(token) {
        if (!token.startsWith('GOLEM_SKILL::')) {
            throw new Error("Invalid Skill Capsule format.");
        }

        try {
            const base64 = token.split('::')[1];
            const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
            const payload = JSON.parse(jsonStr);

            // 基本安全檢查
            if (!payload.n || !payload.c) throw new Error("Corrupted skill data.");

            // 安全過濾器 (簡易版)
            const dangerousKeywords = ['require("child_process")', "require('child_process')", 'exec(', 'spawn('];
            if (dangerousKeywords.some(k => payload.c.includes(k))) {
                throw new Error("⚠️ Security Alert: This skill contains restricted system calls.");
            }

            const skillId = SkillPackageRegistry.safeSkillId(`imported-${payload.n}`, `imported-skill-${Date.now()}`);
            const packageRoot = SkillPackageRegistry.getUserSkillPackageDir();
            const packageDir = path.join(packageRoot, skillId);
            const filePath = path.join(packageDir, 'index.js');

            // 備份舊檔 (如果存在)
            if (fs.existsSync(packageDir)) {
                fs.renameSync(packageDir, packageDir + `.bak-${Date.now()}`);
            }

            fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(filePath, payload.c);
            fs.writeFileSync(path.join(packageDir, 'skill.md'), [
                `# ${payload.n}`,
                '',
                '由 GOLEM_SKILL 膠囊匯入的使用者技能。',
                '',
                '## Runtime Action',
                `- action: \`${skillId}\``
            ].join('\n'), 'utf8');
            fs.writeFileSync(path.join(packageDir, 'manifest.json'), JSON.stringify({
                id: skillId,
                name: payload.n,
                description: '由 GOLEM_SKILL 匯入',
                type: 'user_generated',
                enabled: true,
                action: skillId,
                entry: 'index.js',
                prompt: 'skill.md',
                toolsets: ['assistant'],
                triggers: [],
                createdBy: 'GOLEM_SKILL',
                createdAt: new Date().toISOString(),
                version: payload.v || '1.0'
            }, null, 2) + '\n', 'utf8');

            // 立即重新載入
            this.refresh();

            return { success: true, name: payload.n, path: filePath, packagePath: packageDir };

        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    listSkills() {
        if (this.skills.size === 0) this.refresh();
        return Array.from(this.skills.values()).map(s => ({
            name: s.name,
            description: s.description,
            type: s._type
        }));
    }
}

module.exports = new SkillManager();
