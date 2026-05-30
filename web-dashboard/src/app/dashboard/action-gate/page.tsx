"use client";

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { LogStream } from "@/components/LogStream";
import { socket } from "@/lib/socket";
import { useI18n } from "@/components/I18nProvider";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function parseNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

export default function ActionGatePage() {
    const { locale } = useI18n();
    const isEnglish = locale === "en";
    const [rejectCount, setRejectCount] = useState(0);
    const [lastReject, setLastReject] = useState("N/A");

    useEffect(() => {
        const applyPayload = (payload: unknown) => {
            if (!isRecord(payload)) return;
            const count = parseNumber(payload.actionGateRejections);
            if (count !== null) setRejectCount(count);
            if (typeof payload.lastActionGateReject === "string" && payload.lastActionGateReject.trim()) {
                setLastReject(payload.lastActionGateReject);
            }
        };

        socket.on("init", applyPayload);
        socket.on("state_update", applyPayload);
        socket.emit("request_logs");

        return () => {
            socket.off("init", applyPayload);
            socket.off("state_update", applyPayload);
        };
    }, []);

    return (
        <div className="p-6 h-full flex flex-col gap-6 overflow-hidden bg-background text-foreground/80">
            <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
                <div className="space-y-2">
                    <div className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-amber-300">
                        <ShieldAlert className="h-3.5 w-3.5" />
                        {isEnglish ? "Action Gate Monitor" : "Action Gate 監控"}
                    </div>
                    <h1 className="text-2xl font-semibold text-foreground">
                        {isEnglish ? "Rejected Action Events" : "被阻擋的 Action 事件"}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {isEnglish
                            ? "Only shows action validation rejects with payload summary and scene suggestions."
                            : "僅顯示 action 驗證阻擋事件，包含 payload 摘要與 scene 建議。"}
                    </p>
                </div>
                <div className="rounded-xl border border-border bg-card/70 px-4 py-3 min-w-[220px]">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        {isEnglish ? "Total Rejects" : "累計阻擋"}
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-amber-300">{rejectCount}</div>
                    <div className="mt-2 text-xs text-muted-foreground break-words">
                        {isEnglish ? "Latest:" : "最新："} {lastReject || "N/A"}
                    </div>
                </div>
            </div>

            <div className="enterprise-card border border-border rounded-2xl overflow-hidden flex-1 min-h-0">
                <div className="px-5 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-amber-300" />
                        <span className="text-[10px] font-black uppercase tracking-[0.24em] text-foreground">
                            {isEnglish ? "Action Gate Stream" : "Action Gate 串流"}
                        </span>
                    </div>
                </div>
                <div className="p-4 h-[calc(100%-2.6rem)]">
                    <LogStream className="h-full" types={["action_gate"]} showHeader={false} />
                </div>
            </div>
        </div>
    );
}

