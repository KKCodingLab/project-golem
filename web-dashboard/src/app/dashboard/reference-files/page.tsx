"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    ArrowUp,
    CheckCircle2,
    Database,
    FileText,
    FolderOpen,
    HardDrive,
    Loader2,
    RefreshCcw,
    Search,
    Trash2,
    XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { apiGet, apiPostWrite, apiWrite } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type BrowseEntry = {
    name: string;
    path: string;
    type: "directory" | "file";
    supported: boolean;
    size?: number;
    mtimeMs?: number;
};

type BrowseResponse = {
    currentPath: string;
    parentPath: string | null;
    entries: BrowseEntry[];
    roots?: { label: string; path: string }[];
};

type ReferenceFile = {
    id: string;
    name: string;
    path: string;
    description?: string;
    tags?: string[];
    enabled?: boolean;
    status: "pending" | "ready" | "failed";
    error?: string | null;
    ext?: string;
    size?: number;
    mtimeMs?: number;
    indexedAt?: string;
    chunkCount?: number;
};

type SearchResult = {
    id: string;
    fileId: string;
    name: string;
    path: string;
    text: string;
    score: number;
    chunkIndex: number;
};

function formatSize(size?: number) {
    if (!size) return "0 B";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function statusStyle(status: ReferenceFile["status"]) {
    if (status === "ready") return "text-emerald-400 bg-emerald-500/10 border-emerald-500/25";
    if (status === "failed") return "text-red-300 bg-red-500/10 border-red-500/25";
    return "text-amber-300 bg-amber-500/10 border-amber-500/25";
}

export default function ReferenceFilesPage() {
    const toast = useToast();
    const [files, setFiles] = useState<ReferenceFile[]>([]);
    const [browser, setBrowser] = useState<BrowseResponse | null>(null);
    const [pathInput, setPathInput] = useState("");
    const [isBrowsing, setIsBrowsing] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);

    const loadFiles = useCallback(async () => {
        const data = await apiGet<{ files?: ReferenceFile[] }>("/api/reference-files");
        const nextFiles = data.files || [];
        setFiles(nextFiles);
        setSelectedIds((prev) => prev.filter((id) => nextFiles.some((file) => file.id === id)));
    }, []);

    useEffect(() => {
        loadFiles().catch((error) => toast.error("讀取參考文件失敗", error instanceof Error ? error.message : String(error)));
    }, [loadFiles, toast]);

    const browsePath = useCallback(async (targetPath?: string) => {
        try {
            setIsBrowsing(true);
            const queryString = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
            const data = await apiGet<BrowseResponse>(`/api/reference-files/browse${queryString}`);
            setBrowser(data);
            setPathInput(data.currentPath);
        } catch (error) {
            toast.error("瀏覽路徑失敗", error instanceof Error ? error.message : String(error));
        } finally {
            setIsBrowsing(false);
        }
    }, [toast]);

    const addPath = useCallback(async (targetPath?: string) => {
        const path = (targetPath || pathInput).trim();
        if (!path) {
            toast.error("缺少路徑", "請選擇或輸入檔案/資料夾路徑。");
            return;
        }
        try {
            setIsAdding(true);
            const data = await apiPostWrite<{ added?: ReferenceFile[]; skipped?: number }>("/api/reference-files", { path });
            await loadFiles();
            toast.success("參考資料已加入", `已自動索引 ${data.added?.length || 0} 個檔案。`);
        } catch (error) {
            toast.error("加入失敗", error instanceof Error ? error.message : String(error));
        } finally {
            setIsAdding(false);
        }
    }, [loadFiles, pathInput, toast]);

    const reindex = useCallback(async (id: string) => {
        try {
            setBusyId(id);
            await apiPostWrite(`/api/reference-files/${encodeURIComponent(id)}/reindex`, {});
            await loadFiles();
            toast.success("重新索引完成", "參考文件索引已更新。");
        } catch (error) {
            toast.error("重新索引失敗", error instanceof Error ? error.message : String(error));
        } finally {
            setBusyId(null);
        }
    }, [loadFiles, toast]);

    const removeFile = useCallback(async (id: string) => {
        try {
            setBusyId(id);
            await apiWrite(`/api/reference-files/${encodeURIComponent(id)}`, { method: "DELETE" });
            await loadFiles();
            toast.success("已移除參考文件", "索引片段也已清除。");
        } catch (error) {
            toast.error("移除失敗", error instanceof Error ? error.message : String(error));
        } finally {
            setBusyId(null);
        }
    }, [loadFiles, toast]);

    const removeSelected = useCallback(async () => {
        if (selectedIds.length === 0) return;
        try {
            setBusyId("__bulk__");
            await apiPostWrite("/api/reference-files/batch-delete", { ids: selectedIds });
            await loadFiles();
            setSelectedIds([]);
            toast.success("已批次移除參考文件", `已刪除 ${selectedIds.length} 個項目。`);
        } catch (error) {
            toast.error("批次移除失敗", error instanceof Error ? error.message : String(error));
        } finally {
            setBusyId(null);
        }
    }, [loadFiles, selectedIds, toast]);

    const runSearch = useCallback(async () => {
        if (!query.trim()) {
            setResults([]);
            return;
        }
        try {
            setIsSearching(true);
            const data = await apiGet<{ results?: SearchResult[] }>(`/api/reference-files/search?query=${encodeURIComponent(query)}&limit=6`);
            setResults(data.results || []);
        } catch (error) {
            toast.error("搜尋失敗", error instanceof Error ? error.message : String(error));
        } finally {
            setIsSearching(false);
        }
    }, [query, toast]);

    const stats = useMemo(() => {
        const ready = files.filter((file) => file.status === "ready").length;
        const failed = files.filter((file) => file.status === "failed").length;
        const chunks = files.reduce((sum, file) => sum + (file.chunkCount || 0), 0);
        return { ready, failed, chunks };
    }, [files]);

    const allSelected = files.length > 0 && selectedIds.length === files.length;

    return (
        <div className="h-full overflow-auto bg-background text-foreground">
            <div className="mx-auto max-w-7xl p-6 space-y-6">
                <div className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
                    <div className="flex items-center gap-4">
                        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
                            <Database className="h-7 w-7 text-primary" />
                        </div>
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight">代理人參考文件</h1>
                            <p className="mt-1 text-sm text-muted-foreground">
                                全域共用的參考資料索引。Golem 會自動搜尋，也能用 reference_files 指令主動調閱。
                            </p>
                        </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-lg border border-border bg-card px-3 py-2">
                            <div className="font-mono text-lg text-foreground">{files.length}</div>
                            <div className="text-muted-foreground">文件</div>
                        </div>
                        <div className="rounded-lg border border-border bg-card px-3 py-2">
                            <div className="font-mono text-lg text-emerald-400">{stats.ready}</div>
                            <div className="text-muted-foreground">已索引</div>
                        </div>
                        <div className="rounded-lg border border-border bg-card px-3 py-2">
                            <div className="font-mono text-lg text-primary">{stats.chunks}</div>
                            <div className="text-muted-foreground">片段</div>
                        </div>
                    </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.3fr)]">
                    <section className="space-y-4">
                        <div className="rounded-xl border border-border bg-card p-4">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2 text-sm font-semibold">
                                    <FolderOpen className="h-4 w-4 text-primary" />
                                    瀏覽並加入
                                </div>
                                <Button type="button" variant="secondary" onClick={() => browsePath(pathInput || undefined)} disabled={isBrowsing}>
                                    {isBrowsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                                </Button>
                            </div>
                            <div className="flex gap-2">
                                <input
                                    value={pathInput}
                                    onChange={(event) => setPathInput(event.target.value)}
                                    className="min-w-0 flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm font-mono outline-none focus:border-primary"
                                    placeholder="/Users/you/Documents"
                                />
                                <Button type="button" onClick={() => addPath()} disabled={isAdding || !pathInput.trim()}>
                                    {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : "加入"}
                                </Button>
                            </div>

                            {browser && (
                                <div className="mt-4 overflow-hidden rounded-xl border border-border/70 bg-secondary/20">
                                    <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
                                        <HardDrive className="h-3.5 w-3.5" />
                                        <span className="truncate font-mono">{browser.currentPath}</span>
                                    </div>
                                    <div className="flex flex-wrap gap-2 border-b border-border/70 p-3">
                                        {browser.roots?.map((root) => (
                                            <button key={root.path} type="button" onClick={() => browsePath(root.path)} className="rounded-lg border border-border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                                                {root.label}
                                            </button>
                                        ))}
                                        {browser.parentPath && (
                                            <button type="button" onClick={() => browsePath(browser.parentPath || undefined)} className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                                                <ArrowUp className="h-3 w-3" />
                                                上一層
                                            </button>
                                        )}
                                    </div>
                                    <div className="max-h-[28rem] overflow-auto p-2">
                                        {browser.entries.map((entry) => (
                                            <div key={entry.path} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-background/50">
                                                <button
                                                    type="button"
                                                    onClick={() => entry.type === "directory" ? browsePath(entry.path) : setPathInput(entry.path)}
                                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                                >
                                                    {entry.type === "directory" ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                                                    <span className={cn("truncate", !entry.supported && "text-muted-foreground")}>{entry.name}</span>
                                                </button>
                                                <span className="shrink-0 text-[10px] text-muted-foreground">{entry.type === "file" ? formatSize(entry.size) : ""}</span>
                                                <Button type="button" variant="secondary" className="h-7 px-2 text-xs" onClick={() => addPath(entry.path)} disabled={isAdding || !entry.supported}>
                                                    加入
                                                </Button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="rounded-xl border border-border bg-card p-4">
                            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                                <Search className="h-4 w-4 text-primary" />
                                測試索引搜尋
                            </div>
                            <div className="flex gap-2">
                                <input
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") runSearch();
                                    }}
                                    className="min-w-0 flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm outline-none focus:border-primary"
                                    placeholder="輸入問題或關鍵字"
                                />
                                <Button type="button" onClick={runSearch} disabled={isSearching}>
                                    {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                                </Button>
                            </div>
                            {results.length > 0 && (
                                <div className="mt-3 space-y-2">
                                    {results.map((result) => (
                                        <div key={result.id} className="rounded-lg border border-border/70 bg-secondary/25 p-3">
                                            <div className="mb-1 flex items-center justify-between gap-2">
                                                <span className="truncate text-sm font-medium">{result.name}</span>
                                                <span className="font-mono text-[10px] text-muted-foreground">{result.score.toFixed(2)}</span>
                                            </div>
                                            <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{result.text}</p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </section>

                    <section className="rounded-xl border border-border bg-card">
                        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                            <div className="text-sm font-semibold">已登記參考文件</div>
                            <div className="flex items-center gap-2">
                                <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        onChange={(event) => {
                                            if (event.target.checked) {
                                                setSelectedIds(files.map((file) => file.id));
                                            } else {
                                                setSelectedIds([]);
                                            }
                                        }}
                                    />
                                    全選
                                </label>
                                <Button type="button" variant="secondary" onClick={removeSelected} disabled={selectedIds.length === 0 || busyId === "__bulk__"} className="h-8 px-2 text-red-300 hover:text-red-200">
                                    {busyId === "__bulk__" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                </Button>
                                <Button type="button" variant="secondary" onClick={loadFiles}>
                                    <RefreshCcw className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                        <div className="divide-y divide-border/70">
                            {files.length === 0 ? (
                                <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                                    尚未加入參考文件。選擇檔案或資料夾後，系統會自動抽文字並建立索引。
                                </div>
                            ) : files.map((file) => (
                                <div key={file.id} className="p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedIds.includes(file.id)}
                                                    onChange={(event) => {
                                                        setSelectedIds((prev) => {
                                                            if (event.target.checked) return Array.from(new Set([...prev, file.id]));
                                                            return prev.filter((id) => id !== file.id);
                                                        });
                                                    }}
                                                />
                                                {file.status === "ready" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : file.status === "failed" ? <XCircle className="h-4 w-4 shrink-0 text-red-300" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-300" />}
                                                <h3 className="truncate text-sm font-semibold">{file.name}</h3>
                                            </div>
                                            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{file.path}</p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                            <Button type="button" variant="secondary" className="h-8 px-2" onClick={() => reindex(file.id)} disabled={busyId === file.id}>
                                                {busyId === file.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                                            </Button>
                                            <Button type="button" variant="secondary" className="h-8 px-2 text-red-300 hover:text-red-200" onClick={() => removeFile(file.id)} disabled={busyId === file.id}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                                        <span className={cn("rounded-full border px-2 py-0.5", statusStyle(file.status))}>{file.status}</span>
                                        <span className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-muted-foreground">{file.ext || "file"}</span>
                                        <span className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-muted-foreground">{formatSize(file.size)}</span>
                                        <span className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-muted-foreground">{file.chunkCount || 0} chunks</span>
                                        {file.indexedAt && <span className="text-muted-foreground">索引：{new Date(file.indexedAt).toLocaleString()}</span>}
                                    </div>
                                    {file.error && (
                                        <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                                            {file.error}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
