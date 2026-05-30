'use strict';
// ============================================================
// 🔍 ToolVectorIndex — 技能與 MCP 工具的向量索引
//
// 使用與記憶系統相同的 Embedding Provider，將每個技能/工具的
// id + name + description + triggers 向量化後存入 LanceDB，
// 讓 ToolRouter 在每輪對話時能用語意搜尋找到最相關的工具。
//
// 設計原則：
// - 不依賴 GolemBrain，可獨立初始化
// - 與 LanceDBProDriver 共用 EmbeddingFactory，不重複載入模型
// - 索引存在 {userDataDir}/tool-vector-index/ 下，與記憶庫隔離
// - 支援增量更新（hash 比對，未變動的不重新 embed）
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

function hashEntry(text) {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function buildEntryText(item) {
    // 把所有可搜尋欄位拼成一段文字用於 embedding
    const parts = [
        item.id || '',
        item.name || '',
        item.description || '',
        ...(item.triggers || []),
        item.serverName ? `server:${item.serverName}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
}

class ToolVectorIndex {
    /**
     * @param {string} userDataDir  - golem_memory 路徑
     * @param {object} embedder     - { embedQuery(text): Promise<number[]>, dimensions: number }
     */
    constructor(userDataDir, embedder) {
        this.userDataDir = userDataDir || path.resolve('./golem_memory');
        this.indexDir = path.join(this.userDataDir, 'tool-vector-index');
        this.metaPath = path.join(this.indexDir, 'meta.json');
        this.embedder = embedder; // 由外部注入，避免重複初始化 Worker
        this._table = null;
        this._db = null;
        this._initPromise = null;
        this._meta = null; // { version, hashes: { [id]: hash } }
    }

    // ── 初始化 ────────────────────────────────────────────────────────────────

    async init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInit().catch(e => {
            this._initPromise = null;
            throw e;
        });
        return this._initPromise;
    }

    async _doInit() {
        if (!fs.existsSync(this.indexDir)) fs.mkdirSync(this.indexDir, { recursive: true });

        // 讀取 meta（記錄每個 entry 的 hash，用於增量更新）
        this._meta = this._loadMeta();

        // 取得 embedding 維度
        const dims = this.embedder.dimensions || (await this._probeDimensions());

        // 用 jiti 載入 lancedb（與 LanceDBProDriver 相同方式）
        let cachedJiti = null;
        if (!cachedJiti) {
            const { createJiti } = require('jiti');
            cachedJiti = createJiti(__filename);
        }
        const lancedb = await cachedJiti.import('@lancedb/lancedb');
        this._db = await lancedb.connect(path.join(this.indexDir, 'lancedb'));

        // 建立或開啟 table
        const tableNames = await this._db.tableNames();
        if (tableNames.includes('tools')) {
            this._table = await this._db.openTable('tools');
        } else {
            // 建立空 table，schema 由第一筆資料決定
            this._table = null; // 延遲到第一次 upsert 時建立
        }

        console.log(`🔍 [ToolVectorIndex] 初始化完成 (dims=${dims}, entries=${Object.keys(this._meta.hashes).length})`);
    }

    async _probeDimensions() {
        const vec = await this.embedder.embedQuery('test');
        return vec.length;
    }

    // ── 索引更新 ──────────────────────────────────────────────────────────────

    /**
     * 批次更新索引。只對 hash 有變動的 entry 重新 embed。
     * @param {Array<{id, name, description, triggers?, serverName?, kind}>} items
     */
    async upsertMany(items) {
        await this.init();
        if (!items || items.length === 0) return;

        const toEmbed = [];
        for (const item of items) {
            const text = buildEntryText(item);
            const hash = hashEntry(text);
            if (this._meta.hashes[item.id] === hash) continue; // 未變動，跳過
            toEmbed.push({ item, text, hash });
        }

        if (toEmbed.length === 0) {
            console.log(`🔍 [ToolVectorIndex] 所有 ${items.length} 個工具/技能無變動，跳過重新 embed`);
            return;
        }

        console.log(`🔍 [ToolVectorIndex] 正在 embed ${toEmbed.length}/${items.length} 個工具/技能...`);

        const rows = [];
        for (const { item, text, hash } of toEmbed) {
            try {
                const vector = await this.embedder.embedQuery(text);
                rows.push({
                    id: String(item.id),
                    kind: String(item.kind || 'skill'),
                    name: String(item.name || item.id),
                    description: String(item.description || ''),
                    serverName: String(item.serverName || ''),
                    triggers: JSON.stringify(item.triggers || []),
                    entryHash: hash,
                    vector,
                });
                this._meta.hashes[item.id] = hash;
            } catch (e) {
                console.warn(`⚠️ [ToolVectorIndex] embed 失敗 (${item.id}): ${e.message}`);
            }
        }

        if (rows.length === 0) return;

        // 刪除舊的同 id 記錄，再插入新的
        if (this._table) {
            try {
                const ids = rows.map(r => `'${r.id.replace(/'/g, "''")}'`).join(',');
                await this._table.delete(`id IN (${ids})`);
                await this._table.add(rows);
            } catch (e) {
                // 若 table 操作失敗，嘗試重建
                console.warn(`⚠️ [ToolVectorIndex] upsert 失敗，嘗試重建 table: ${e.message}`);
                await this._rebuildTable(rows);
            }
        } else {
            // 第一次建立 table
            await this._rebuildTable(rows);
        }

        this._saveMeta();
        console.log(`✅ [ToolVectorIndex] 已更新 ${rows.length} 個工具/技能向量`);
    }

    async _rebuildTable(rows) {
        try {
            const tableNames = await this._db.tableNames();
            if (tableNames.includes('tools')) {
                await this._db.dropTable('tools');
            }
        } catch (_) {}
        this._table = await this._db.createTable('tools', rows);
    }

    /**
     * 移除已不存在的工具（清理孤立記錄）
     * @param {string[]} currentIds - 目前所有有效的 id 清單
     */
    async pruneDeleted(currentIds) {
        await this.init();
        if (!this._table) return;
        const currentSet = new Set(currentIds);
        const staleIds = Object.keys(this._meta.hashes).filter(id => !currentSet.has(id));
        if (staleIds.length === 0) return;

        try {
            const ids = staleIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
            await this._table.delete(`id IN (${ids})`);
            for (const id of staleIds) delete this._meta.hashes[id];
            this._saveMeta();
            console.log(`🗑️ [ToolVectorIndex] 已清理 ${staleIds.length} 個過期工具/技能`);
        } catch (e) {
            console.warn(`⚠️ [ToolVectorIndex] 清理失敗: ${e.message}`);
        }
    }

    // ── 向量搜尋 ──────────────────────────────────────────────────────────────

    /**
     * 語意搜尋最相關的工具/技能
     * @param {string} query
     * @param {object} options
     * @param {number} [options.limit=8]
     * @param {'skill'|'mcp'|null} [options.kind=null] - 過濾類型
     * @returns {Promise<Array<{id, kind, name, description, serverName, score}>>}
     */
    async search(query, options = {}) {
        await this.init();
        if (!this._table) return [];

        const limit = Number(options.limit || 8);
        const kind = options.kind || null;

        try {
            const queryVec = await this.embedder.embedQuery(query);
            let builder = this._table.vectorSearch(queryVec).limit(limit * 2); // 多取一些再過濾

            const results = await builder.toArray();

            return results
                .filter(r => !kind || r.kind === kind)
                .slice(0, limit)
                .map(r => ({
                    id: r.id,
                    kind: r.kind,
                    name: r.name,
                    description: r.description,
                    serverName: r.serverName || '',
                    score: r._distance !== undefined ? (1 - r._distance) : 0.5, // 轉換距離為相似度
                }));
        } catch (e) {
            console.warn(`⚠️ [ToolVectorIndex] 搜尋失敗: ${e.message}`);
            return [];
        }
    }

    // ── Meta 持久化 ───────────────────────────────────────────────────────────

    _loadMeta() {
        try {
            if (fs.existsSync(this.metaPath)) {
                const raw = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
                if (raw.version === SCHEMA_VERSION) return raw;
            }
        } catch (_) {}
        return { version: SCHEMA_VERSION, hashes: {} };
    }

    _saveMeta() {
        try {
            fs.writeFileSync(this.metaPath, JSON.stringify(this._meta, null, 2), 'utf8');
        } catch (e) {
            console.warn(`⚠️ [ToolVectorIndex] 無法儲存 meta: ${e.message}`);
        }
    }

    // ── 清除 ──────────────────────────────────────────────────────────────────

    async clear() {
        try {
            if (this._table) {
                await this._db.dropTable('tools');
                this._table = null;
            }
            this._meta = { version: SCHEMA_VERSION, hashes: {} };
            this._saveMeta();
            this._initPromise = null;
            console.log(`🗑️ [ToolVectorIndex] 索引已清除`);
        } catch (e) {
            console.warn(`⚠️ [ToolVectorIndex] 清除失敗: ${e.message}`);
        }
    }
}

module.exports = ToolVectorIndex;
