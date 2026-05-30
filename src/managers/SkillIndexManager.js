const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises;
const path = require('path');
const SkillPackageRegistry = require('./SkillPackageRegistry');

class SkillIndexManager {
    constructor(userDataDir) {
        if (!userDataDir) {
            const ConfigManager = require('../config');
            userDataDir = ConfigManager.MEMORY_BASE_DIR;
        }
        this.dbPath = path.join(userDataDir, 'skills.db');
        this.db = null;
        this.libPath = path.join(process.cwd(), 'src', 'skills', 'lib');
    }

    /**
     * 初始化資料庫與資料表
     */
    async init() {
        if (this.db) return;

        // 確保目錄存在
        const dbDir = path.dirname(this.dbPath);
        try {
            await fs.mkdir(dbDir, { recursive: true });
        } catch (e) { }

        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) return reject(err);

                this.db.run(`
                    CREATE TABLE IF NOT EXISTS skills (
                        id TEXT PRIMARY KEY,
                        name TEXT,
                        description TEXT,
                        content TEXT,
                        path TEXT,
                        category TEXT,
                        last_modified INTEGER
                    )
                `, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    }

    /**
     * 同步本地檔案到 SQLite 索引
     * @param {string[]} enabledIds - 可選的啟動技能清單，若提供則只同步清單中的檔案並移除其他的（除了 mandatory）
     */
    /**
     * 同步本地技能到 SQLite 索引。
     * 同步來源有兩個：
     *   1. src/skills/lib/*.md（舊式 lib 技能，若目錄存在）
     *   2. SkillPackageRegistry 掃描到的所有 package 技能（src/skills/modules/ 等）
     * 所有 enabled 的 package 技能都會被加入，不受 enabledIds 限制。
     * @param {string[]} enabledIds - lib 技能的啟動清單（MANDATORY + persona）
     */
    async sync(enabledIds = []) {
        await this.init();

        const { MANDATORY_SKILLS } = require('../skills/skillsConfig');
        const effectiveIds = new Set([
            ...MANDATORY_SKILLS,
            ...enabledIds
        ]);

        const dbDir = path.dirname(this.dbPath);
        console.log(`📡 [SkillIndex][${path.basename(dbDir)}] 開始同步技能說明書...`);

        // ── 1. 同步 lib/*.md 舊式技能（若目錄存在）──────────────────────
        try {
            let files = [];
            try {
                files = await fs.readdir(this.libPath);
            } catch (e) {
                if (e && e.code !== 'ENOENT') throw e;
            }
            const mdFiles = files.filter(f => f.endsWith('.md'));

            for (const file of mdFiles) {
                const skillId = path.basename(file, '.md').toLowerCase();
                if (effectiveIds.has(skillId)) {
                    await this.addSkill(skillId);
                } else {
                    await this.removeSkill(skillId);
                }
            }
        } catch (e) {
            console.error('❌ [SkillIndex] lib 技能同步失敗:', e.message);
        }

        // ── 2. 同步所有 SkillPackageRegistry package 技能（全部 enabled 的都加）──
        const packages = SkillPackageRegistry.listSkillPackages({ userDataDir: dbDir });
        let synced = 0;
        for (const pkg of packages) {
            if (pkg.enabled) {
                await this.addSkillPackage(pkg);
                synced++;
            } else {
                await this.removeSkill(pkg.id);
            }
        }
        console.log(`🏁 [SkillIndex][${path.basename(dbDir)}] 同步完成 (lib=${effectiveIds.size}, packages=${synced})。`);
    }

    /**
     * 強制將特定技能載入到 SQLite
     */
    async addSkill(id) {
        await this.init();
        const filePath = path.join(this.libPath, `${id}.md`);
        try {
            await fs.access(filePath);
            const stats = await fs.stat(filePath);
            const lastModified = stats.mtimeMs;

            const needsUpdate = await this._checkNeedsUpdate(id, lastModified);
            if (needsUpdate) {
                let content = await fs.readFile(filePath, 'utf-8');
                const name = this._extractName(content) || id.toUpperCase();
                const description = this._extractDescription(content);

                // 🎯 修正：移除 <SkillModule> 標籤，防止路徑洩漏導致 Golem 產生幻覺
                content = content.replace(/<SkillModule.*?>/gi, '').replace(/<\/SkillModule>/gi, '').trim();

                await this._upsertSkill({
                    id,
                    name,
                    description,
                    content,
                    path: filePath,
                    category: 'lib',
                    last_modified: lastModified
                });
                console.log(`✅ [SkillIndex] 已加入/更新 (已去除標籤): ${id}`);
            }
        } catch (e) {
            const pkg = SkillPackageRegistry.listSkillPackages({ userDataDir: path.dirname(this.dbPath) })
                .find(item => item.id === id || item.action === id);
            if (pkg) {
                await this.addSkillPackage(pkg);
                return;
            }
            console.warn(`⚠️ [SkillIndex] 無法載入技能檔案 ${id}:`, e.message);
        }
    }

    async addSkillPackage(pkg) {
        await this.init();
        if (!pkg || !pkg.id) return;
        const lastModified = SkillPackageRegistry.getPackageLastModified(pkg);
        const needsUpdate = await this._checkNeedsUpdate(pkg.id, lastModified);
        if (!needsUpdate) return;

        const content = SkillPackageRegistry.buildPromptContent(pkg);
        await this._upsertSkill({
            id: pkg.id,
            name: pkg.name || pkg.id,
            description: pkg.description || '',
            content,
            path: pkg.dir || '',
            category: pkg.type || 'user_generated',
            last_modified: lastModified
        });
        console.log(`✅ [SkillIndex] 已加入/更新 package skill: ${pkg.id}`);
    }

    /**
     * 從 SQLite 移除特定技能
     */
    async removeSkill(id) {
        await this.init();
        return new Promise((resolve, reject) => {
            this.db.run("DELETE FROM skills WHERE id = ?", [id], (err) => {
                if (err) reject(err);
                else {
                    console.log(`🗑️ [SkillIndex] 已移除: ${id}`);
                    resolve();
                }
            });
        });
    }

    /**
     * 搜尋相關技能
     */
    async searchSkills(query) {
        await this.init();
        return new Promise((resolve, reject) => {
            this.db.all(
                "SELECT id, name, description FROM skills WHERE name LIKE ? OR description LIKE ? OR content LIKE ? LIMIT 5",
                [`%${query}%`, `%${query}%`, `%${query}%`],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    /**
     * 取得所有已索引的技能清單
     */
    async listAllSkills() {
        await this.init();
        return new Promise((resolve, reject) => {
            this.db.all("SELECT id, name, description, category FROM skills ORDER BY id ASC", (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    /**
     * 取得完整技能索引 (含 content/path 等欄位)
     */
    async listSkillEntries() {
        await this.init();
        return new Promise((resolve, reject) => {
            this.db.all(
                "SELECT id, name, description, content, path, category, last_modified FROM skills ORDER BY id ASC",
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * 直接寫入一筆技能索引紀錄（不依賴 lib/*.md）
     * 適用於 /learn 動態生成的 runtime skill
     */
    async upsertSkillRecord(record = {}) {
        await this.init();
        const id = String(record.id || '').trim().toLowerCase();
        if (!id) throw new Error('upsertSkillRecord: missing skill id');

        await this._upsertSkill({
            id,
            name: String(record.name || id).trim(),
            description: String(record.description || '').trim(),
            content: String(record.content || '').trim(),
            path: String(record.path || '').trim(),
            category: String(record.category || 'user_dynamic').trim(),
            last_modified: Number(record.last_modified || Date.now())
        });
    }

    /**
     * 取得啟用的技能內容
     */
    async getEnabledSkills(skillIds) {
        await this.init();
        if (!skillIds || skillIds.length === 0) return [];

        const placeholders = skillIds.map(() => '?').join(',');
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT id, name, content FROM skills WHERE id IN (${placeholders})`,
                skillIds,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    /**
     * 關閉連線
     */
    async close() {
        if (this.db) {
            return new Promise((resolve) => {
                this.db.close(() => {
                    this.db = null;
                    resolve();
                });
            });
        }
    }

    // --- Private Helpers ---

    async _checkNeedsUpdate(id, lastModified) {
        return new Promise((resolve) => {
            this.db.get("SELECT last_modified FROM skills WHERE id = ?", [id], (err, row) => {
                if (err || !row) resolve(true);
                else resolve(row.last_modified !== lastModified);
            });
        });
    }

    async _upsertSkill(skill) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO skills (id, name, description, content, path, category, last_modified)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    description=excluded.description,
                    content=excluded.content,
                    path=excluded.path,
                    category=excluded.category,
                    last_modified=excluded.last_modified
            `, [skill.id, skill.name, skill.description, skill.content, skill.path, skill.category, skill.last_modified], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    _extractName(content) {
        const match = content.match(/【已載入技能：(.*?)\s*\((.*?)\)】/) || content.match(/【已載入技能：(.*?)】/);
        return match ? match[1] : null;
    }

    _extractDescription(content) {
        // 簡單地抓取第一行非空文字
        const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('<'));
        return lines.length > 0 ? lines[0] : "";
    }
}

module.exports = SkillIndexManager;
