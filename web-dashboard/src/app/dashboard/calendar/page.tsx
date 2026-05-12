"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays, ChevronLeft, ChevronRight, Download, ExternalLink,
  Loader2, Plus, RefreshCcw, Settings, Trash2, Upload, X, Check,
  AlertCircle, LogOut
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { apiGet, apiPostWrite, apiWrite } from "@/lib/api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

type Owner = "user" | "golem";
type ViewMode = "month" | "week" | "day";

type CalendarEvent = {
  id: string;
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  owner: Owner;
  participants?: string[];
  editableBy?: { user: boolean; golem: boolean };
  source?: string;
  sourceId?: string;
  allDay?: boolean;
};

type CalendarSettings = {
  timezone: string;
  google: {
    enabled: boolean;
    apiKey: string;
    calendarId: string;
    syncDirection: string;
    lastSyncAt?: string | null;
    lastSyncStatus?: string | null;
    lastSyncMessage?: string;
  };
  apple: {
    enabled: boolean;
    mode: "daily" | "interval";
    dailyTimes: string[];
    intervalMinutes: number;
    daysBefore: number;
    daysAfter: number;
    timeoutSec: number;
    nextSyncAt?: string | null;
    lastSyncAt?: string | null;
    lastSyncStatus?: string | null;
    lastSyncMessage?: string;
  };
};

type OAuthStatus = {
  configured: boolean;
  authorized: boolean;
  expiresAt: number | null;
  scope: string | null;
};

const DEFAULT_FORM = {
  title: "",
  description: "",
  location: "",
  start: "",
  end: "",
  owner: "user" as Owner,
  allDay: false,
};

const OWNER_COLORS: Record<Owner, string> = {
  user: "bg-blue-500/80 border-blue-400 text-white",
  golem: "bg-violet-500/80 border-violet-400 text-white",
};

const OWNER_COLORS_LIGHT: Record<Owner, string> = {
  user: "bg-blue-500/15 border-blue-400/40 text-blue-300",
  golem: "bg-violet-500/15 border-violet-400/40 text-violet-300",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toLocalInputValue(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function normalizeOwnerValue(owner: unknown): Owner {
  return String(owner || "").toLowerCase() === "golem" ? "golem" : "user";
}

function normalizeEventForUI(event: CalendarEvent): CalendarEvent {
  return {
    ...event,
    owner: normalizeOwnerValue(event.owner),
    start: typeof event.start === "string" ? event.start : "",
    end: typeof event.end === "string" ? event.end : "",
    editableBy: {
      user: event.editableBy?.user !== false,
      golem: event.editableBy?.golem !== false,
    },
  };
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDateHeader(date: Date, view: ViewMode) {
  if (view === "month") {
    return date.toLocaleDateString("zh-TW", { year: "numeric", month: "long" });
  }
  if (view === "week") {
    const end = new Date(date);
    end.setDate(end.getDate() + 6);
    return `${date.toLocaleDateString("zh-TW", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("zh-TW", { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return date.toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
}

function getEventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  return events.filter((e) => {
    const s = new Date(e.start);
    const en = new Date(e.end);
    const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);
    return s <= dayEnd && en >= dayStart;
  }).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

// ─── Event Chip ───────────────────────────────────────────────────────────────

function EventChip({
  event,
  compact = false,
  onEdit,
  onDelete,
  onDragStart,
}: {
  event: CalendarEvent;
  compact?: boolean;
  onEdit: (e: CalendarEvent) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: React.DragEvent, event: CalendarEvent) => void;
}) {
  const colorClass = compact ? OWNER_COLORS_LIGHT[event.owner] : OWNER_COLORS[event.owner];
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, event)}
      onClick={(e) => { e.stopPropagation(); onEdit(event); }}
      className={`group relative rounded border px-1.5 py-0.5 text-xs cursor-pointer select-none truncate transition-opacity hover:opacity-90 ${colorClass}`}
      title={`${event.title}\n${formatTime(event.start)} – ${formatTime(event.end)}`}
    >
      <span className="font-medium truncate">{compact ? event.title : `${formatTime(event.start)} ${event.title}`}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(event.id); }}
        className="absolute right-0.5 top-0.5 hidden group-hover:flex items-center justify-center w-4 h-4 rounded bg-black/30 hover:bg-black/50 z-10"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

// ─── Month View ───────────────────────────────────────────────────────────────

function MonthView({
  currentDate,
  events,
  onEdit,
  onDelete,
  onDayClick,
  onDrop,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  onEdit: (e: CalendarEvent) => void;
  onDelete: (id: string) => void;
  onDayClick: (day: Date) => void;
  onDrop: (eventId: string, targetDay: Date) => void;
}) {
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const today = new Date();

  const firstDay = startOfMonth(currentDate);
  const startDay = startOfWeek(firstDay);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDay);
    d.setDate(startDay.getDate() + i);
    days.push(d);
  }

  const handleDragStart = (e: React.DragEvent, event: CalendarEvent) => {
    e.dataTransfer.setData("eventId", event.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDrop = (e: React.DragEvent, day: Date) => {
    e.preventDefault();
    const eventId = e.dataTransfer.getData("eventId");
    if (eventId) onDrop(eventId, day);
    setDragOverDay(null);
  };

  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <div className="flex flex-col h-full">
      <div className="grid grid-cols-7 border-b border-border">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-2 text-center text-xs font-semibold text-muted-foreground">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 flex-1 min-h-0">
        {days.map((day, i) => {
          const isCurrentMonth = day.getMonth() === currentDate.getMonth();
          const isToday = isSameDay(day, today);
          const dayKey = day.toISOString().slice(0, 10);
          const isDragOver = dragOverDay === dayKey;
          const dayEvents = getEventsForDay(events, day);

          return (
            <div
              key={i}
              className={`border-b border-r border-border/50 p-1 min-h-[90px] flex flex-col gap-0.5 transition-colors cursor-pointer
                ${!isCurrentMonth ? "bg-secondary/10" : "bg-background hover:bg-secondary/20"}
                ${isDragOver ? "bg-primary/10 border-primary/40" : ""}
              `}
              onClick={() => onDayClick(day)}
              onDragOver={(e) => { e.preventDefault(); setDragOverDay(dayKey); }}
              onDragLeave={() => setDragOverDay(null)}
              onDrop={(e) => handleDrop(e, day)}
            >
              <div className={`text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full mb-0.5
                ${isToday ? "bg-primary text-primary-foreground" : isCurrentMonth ? "text-foreground" : "text-muted-foreground/50"}
              `}>
                {day.getDate()}
              </div>
              {dayEvents.slice(0, 3).map((event) => (
                <EventChip key={event.id} event={event} compact onEdit={onEdit} onDelete={onDelete} onDragStart={handleDragStart} />
              ))}
              {dayEvents.length > 3 && (
                <span className="text-[10px] text-muted-foreground pl-1">+{dayEvents.length - 3} 更多</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Week View ────────────────────────────────────────────────────────────────

function WeekView({
  currentDate,
  events,
  onEdit,
  onDelete,
  onDrop,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  onEdit: (e: CalendarEvent) => void;
  onDelete: (id: string) => void;
  onDrop: (eventId: string, targetDay: Date, hour: number) => void;
}) {
  const [dragOver, setDragOver] = useState<string | null>(null);
  const today = new Date();
  const weekStart = startOfWeek(currentDate);
  const days: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const WEEKDAYS_SHORT = ["日", "一", "二", "三", "四", "五", "六"];

  const handleDragStart = (e: React.DragEvent, event: CalendarEvent) => {
    e.dataTransfer.setData("eventId", event.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDrop = (e: React.DragEvent, day: Date, hour: number) => {
    e.preventDefault();
    const eventId = e.dataTransfer.getData("eventId");
    if (eventId) onDrop(eventId, day, hour);
    setDragOver(null);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="grid border-b border-border" style={{ gridTemplateColumns: "48px repeat(7, 1fr)" }}>
        <div className="py-2" />
        {days.map((day, i) => {
          const isToday = isSameDay(day, today);
          return (
            <div key={i} className="py-2 text-center border-l border-border/50">
              <div className="text-xs text-muted-foreground">{WEEKDAYS_SHORT[day.getDay()]}</div>
              <div className={`text-sm font-semibold mx-auto w-7 h-7 flex items-center justify-center rounded-full
                ${isToday ? "bg-primary text-primary-foreground" : "text-foreground"}`}>
                {day.getDate()}
              </div>
            </div>
          );
        })}
      </div>
      {/* Time grid */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: "48px repeat(7, 1fr)" }}>
          {hours.map((hour) => (
            <>
              <div key={`h-${hour}`} className="text-[10px] text-muted-foreground text-right pr-2 pt-0.5 h-14 border-b border-border/30">
                {hour === 0 ? "" : `${String(hour).padStart(2, "0")}:00`}
              </div>
              {days.map((day, di) => {
                const cellKey = `${day.toISOString().slice(0, 10)}-${hour}`;
                const isDragOver = dragOver === cellKey;
                const cellEvents = events.filter((e) => {
                  const s = new Date(e.start);
                  return isSameDay(s, day) && s.getHours() === hour;
                });
                return (
                  <div
                    key={`${di}-${hour}`}
                    className={`h-14 border-b border-l border-border/30 relative p-0.5 transition-colors
                      ${isDragOver ? "bg-primary/10" : "hover:bg-secondary/20"}`}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(cellKey); }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => handleDrop(e, day, hour)}
                  >
                    {cellEvents.map((event) => (
                      <EventChip key={event.id} event={event} onEdit={onEdit} onDelete={onDelete} onDragStart={handleDragStart} />
                    ))}
                  </div>
                );
              })}
            </>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Day View ─────────────────────────────────────────────────────────────────

function DayView({
  currentDate,
  events,
  onEdit,
  onDelete,
  onDrop,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  onEdit: (e: CalendarEvent) => void;
  onDelete: (id: string) => void;
  onDrop: (eventId: string, targetDay: Date, hour: number) => void;
}) {
  const [dragOver, setDragOver] = useState<number | null>(null);
  const hours = Array.from({ length: 24 }, (_, i) => i);

  const handleDragStart = (e: React.DragEvent, event: CalendarEvent) => {
    e.dataTransfer.setData("eventId", event.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDrop = (e: React.DragEvent, hour: number) => {
    e.preventDefault();
    const eventId = e.dataTransfer.getData("eventId");
    if (eventId) onDrop(eventId, currentDate, hour);
    setDragOver(null);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {hours.map((hour) => {
        const isDragOver = dragOver === hour;
        const hourEvents = events.filter((e) => {
          const s = new Date(e.start);
          return isSameDay(s, currentDate) && s.getHours() === hour;
        });
        return (
          <div
            key={hour}
            className={`flex gap-2 min-h-[56px] border-b border-border/30 transition-colors
              ${isDragOver ? "bg-primary/10" : "hover:bg-secondary/10"}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(hour); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => handleDrop(e, hour)}
          >
            <div className="w-12 text-[11px] text-muted-foreground text-right pr-2 pt-1 shrink-0">
              {hour === 0 ? "" : `${String(hour).padStart(2, "0")}:00`}
            </div>
            <div className="flex-1 py-0.5 flex flex-col gap-0.5">
              {hourEvents.map((event) => (
                <EventChip key={event.id} event={event} onEdit={onEdit} onDelete={onDelete} onDragStart={handleDragStart} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Event Modal ──────────────────────────────────────────────────────────────

function EventModal({
  form,
  editingId,
  isSaving,
  onClose,
  onSubmit,
  onChange,
}: {
  form: typeof DEFAULT_FORM;
  editingId: string | null;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onChange: (patch: Partial<typeof DEFAULT_FORM>) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{editingId ? "編輯事件" : "新增事件"}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary/60 text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <input
            className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
            placeholder="標題 *"
            value={form.title}
            onChange={(e) => onChange({ title: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">開始時間 *</label>
              <input
                type="datetime-local"
                className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
                value={form.start}
                onChange={(e) => onChange({ start: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">結束時間 *</label>
              <input
                type="datetime-local"
                className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
                value={form.end}
                onChange={(e) => onChange({ end: e.target.value })}
              />
            </div>
          </div>
          <input
            className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
            placeholder="地點"
            value={form.location}
            onChange={(e) => onChange({ location: e.target.value })}
          />
          <textarea
            className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary resize-none"
            placeholder="描述"
            rows={2}
            value={form.description}
            onChange={(e) => onChange({ description: e.target.value })}
          />
          <div className="flex items-center gap-4">
            <select
              className="flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
              value={form.owner}
              onChange={(e) => onChange({ owner: e.target.value as Owner })}
            >
              <option value="user">使用者排程</option>
              <option value="golem">Golem 排程</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={form.allDay}
                onChange={(e) => onChange({ allDay: e.target.checked })}
                className="rounded"
              />
              全天
            </label>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <Button onClick={onSubmit} disabled={isSaving} className="flex-1">
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {editingId ? "更新" : "新增"}
          </Button>
          <Button variant="outline" onClick={onClose}>取消</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function SettingsPanel({
  settings,
  oauthStatus,
  isSaving,
  importPayload,
  onSettingsChange,
  onSaveSettings,
  onSyncGoogle,
  onSyncApple,
  onPushAll,
  onOAuthAuthorize,
  onOAuthRevoke,
  onImportPayloadChange,
  onImport,
  onExport,
  onClose,
}: {
  settings: CalendarSettings | null;
  oauthStatus: OAuthStatus | null;
  isSaving: boolean;
  importPayload: string;
  onSettingsChange: (patch: Partial<CalendarSettings>) => void;
  onSaveSettings: () => void;
  onSyncGoogle: () => void;
  onSyncApple: () => void;
  onPushAll: () => void;
  onOAuthAuthorize: () => void;
  onOAuthRevoke: () => void;
  onImportPayloadChange: (v: string) => void;
  onImport: (format: "json" | "ics") => void;
  onExport: (format: "json" | "ics") => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">日曆設定</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary/60 text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Google OAuth */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Google Calendar 雙向同步</h3>
          {oauthStatus && !oauthStatus.configured && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>尚未設定 <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code>。請參考 <code>.env.example</code> 完成設定後重啟。</span>
            </div>
          )}
          {oauthStatus?.configured && (
            <div className="space-y-2">
              {oauthStatus.authorized ? (
                <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                  <div className="flex items-center gap-2 text-xs text-emerald-300">
                    <Check className="w-4 h-4" />
                    <span>已授權 Google Calendar</span>
                  </div>
                  <Button size="sm" variant="outline" onClick={onOAuthRevoke} disabled={isSaving}>
                    <LogOut className="w-3.5 h-3.5" /> 撤銷
                  </Button>
                </div>
              ) : (
                <Button onClick={onOAuthAuthorize} disabled={isSaving} className="w-full">
                  <ExternalLink className="w-4 h-4" /> 授權 Google Calendar
                </Button>
              )}
              {oauthStatus.authorized && (
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" onClick={onSyncGoogle} disabled={isSaving}>
                    <RefreshCcw className="w-4 h-4" /> 從 Google 拉取
                  </Button>
                  <Button variant="secondary" onClick={onPushAll} disabled={isSaving}>
                    <Upload className="w-4 h-4" /> 推送到 Google
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Google API Key (fallback) */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">API Key（公開日曆唯讀）</h3>
          <input
            className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
            placeholder="Google API Key"
            value={settings?.google.apiKey || ""}
            onChange={(e) => onSettingsChange({ google: { ...settings!.google, apiKey: e.target.value } })}
          />
          <input
            className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
            placeholder="Calendar ID（預設 primary）"
            value={settings?.google.calendarId || ""}
            onChange={(e) => onSettingsChange({ google: { ...settings!.google, calendarId: e.target.value } })}
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={!!settings?.google.enabled}
                onChange={(e) => onSettingsChange({ google: { ...settings!.google, enabled: e.target.checked } })}
              />
              啟用 Google 同步
            </label>
            {!oauthStatus?.authorized && (
              <Button size="sm" variant="secondary" onClick={onSyncGoogle} disabled={isSaving}>
                <RefreshCcw className="w-3.5 h-3.5" /> 同步
              </Button>
            )}
          </div>
          {settings?.google.lastSyncMessage && (
            <p className="text-xs text-muted-foreground">{settings.google.lastSyncMessage}</p>
          )}
          <Button onClick={onSaveSettings} disabled={isSaving || !settings} size="sm">
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            儲存設定
          </Button>
        </section>

        {/* Apple */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Apple Calendar（macOS）</h3>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={!!settings?.apple?.enabled}
              onChange={(e) => onSettingsChange({ apple: { ...settings!.apple, enabled: e.target.checked } })}
            />
            啟用 Apple 自動同步
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={(settings?.apple?.mode || "daily") === "daily"}
                onChange={() => onSettingsChange({ apple: { ...settings!.apple, mode: "daily" } })}
              />
              每日定時
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={settings?.apple?.mode === "interval"}
                onChange={() => onSettingsChange({ apple: { ...settings!.apple, mode: "interval" } })}
              />
              固定頻率
            </label>
          </div>
          {(settings?.apple?.mode || "daily") === "daily" ? (
            <input
              className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
              placeholder="每日時間（例如 09:00,18:30）"
              value={(settings?.apple?.dailyTimes || ["09:00"]).join(",")}
              onChange={(e) => onSettingsChange({
                apple: {
                  ...settings!.apple,
                  dailyTimes: e.target.value.split(",").map((v) => v.trim()).filter(Boolean),
                },
              })}
            />
          ) : (
            <input
              type="number"
              min={15}
              max={1440}
              className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
              placeholder="每幾分鐘同步一次"
              value={settings?.apple?.intervalMinutes ?? 120}
              onChange={(e) => onSettingsChange({
                apple: { ...settings!.apple, intervalMinutes: Number(e.target.value || 120) },
              })}
            />
          )}
          <div className="grid grid-cols-3 gap-2">
            <input
              type="number"
              min={0}
              max={365}
              className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
              placeholder="往前天數"
              value={settings?.apple?.daysBefore ?? 30}
              onChange={(e) => onSettingsChange({ apple: { ...settings!.apple, daysBefore: Number(e.target.value || 30) } })}
            />
            <input
              type="number"
              min={1}
              max={365}
              className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
              placeholder="往後天數"
              value={settings?.apple?.daysAfter ?? 180}
              onChange={(e) => onSettingsChange({ apple: { ...settings!.apple, daysAfter: Number(e.target.value || 180) } })}
            />
            <input
              type="number"
              min={10}
              max={300}
              className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm focus:outline-none focus:border-primary"
              placeholder="逾時秒數"
              value={settings?.apple?.timeoutSec ?? 60}
              onChange={(e) => onSettingsChange({ apple: { ...settings!.apple, timeoutSec: Number(e.target.value || 60) } })}
            />
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            {settings?.apple?.lastSyncAt && <p>上次同步：{new Date(settings.apple.lastSyncAt).toLocaleString("zh-TW")}</p>}
            {settings?.apple?.nextSyncAt && <p>下次同步：{new Date(settings.apple.nextSyncAt).toLocaleString("zh-TW")}</p>}
            {settings?.apple?.lastSyncMessage && <p>狀態：{settings.apple.lastSyncMessage}</p>}
          </div>
          <Button variant="secondary" onClick={onSyncApple} disabled={isSaving} className="w-full">
            <RefreshCcw className="w-4 h-4" /> 立即同步 Apple Calendar
          </Button>
        </section>

        {/* Import / Export */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">匯入 / 匯出</h3>
          <textarea
            className="w-full rounded-lg border border-border bg-secondary/30 p-3 text-xs font-mono min-h-[80px] focus:outline-none focus:border-primary"
            placeholder="貼上 JSON 或 ICS 內容"
            value={importPayload}
            onChange={(e) => onImportPayloadChange(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => onImport("json")} disabled={isSaving || !importPayload.trim()} size="sm">
              <Upload className="w-3.5 h-3.5" /> 匯入 JSON
            </Button>
            <Button variant="secondary" onClick={() => onImport("ics")} disabled={isSaving || !importPayload.trim()} size="sm">
              <Upload className="w-3.5 h-3.5" /> 匯入 ICS
            </Button>
            <Button variant="outline" onClick={() => onExport("json")} size="sm">
              <Download className="w-3.5 h-3.5" /> 匯出 JSON
            </Button>
            <Button variant="outline" onClick={() => onExport("ics")} size="sm">
              <Download className="w-3.5 h-3.5" /> 匯出 ICS
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const toast = useToast();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [settings, setSettings] = useState<CalendarSettings | null>(null);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [currentDate, setCurrentDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [showModal, setShowModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [importPayload, setImportPayload] = useState("");

  // Check for OAuth callback result in URL
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth_success")) {
      toast.success("Google 授權成功", "已完成 Google Calendar 授權，現在可以雙向同步。");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("oauth_error")) {
      toast.error("Google 授權失敗", decodeURIComponent(params.get("oauth_error") || ""));
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [toast]);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [eventsData, settingsData, oauthData] = await Promise.all([
        apiGet<{ events?: CalendarEvent[] }>("/api/calendar/events"),
        apiGet<{ settings: CalendarSettings }>("/api/calendar/settings"),
        apiGet<OAuthStatus>("/api/calendar/google/oauth/status").catch(() => null),
      ]);
      setEvents((eventsData.events || []).map(normalizeEventForUI));
      setSettings(settingsData.settings);
      if (oauthData) setOauthStatus(oauthData);
    } catch (error) {
      toast.error("讀取協作日曆失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // Navigation
  const navigate = useCallback((dir: -1 | 1) => {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      if (viewMode === "month") d.setMonth(d.getMonth() + dir);
      else if (viewMode === "week") d.setDate(d.getDate() + dir * 7);
      else d.setDate(d.getDate() + dir);
      return d;
    });
  }, [viewMode]);

  const goToday = useCallback(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setCurrentDate(d);
  }, []);

  // Event CRUD
  const openNewEvent = useCallback((day?: Date, hour?: number) => {
    const base = day ? new Date(day) : new Date();
    if (hour !== undefined) base.setHours(hour, 0, 0, 0);
    const end = new Date(base);
    end.setHours(end.getHours() + 1);
    const offset = base.getTimezoneOffset() * 60000;
    setForm({
      ...DEFAULT_FORM,
      start: new Date(base.getTime() - offset).toISOString().slice(0, 16),
      end: new Date(end.getTime() - offset).toISOString().slice(0, 16),
    });
    setEditingId(null);
    setShowModal(true);
  }, []);

  const openEditEvent = useCallback((event: CalendarEvent) => {
    const normalized = normalizeEventForUI(event);
    setEditingId(normalized.id);
    setForm({
      title: normalized.title,
      description: normalized.description || "",
      location: normalized.location || "",
      start: toLocalInputValue(normalized.start),
      end: toLocalInputValue(normalized.end),
      owner: normalized.owner,
      allDay: normalized.allDay || false,
    });
    setShowModal(true);
  }, []);

  const submitEvent = useCallback(async () => {
    if (!form.title.trim() || !form.start || !form.end) {
      toast.error("缺少欄位", "請填寫標題、開始時間與結束時間。");
      return;
    }
    try {
      setIsSaving(true);
      const payload = {
        title: form.title,
        description: form.description,
        location: form.location,
        start: new Date(form.start).toISOString(),
        end: new Date(form.end).toISOString(),
        owner: form.owner,
        allDay: form.allDay,
        editableBy: { user: true, golem: true },
      };
      if (editingId) {
        await apiWrite(`/api/calendar/events/${encodeURIComponent(editingId)}`, { method: "PUT", body: payload });
        toast.success("已更新事件");
      } else {
        await apiPostWrite("/api/calendar/events", payload);
        toast.success("已新增事件");
      }
      setShowModal(false);
      setForm(DEFAULT_FORM);
      setEditingId(null);
      await load();
    } catch (error) {
      toast.error("儲存失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [editingId, form, load, toast]);

  const deleteEvent = useCallback(async (id: string) => {
    try {
      await apiWrite(`/api/calendar/events/${encodeURIComponent(id)}`, { method: "DELETE" });
      setEvents((prev) => prev.filter((e) => e.id !== id));
      toast.success("已刪除事件");
    } catch (error) {
      toast.error("刪除失敗", error instanceof Error ? error.message : String(error));
    }
  }, [toast]);

  // Drag & drop — move event to new day/hour
  const handleDrop = useCallback(async (eventId: string, targetDay: Date, hour?: number) => {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    const origStart = new Date(event.start);
    const origEnd = new Date(event.end);
    const duration = origEnd.getTime() - origStart.getTime();

    const newStart = new Date(targetDay);
    newStart.setHours(hour !== undefined ? hour : origStart.getHours(), origStart.getMinutes(), 0, 0);
    const newEnd = new Date(newStart.getTime() + duration);

    // Optimistic update
    setEvents((prev) => prev.map((e) => e.id === eventId
      ? { ...e, start: newStart.toISOString(), end: newEnd.toISOString() }
      : e
    ));

    try {
      await apiWrite(`/api/calendar/events/${encodeURIComponent(eventId)}`, {
        method: "PUT",
        body: { start: newStart.toISOString(), end: newEnd.toISOString() },
      });
    } catch (error) {
      toast.error("移動失敗", error instanceof Error ? error.message : String(error));
      await load(); // revert
    }
  }, [events, load, toast]);

  // Google OAuth
  const handleOAuthAuthorize = useCallback(async () => {
    try {
      const data = await apiGet<{ url: string }>("/api/calendar/google/oauth/url");
      window.location.href = data.url;
    } catch (error) {
      toast.error("無法取得授權連結", error instanceof Error ? error.message : String(error));
    }
  }, [toast]);

  const handleOAuthRevoke = useCallback(async () => {
    try {
      setIsSaving(true);
      await apiPostWrite("/api/calendar/google/oauth/revoke", {});
      setOauthStatus((prev) => prev ? { ...prev, authorized: false } : prev);
      toast.success("已撤銷 Google 授權");
    } catch (error) {
      toast.error("撤銷失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [toast]);

  const syncGoogle = useCallback(async () => {
    try {
      setIsSaving(true);
      const result = await apiPostWrite<{ importedFromGoogle?: number }>("/api/calendar/google/sync", {});
      await load();
      toast.success("Google 同步完成", `已匯入 ${result.importedFromGoogle ?? 0} 個事件。`);
    } catch (error) {
      toast.error("Google 同步失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [load, toast]);

  const pushAllToGoogle = useCallback(async () => {
    try {
      setIsSaving(true);
      const result = await apiPostWrite<{ pushed?: number; failed?: number }>("/api/calendar/google/push-all", {});
      toast.success("推送完成", `成功 ${result.pushed ?? 0} 個，失敗 ${result.failed ?? 0} 個。`);
    } catch (error) {
      toast.error("推送失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [toast]);

  const syncApple = useCallback(async () => {
    try {
      setIsSaving(true);
      await apiPostWrite("/api/calendar/apple/sync", {
        daysBefore: settings?.apple?.daysBefore ?? 30,
        daysAfter: settings?.apple?.daysAfter ?? 180,
        timeoutMs: (settings?.apple?.timeoutSec ?? 60) * 1000,
      });
      await load();
      toast.success("Apple 行事曆同步完成");
    } catch (error) {
      toast.error("Apple 同步失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [load, settings, toast]);

  const saveSettings = useCallback(async () => {
    if (!settings) return;
    try {
      setIsSaving(true);
      await apiWrite("/api/calendar/settings", { method: "PUT", body: settings });
      toast.success("設定已儲存");
      await load();
    } catch (error) {
      toast.error("儲存設定失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [load, settings, toast]);

  const runImport = useCallback(async (format: "json" | "ics") => {
    try {
      setIsSaving(true);
      const payload = format === "json" ? JSON.parse(importPayload) : importPayload;
      await apiPostWrite("/api/calendar/import", { format, payload });
      setImportPayload("");
      await load();
      toast.success("匯入完成");
    } catch (error) {
      toast.error("匯入失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [importPayload, load, toast]);

  const exportData = useCallback((format: "json" | "ics") => {
    window.open(`/api/calendar/export?format=${format}`, "_blank");
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0 flex-wrap">
        <div className="flex items-center gap-2 mr-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
            <CalendarDays className="h-5 w-5 text-primary" />
          </div>
          <span className="font-semibold text-base hidden sm:block">協作日曆</span>
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={() => navigate(-1)}><ChevronLeft className="w-4 h-4" /></Button>
          <Button size="sm" variant="ghost" onClick={goToday} className="text-xs px-2">今天</Button>
          <Button size="icon" variant="ghost" onClick={() => navigate(1)}><ChevronRight className="w-4 h-4" /></Button>
        </div>

        <span className="text-sm font-medium text-muted-foreground min-w-[160px]">
          {formatDateHeader(currentDate, viewMode)}
        </span>

        <div className="flex-1" />

        {/* View switcher */}
        <div className="flex rounded-lg border border-border overflow-hidden">
          {(["month", "week", "day"] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors
                ${viewMode === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/60"}`}
            >
              {v === "month" ? "月" : v === "week" ? "週" : "日"}
            </button>
          ))}
        </div>

        <Button size="sm" onClick={() => openNewEvent(currentDate)}>
          <Plus className="w-4 h-4" /> 新增
        </Button>
        <Button size="icon" variant="ghost" onClick={load} disabled={isLoading}>
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => setShowSettings(true)}>
          <Settings className="w-4 h-4" />
        </Button>
      </div>

      {/* Calendar body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {viewMode === "month" && (
          <MonthView
            currentDate={currentDate}
            events={events}
            onEdit={openEditEvent}
            onDelete={deleteEvent}
            onDayClick={(day) => openNewEvent(day)}
            onDrop={(id, day) => handleDrop(id, day)}
          />
        )}
        {viewMode === "week" && (
          <WeekView
            currentDate={currentDate}
            events={events}
            onEdit={openEditEvent}
            onDelete={deleteEvent}
            onDrop={(id, day, hour) => handleDrop(id, day, hour)}
          />
        )}
        {viewMode === "day" && (
          <DayView
            currentDate={currentDate}
            events={events}
            onEdit={openEditEvent}
            onDelete={deleteEvent}
            onDrop={(id, day, hour) => handleDrop(id, day, hour)}
          />
        )}
      </div>

      {/* Modals */}
      {showModal && (
        <EventModal
          form={form}
          editingId={editingId}
          isSaving={isSaving}
          onClose={() => { setShowModal(false); setEditingId(null); setForm(DEFAULT_FORM); }}
          onSubmit={submitEvent}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        />
      )}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          oauthStatus={oauthStatus}
          isSaving={isSaving}
          importPayload={importPayload}
          onSettingsChange={(patch) => setSettings((prev) => prev ? { ...prev, ...patch } : prev)}
          onSaveSettings={saveSettings}
          onSyncGoogle={syncGoogle}
          onSyncApple={syncApple}
          onPushAll={pushAllToGoogle}
          onOAuthAuthorize={handleOAuthAuthorize}
          onOAuthRevoke={handleOAuthRevoke}
          onImportPayloadChange={setImportPayload}
          onImport={runImport}
          onExport={exportData}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
