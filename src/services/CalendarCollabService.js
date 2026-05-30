const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DATA_DIR = path.resolve(process.cwd(), 'data', 'dashboard');
const DATA_PATH = path.join(DATA_DIR, 'collab-calendar.json');
const DEFAULT_APPLE_SYNC_TIMEOUT_MS = 60000;
const IDLE_AUTO_SYNC_MS = 3 * 60 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let appleAutoSyncTimer = null;
let appleSyncInFlight = null;
let idleAutoSyncTimer = null;
let bidirectionalSyncInFlight = null;

const DEFAULT_STATE = {
  version: 1,
  updatedAt: null,
  settings: {
    timezone: 'Asia/Taipei',
    google: {
      enabled: false,
      apiKey: '',
      calendarId: 'primary',
      syncDirection: 'google_to_local',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncMessage: '',
    },
    apple: {
      enabled: false,
      calendarId: '',
      calendarName: '',
      mode: 'daily',
      dailyTimes: ['09:00'],
      intervalMinutes: 120,
      daysBefore: 30,
      daysAfter: 180,
      timeoutSec: 60,
      nextSyncAt: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncMessage: '',
    },
    syncControl: {
      autoSyncOnChange: true,
      idleAutoSyncEnabled: true,
      idleHours: 3,
      lastLocalMutationAt: null,
      lastIdleAutoSyncAt: null,
      lastBidirectionalSyncAt: null,
    },
  },
  events: [],
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function safeString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeOwner(owner) {
  const normalized = safeString(owner).toLowerCase();
  if (normalized === 'golem') return 'golem';
  return 'user';
}

function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function normalizeDailyTimes(rawTimes) {
  const arr = Array.isArray(rawTimes) ? rawTimes : [];
  const uniq = new Set();
  for (const raw of arr) {
    const text = safeString(raw);
    if (!/^\d{2}:\d{2}$/.test(text)) continue;
    const hh = Number(text.slice(0, 2));
    const mm = Number(text.slice(3, 5));
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) continue;
    uniq.add(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return Array.from(uniq).sort();
}

function makeId() {
  return `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function ensureStateShape(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    version: Number(state.version) || 1,
    updatedAt: state.updatedAt || null,
    settings: {
      timezone: safeString(state.settings?.timezone, 'Asia/Taipei'),
      google: {
        enabled: toBool(state.settings?.google?.enabled),
        apiKey: safeString(state.settings?.google?.apiKey),
        calendarId: safeString(state.settings?.google?.calendarId, 'primary'),
        syncDirection: safeString(state.settings?.google?.syncDirection, 'google_to_local') || 'google_to_local',
        lastSyncAt: state.settings?.google?.lastSyncAt || null,
        lastSyncStatus: state.settings?.google?.lastSyncStatus || null,
        lastSyncMessage: safeString(state.settings?.google?.lastSyncMessage),
      },
      apple: {
        enabled: toBool(state.settings?.apple?.enabled),
        calendarId: safeString(state.settings?.apple?.calendarId),
        calendarName: safeString(state.settings?.apple?.calendarName),
        mode: safeString(state.settings?.apple?.mode, 'daily') === 'interval' ? 'interval' : 'daily',
        dailyTimes: normalizeDailyTimes(state.settings?.apple?.dailyTimes).length
          ? normalizeDailyTimes(state.settings?.apple?.dailyTimes)
          : ['09:00'],
        intervalMinutes: Math.max(15, Math.min(1440, toInt(state.settings?.apple?.intervalMinutes, 120))),
        daysBefore: Math.max(0, Math.min(365, toInt(state.settings?.apple?.daysBefore, 30))),
        daysAfter: Math.max(1, Math.min(365, toInt(state.settings?.apple?.daysAfter, 180))),
        timeoutSec: Math.max(10, Math.min(300, toInt(state.settings?.apple?.timeoutSec, 60))),
        nextSyncAt: state.settings?.apple?.nextSyncAt || null,
        lastSyncAt: state.settings?.apple?.lastSyncAt || null,
        lastSyncStatus: state.settings?.apple?.lastSyncStatus || null,
        lastSyncMessage: safeString(state.settings?.apple?.lastSyncMessage),
      },
      syncControl: {
        autoSyncOnChange: state.settings?.syncControl?.autoSyncOnChange !== false,
        idleAutoSyncEnabled: state.settings?.syncControl?.idleAutoSyncEnabled !== false,
        idleHours: Math.max(1, Math.min(24, toInt(state.settings?.syncControl?.idleHours, 3))),
        lastLocalMutationAt: state.settings?.syncControl?.lastLocalMutationAt || null,
        lastIdleAutoSyncAt: state.settings?.syncControl?.lastIdleAutoSyncAt || null,
        lastBidirectionalSyncAt: state.settings?.syncControl?.lastBidirectionalSyncAt || null,
      },
    },
    events: Array.isArray(state.events) ? state.events : [],
  };
}

function loadState() {
  ensureDir();
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(DEFAULT_STATE, null, 2), 'utf8');
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    return ensureStateShape(raw);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState(state) {
  ensureDir();
  const next = ensureStateShape(state);
  next.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function normalizeEvent(input, existing = null) {
  const title = safeString(input?.title);
  const start = normalizeDate(input?.start);
  const end = normalizeDate(input?.end);
  if (!title) throw new Error('Event title is required.');
  if (!start || !end) throw new Error('Event start/end must be valid datetime.');
  if (new Date(start).getTime() >= new Date(end).getTime()) throw new Error('Event end time must be after start time.');

  // reminderMinutes: 提前幾分鐘提醒，0 = 準時，null = 不提醒
  const rawReminder = input?.reminderMinutes !== undefined ? input.reminderMinutes : existing?.reminderMinutes;
  const reminderMinutes = rawReminder === null || rawReminder === undefined
    ? 10  // 預設提前 10 分鐘
    : Math.max(0, Math.min(10080, Number(rawReminder) || 0));

  return {
    id: existing?.id || safeString(input?.id) || makeId(),
    title,
    description: safeString(input?.description),
    location: safeString(input?.location),
    start,
    end,
    owner: normalizeOwner(input?.owner || existing?.owner),
    participants: Array.isArray(input?.participants)
      ? input.participants.map((item) => safeString(item)).filter(Boolean).slice(0, 20)
      : (existing?.participants || []),
    editableBy: {
      user: input?.editableBy?.user !== undefined ? toBool(input.editableBy.user) : existing?.editableBy?.user !== false,
      golem: input?.editableBy?.golem !== undefined ? toBool(input.editableBy.golem) : existing?.editableBy?.golem !== false,
    },
    source: safeString(input?.source || existing?.source, 'local'),
    sourceId: safeString(input?.sourceId || existing?.sourceId),
    allDay: toBool(input?.allDay ?? existing?.allDay),
    reminderMinutes,
    lastRemindedAt: existing?.lastRemindedAt || null, // 防止重複觸發
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
}

/**
 * 掃描即將到期的事件，回傳需要觸發提醒的清單，並標記 lastRemindedAt 防止重複。
 * @returns {{ event, triggerType: 'reminder'|'start' }[]}
 */
function checkDueReminders() {
  const state = loadState();
  const now = Date.now();
  const due = [];
  let dirty = false;

  for (const event of state.events) {
    // 全天事件不觸發提醒
    if (event.allDay) continue;
    // reminderMinutes 為 null 表示使用者明確關閉提醒
    if (event.reminderMinutes === null) continue;

    const startMs = new Date(event.start).getTime();
    const reminderMs = startMs - (event.reminderMinutes || 0) * 60 * 1000;

    // 已過去超過 1 小時的事件不再提醒
    if (startMs < now - 60 * 60 * 1000) continue;

    // 防止重複：若已在本次提醒視窗內觸發過，跳過
    if (event.lastRemindedAt) {
      const lastMs = new Date(event.lastRemindedAt).getTime();
      // 同一個提醒視窗（2 分鐘內）不重複觸發
      if (now - lastMs < 2 * 60 * 1000) continue;
    }

    // 提醒時間到了（在 now 的前後 1 分鐘視窗內）
    const inReminderWindow = reminderMs <= now && now <= reminderMs + 60 * 1000;
    // 準時觸發（事件開始時間的前後 1 分鐘）
    const inStartWindow = startMs <= now && now <= startMs + 60 * 1000;

    if (inReminderWindow || inStartWindow) {
      due.push({
        event,
        triggerType: inStartWindow && event.reminderMinutes === 0 ? 'start' : 'reminder',
      });
      // 標記已提醒，防止下一分鐘重複觸發
      event.lastRemindedAt = new Date().toISOString();
      dirty = true;
    }
  }

  if (dirty) saveState(state);
  return due;
}

function listEvents({ start, end, owner } = {}) {
  const state = loadState();
  const startDate = start ? normalizeDate(start) : null;
  const endDate = end ? normalizeDate(end) : null;

  const events = state.events.filter((event) => {
    if (owner && normalizeOwner(owner) !== event.owner) return false;
    if (startDate && new Date(event.end).getTime() < new Date(startDate).getTime()) return false;
    if (endDate && new Date(event.start).getTime() > new Date(endDate).getTime()) return false;
    return true;
  }).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return { events, settings: state.settings, updatedAt: state.updatedAt };
}

function createEvent(payload) {
  const state = loadState();
  const event = normalizeEvent(payload);
  state.events.push(event);
  state.settings.syncControl.lastLocalMutationAt = new Date().toISOString();
  const saved = saveState(state);
  return { event, updatedAt: saved.updatedAt };
}

function updateEvent(id, payload) {
  const state = loadState();
  const index = state.events.findIndex((event) => event.id === id);
  if (index < 0) return null;
  const current = state.events[index];
  const event = normalizeEvent({ ...current, ...payload, id: current.id }, current);
  state.events[index] = event;
  state.settings.syncControl.lastLocalMutationAt = new Date().toISOString();
  const saved = saveState(state);
  return { event, updatedAt: saved.updatedAt };
}

function removeEvent(id) {
  const state = loadState();
  const initialLength = state.events.length;
  state.events = state.events.filter((event) => event.id !== id);
  if (state.events.length === initialLength) return false;
  state.settings.syncControl.lastLocalMutationAt = new Date().toISOString();
  saveState(state);
  return true;
}

function getSettings() {
  return loadState().settings;
}

function updateSettings(patch) {
  const state = loadState();
  if (patch?.timezone) state.settings.timezone = safeString(patch.timezone, state.settings.timezone);
  if (patch?.google && typeof patch.google === 'object') {
    const current = state.settings.google || {};
    state.settings.google = {
      ...current,
      enabled: patch.google.enabled !== undefined ? toBool(patch.google.enabled) : current.enabled,
      apiKey: patch.google.apiKey !== undefined ? safeString(patch.google.apiKey) : current.apiKey,
      calendarId: patch.google.calendarId !== undefined ? safeString(patch.google.calendarId, current.calendarId || 'primary') : current.calendarId,
      syncDirection: patch.google.syncDirection !== undefined ? safeString(patch.google.syncDirection, current.syncDirection || 'google_to_local') : current.syncDirection,
    };
  }
  if (patch?.apple && typeof patch.apple === 'object') {
    const current = state.settings.apple || {};
    const nextMode = safeString(patch.apple.mode, current.mode || 'daily') === 'interval' ? 'interval' : 'daily';
    const nextTimes = patch.apple.dailyTimes !== undefined
      ? normalizeDailyTimes(patch.apple.dailyTimes)
      : normalizeDailyTimes(current.dailyTimes);
    state.settings.apple = {
      ...current,
      enabled: patch.apple.enabled !== undefined ? toBool(patch.apple.enabled) : toBool(current.enabled),
      calendarId: patch.apple.calendarId !== undefined
        ? safeString(patch.apple.calendarId)
        : safeString(current.calendarId),
      calendarName: patch.apple.calendarName !== undefined
        ? safeString(patch.apple.calendarName)
        : safeString(current.calendarName),
      mode: nextMode,
      dailyTimes: nextTimes.length ? nextTimes : ['09:00'],
      intervalMinutes: patch.apple.intervalMinutes !== undefined
        ? Math.max(15, Math.min(1440, toInt(patch.apple.intervalMinutes, 120)))
        : Math.max(15, Math.min(1440, toInt(current.intervalMinutes, 120))),
      daysBefore: patch.apple.daysBefore !== undefined
        ? Math.max(0, Math.min(365, toInt(patch.apple.daysBefore, 30)))
        : Math.max(0, Math.min(365, toInt(current.daysBefore, 30))),
      daysAfter: patch.apple.daysAfter !== undefined
        ? Math.max(1, Math.min(365, toInt(patch.apple.daysAfter, 180)))
        : Math.max(1, Math.min(365, toInt(current.daysAfter, 180))),
      timeoutSec: patch.apple.timeoutSec !== undefined
        ? Math.max(10, Math.min(300, toInt(patch.apple.timeoutSec, 60)))
        : Math.max(10, Math.min(300, toInt(current.timeoutSec, 60))),
      nextSyncAt: current.nextSyncAt || null,
      lastSyncAt: current.lastSyncAt || null,
      lastSyncStatus: current.lastSyncStatus || null,
      lastSyncMessage: safeString(current.lastSyncMessage),
    };
  }
  if (patch?.syncControl && typeof patch.syncControl === 'object') {
    const current = state.settings.syncControl || {};
    state.settings.syncControl = {
      ...current,
      autoSyncOnChange: patch.syncControl.autoSyncOnChange !== undefined
        ? toBool(patch.syncControl.autoSyncOnChange)
        : current.autoSyncOnChange !== false,
      idleAutoSyncEnabled: patch.syncControl.idleAutoSyncEnabled !== undefined
        ? toBool(patch.syncControl.idleAutoSyncEnabled)
        : current.idleAutoSyncEnabled !== false,
      idleHours: patch.syncControl.idleHours !== undefined
        ? Math.max(1, Math.min(24, toInt(patch.syncControl.idleHours, 3)))
        : Math.max(1, Math.min(24, toInt(current.idleHours, 3))),
      lastLocalMutationAt: current.lastLocalMutationAt || null,
      lastIdleAutoSyncAt: current.lastIdleAutoSyncAt || null,
      lastBidirectionalSyncAt: current.lastBidirectionalSyncAt || null,
    };
  }
  const saved = saveState(state);
  refreshAppleAutoSync();
  refreshIdleAutoSync();
  return { settings: saved.settings, updatedAt: saved.updatedAt };
}

function exportAsJson() {
  const state = loadState();
  return {
    version: state.version,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    events: state.events,
  };
}

function toIcsDate(dateIso) {
  return new Date(dateIso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function exportAsIcs() {
  const state = loadState();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Project Golem//Collab Calendar//EN',
    'CALSCALE:GREGORIAN',
  ];

  for (const event of state.events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcsText(event.id)}@project-golem`);
    lines.push(`DTSTAMP:${toIcsDate(event.updatedAt || event.createdAt || new Date().toISOString())}`);
    lines.push(`DTSTART:${toIcsDate(event.start)}`);
    lines.push(`DTEND:${toIcsDate(event.end)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    lines.push(`CATEGORIES:${event.owner === 'golem' ? 'GOLEM' : 'USER'}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function importFromJson(input) {
  const payload = input && typeof input === 'object' ? input : {};
  const incomingEvents = Array.isArray(payload.events) ? payload.events : [];
  const state = loadState();
  const map = new Map(state.events.map((event) => [event.id, event]));
  let imported = 0;

  for (const rawEvent of incomingEvents) {
    try {
      const existing = rawEvent?.id ? map.get(String(rawEvent.id)) : null;
      const normalized = normalizeEvent(rawEvent, existing);
      map.set(normalized.id, normalized);
      imported += 1;
    } catch {
      // skip invalid event
    }
  }

  state.events = Array.from(map.values()).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  saveState(state);
  return { imported, total: state.events.length };
}

function parseIcsDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{8}T\d{6}Z$/.test(raw)) {
    const year = raw.slice(0, 4);
    const month = raw.slice(4, 6);
    const day = raw.slice(6, 8);
    const hour = raw.slice(9, 11);
    const minute = raw.slice(11, 13);
    const second = raw.slice(13, 15);
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function importFromIcs(icsText) {
  const text = String(icsText || '');
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  const items = [];

  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0] || '';
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const getVal = (key) => {
      const line = lines.find((item) => item.startsWith(`${key}:`));
      return line ? line.slice(key.length + 1).trim() : '';
    };

    const start = parseIcsDate(getVal('DTSTART'));
    const end = parseIcsDate(getVal('DTEND'));
    const title = getVal('SUMMARY');
    if (!start || !end || !title) continue;

    items.push({
      id: getVal('UID') || undefined,
      title,
      description: getVal('DESCRIPTION'),
      location: getVal('LOCATION'),
      start,
      end,
      owner: /GOLEM/i.test(getVal('CATEGORIES')) ? 'golem' : 'user',
      source: 'import-ics',
    });
  }

  return importFromJson({ events: items });
}

// ============================================================
// 🔐 Google OAuth2 雙向同步
// ============================================================

const OAUTH_TOKEN_PATH = path.join(DATA_DIR, 'google-oauth-token.json');

function loadOAuthToken() {
  ensureDir();
  if (!fs.existsSync(OAUTH_TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveOAuthToken(token) {
  ensureDir();
  fs.writeFileSync(OAUTH_TOKEN_PATH, JSON.stringify(token, null, 2), 'utf8');
}

function clearOAuthToken() {
  if (fs.existsSync(OAUTH_TOKEN_PATH)) fs.unlinkSync(OAUTH_TOKEN_PATH);
}

function getOAuthConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/calendar/google/callback',
  };
}

function buildAuthUrl(state = '') {
  const { clientId, redirectUri } = getOAuthConfig();
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID 未設定。');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 未設定。');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error_description || `Token exchange failed (${response.status})`);

  const token = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    tokenType: data.token_type || 'Bearer',
    scope: data.scope || '',
  };
  saveOAuthToken(token);
  return token;
}

async function refreshAccessToken(token) {
  const { clientId, clientSecret } = getOAuthConfig();
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 未設定。');
  if (!token?.refreshToken) throw new Error('No refresh token available. Please re-authorize.');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error_description || `Token refresh failed (${response.status})`);

  const updated = {
    ...token,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  saveOAuthToken(updated);
  return updated;
}

async function getValidAccessToken() {
  let token = loadOAuthToken();
  if (!token) throw new Error('尚未完成 Google OAuth 授權。請先點擊「授權 Google」按鈕。');
  if (Date.now() >= token.expiresAt - 60000) {
    token = await refreshAccessToken(token);
  }
  return token.accessToken;
}

function getOAuthStatus() {
  const token = loadOAuthToken();
  const { clientId } = getOAuthConfig();
  return {
    configured: !!(clientId),
    authorized: !!(token?.refreshToken),
    expiresAt: token?.expiresAt || null,
    scope: token?.scope || null,
  };
}

async function syncFromGoogle() {
  const state = loadState();
  const googleSettings = state.settings?.google || {};
  if (!googleSettings.enabled) throw new Error('Google sync is disabled.');

  const calendarId = encodeURIComponent(googleSettings.calendarId || 'primary');
  const now = new Date();
  const timeMin = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 30).toISOString();
  const timeMax = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 180).toISOString();

  // 優先使用 OAuth token；若無則 fallback 到 API Key（唯讀公開日曆）
  let headers = { Accept: 'application/json' };
  let url;
  const oauthToken = loadOAuthToken();

  if (oauthToken?.refreshToken) {
    const accessToken = await getValidAccessToken();
    headers['Authorization'] = `Bearer ${accessToken}`;
    url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
  } else if (googleSettings.apiKey) {
    url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&key=${encodeURIComponent(googleSettings.apiKey)}`;
  } else {
    throw new Error('請先完成 Google OAuth 授權，或填入 API Key（僅限公開日曆）。');
  }

  const response = await fetch(url, { headers });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.error?.message || `Google sync failed (${response.status})`;
    state.settings.google.lastSyncAt = new Date().toISOString();
    state.settings.google.lastSyncStatus = 'failed';
    state.settings.google.lastSyncMessage = message;
    saveState(state);
    throw new Error(message);
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const imported = [];
  for (const item of items) {
    const start = item?.start?.dateTime || (item?.start?.date ? `${item.start.date}T00:00:00.000Z` : null);
    const end = item?.end?.dateTime || (item?.end?.date ? `${item.end.date}T23:59:59.000Z` : null);
    if (!start || !end || !item?.summary) continue;

    imported.push({
      id: `google_${item.id}`,
      sourceId: String(item.id || ''),
      source: 'google-calendar',
      title: String(item.summary),
      description: String(item.description || ''),
      location: String(item.location || ''),
      start,
      end,
      owner: 'user',
      editableBy: { user: true, golem: true },
      participants: [],
      allDay: !!item?.start?.date,
    });
  }

  const result = importFromJson({ events: imported });
  const nextState = loadState();
  nextState.settings.google.lastSyncAt = new Date().toISOString();
  nextState.settings.google.lastSyncStatus = 'success';
  nextState.settings.google.lastSyncMessage = `已從 Google Calendar 匯入 ${imported.length} 個事件。`;
  saveState(nextState);

  return {
    ...result,
    importedFromGoogle: imported.length,
    lastSyncAt: nextState.settings.google.lastSyncAt,
  };
}

function makeAppleEpochMs(dateIso) {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid Apple date: ${dateIso}`);
  return date.getTime();
}

async function pushEventToGoogle(event) {
  const accessToken = await getValidAccessToken();
  const state = loadState();
  const calendarId = encodeURIComponent(state.settings?.google?.calendarId || 'primary');

  const body = {
    summary: event.title,
    description: event.description || '',
    location: event.location || '',
    start: event.allDay
      ? { date: event.start.slice(0, 10) }
      : { dateTime: event.start, timeZone: state.settings?.timezone || 'Asia/Taipei' },
    end: event.allDay
      ? { date: event.end.slice(0, 10) }
      : { dateTime: event.end, timeZone: state.settings?.timezone || 'Asia/Taipei' },
  };

  // 若已有 Google sourceId，則 PATCH；否則 POST 新建
  if (event.source === 'google-calendar' && event.sourceId) {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(event.sourceId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || `Google PATCH failed (${response.status})`);
    return data;
  } else {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || `Google POST failed (${response.status})`);
    return data;
  }
}

async function deleteEventFromGoogle(sourceId) {
  const accessToken = await getValidAccessToken();
  const state = loadState();
  const calendarId = encodeURIComponent(state.settings?.google?.calendarId || 'primary');

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(sourceId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message || `Google DELETE failed (${response.status})`);
  }
  return true;
}

async function pushEventToApple(event) {
  const state = loadState();
  if (!state.settings?.apple?.enabled) throw new Error('Apple sync is disabled.');
  const preferredCalendarId = safeString(state.settings?.apple?.calendarId);
  const preferredCalendarName = safeString(state.settings?.apple?.calendarName);
  const preferredCalendarIdText = JSON.stringify(preferredCalendarId);
  const preferredCalendarNameText = JSON.stringify(preferredCalendarName);
  const title = JSON.stringify(String(event.title || ''));
  const location = JSON.stringify(String(event.location || ''));
  const notes = JSON.stringify(String(event.description || ''));
  const baseNowMs = Date.now();
  const startOffsetSec = Math.round((makeAppleEpochMs(event.start) - baseNowMs) / 1000);
  const endOffsetSec = Math.round((makeAppleEpochMs(event.end) - baseNowMs) / 1000);
  const script = `tell application "Calendar"
set preferredCalendarName to ${preferredCalendarNameText}
set preferredCalendarId to ${preferredCalendarIdText}
set targetCal to missing value
if preferredCalendarId is not "" then
repeat with c in calendars
if ((id of c as text) is preferredCalendarId) and ((writable of c) is true) then
set targetCal to c
exit repeat
end if
end repeat
end if
if preferredCalendarName is not "" then
repeat with c in calendars
if ((name of c as text) is preferredCalendarName) and ((writable of c) is true) then
set targetCal to c
exit repeat
end if
end repeat
end if
if targetCal is missing value then
set writableCalendars to (every calendar whose writable is true)
if (count of writableCalendars) is 0 then error "No writable Apple Calendar found."
set targetCal to first item of writableCalendars
end if
set evtTitle to ${title}
set evtLoc to ${location}
set evtNote to ${notes}
set nowDate to current date
set evtStart to nowDate + (${startOffsetSec})
set evtEnd to nowDate + (${endOffsetSec})
set matchedEvent to missing value
repeat with anEvent in (every event of targetCal)
if ((summary of anEvent as text) is evtTitle) and ((start date of anEvent) is evtStart) then
set matchedEvent to anEvent
exit repeat
end if
end repeat
if matchedEvent is missing value then
set matchedEvent to make new event at end of events of targetCal with properties {summary:evtTitle, start date:evtStart, end date:evtEnd}
end if
set location of matchedEvent to evtLoc
set description of matchedEvent to evtNote
return (id of matchedEvent as text)
end tell`;
  const appleId = await execAppleScript(script, { timeoutMs: Math.max(10000, Math.min(300000, (state.settings?.apple?.timeoutSec || 60) * 1000)) });
  return { id: String(appleId || '') };
}

async function deleteEventFromApple(event) {
  const state = loadState();
  if (!state.settings?.apple?.enabled) return true;
  const preferredCalendarId = safeString(state.settings?.apple?.calendarId);
  const preferredCalendarName = safeString(state.settings?.apple?.calendarName);
  const preferredCalendarIdText = JSON.stringify(preferredCalendarId);
  const preferredCalendarNameText = JSON.stringify(preferredCalendarName);
  const title = JSON.stringify(String(event.title || ''));
  const baseNowMs = Date.now();
  const startOffsetSec = Math.round((makeAppleEpochMs(event.start) - baseNowMs) / 1000);
  const script = `tell application "Calendar"
set preferredCalendarName to ${preferredCalendarNameText}
set preferredCalendarId to ${preferredCalendarIdText}
set targetCal to missing value
if preferredCalendarId is not "" then
repeat with c in calendars
if ((id of c as text) is preferredCalendarId) and ((writable of c) is true) then
set targetCal to c
exit repeat
end if
end repeat
end if
if preferredCalendarName is not "" then
repeat with c in calendars
if ((name of c as text) is preferredCalendarName) and ((writable of c) is true) then
set targetCal to c
exit repeat
end if
end repeat
end if
if targetCal is missing value then
set writableCalendars to (every calendar whose writable is true)
if (count of writableCalendars) is 0 then return "ok"
set targetCal to first item of writableCalendars
end if
set evtTitle to ${title}
set nowDate to current date
set evtStart to nowDate + (${startOffsetSec})
repeat with anEvent in (every event of targetCal)
if ((summary of anEvent as text) is evtTitle) and ((start date of anEvent) is evtStart) then
delete anEvent
exit repeat
end if
end repeat
return "ok"
end tell`;
  await execAppleScript(script, { timeoutMs: Math.max(10000, Math.min(300000, (state.settings?.apple?.timeoutSec || 60) * 1000)) });
  return true;
}

function execAppleScript(script, { timeoutMs = DEFAULT_APPLE_SYNC_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('osascript', ['-e', script], { maxBuffer: 1024 * 1024 * 2 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(String(stdout || '').trim());
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error(`Apple sync timeout (${Math.floor(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    child.on('exit', () => clearTimeout(timer));
  });
}

async function listAppleCalendars() {
  const script = `tell application "Calendar"
set output to ""
repeat with c in calendars
set calName to (name of c as text)
set calId to (id of c as text)
set writableFlag to (writable of c as boolean)
set output to output & calName & "\\t" & calId & "\\t" & writableFlag & "\\n"
end repeat
return output
end tell`;
  const raw = await execAppleScript(script, { timeoutMs: 15000 });
  const calendars = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, id, writableRaw] = line.split('\t');
      return {
        name: String(name || '').trim(),
        id: String(id || '').trim(),
        writable: String(writableRaw || '').toLowerCase() === 'true',
      };
    })
    .filter((item) => item.name && item.id);
  return { calendars };
}

function computeNextAppleSyncAt(apple, now = new Date()) {
  if (!apple?.enabled) return null;
  if (apple.mode === 'interval') {
    const min = Math.max(15, Math.min(1440, toInt(apple.intervalMinutes, 120)));
    return new Date(now.getTime() + min * 60 * 1000).toISOString();
  }
  const times = normalizeDailyTimes(apple.dailyTimes).length ? normalizeDailyTimes(apple.dailyTimes) : ['09:00'];
  const candidates = times.map((hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  });
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0]?.toISOString() || null;
}

function scheduleAppleAutoSync() {
  if (appleAutoSyncTimer) clearTimeout(appleAutoSyncTimer);
  appleAutoSyncTimer = null;
  const state = loadState();
  const apple = state.settings?.apple;
  if (!apple?.enabled) return;
  const nextAt = computeNextAppleSyncAt(apple, new Date());
  state.settings.apple.nextSyncAt = nextAt;
  saveState(state);
  if (!nextAt) return;
  const delay = Math.max(1000, new Date(nextAt).getTime() - Date.now());
  appleAutoSyncTimer = setTimeout(async () => {
    try {
      await syncFromApple({ trigger: 'auto' });
    } catch {
      // status already persisted in syncFromApple
    } finally {
      scheduleAppleAutoSync();
    }
  }, delay);
}

function refreshAppleAutoSync() {
  scheduleAppleAutoSync();
}

function shouldIdleAutoSync(state) {
  const syncControl = state.settings?.syncControl || {};
  if (syncControl.idleAutoSyncEnabled === false) return false;
  const lastMutation = syncControl.lastLocalMutationAt ? new Date(syncControl.lastLocalMutationAt).getTime() : null;
  if (!lastMutation || Number.isNaN(lastMutation)) return false;
  if (Date.now() - lastMutation < IDLE_AUTO_SYNC_MS) return false;
  const lastIdleSync = syncControl.lastIdleAutoSyncAt ? new Date(syncControl.lastIdleAutoSyncAt).getTime() : null;
  if (lastIdleSync && !Number.isNaN(lastIdleSync) && lastIdleSync >= lastMutation) return false;
  return true;
}

async function syncBidirectional({ trigger = 'manual' } = {}) {
  if (bidirectionalSyncInFlight) return bidirectionalSyncInFlight;
  bidirectionalSyncInFlight = (async () => {
    const summary = {
      trigger,
      google: { pulled: false, pushed: 0, failed: 0, errors: [] },
      apple: { pulled: false, pushed: 0, failed: 0, errors: [], skippedReason: '' },
    };
    const state = loadState();
    const events = state.events || [];
    const oauthStatus = getOAuthStatus();

    if (state.settings?.google?.enabled) {
      try {
        await syncFromGoogle();
        summary.google.pulled = true;
      } catch {
        // keep going
      }
      if (oauthStatus.authorized) {
        for (const event of events) {
          try {
            await pushEventToGoogle(event);
            summary.google.pushed += 1;
          } catch (error) {
            summary.google.failed += 1;
            if (summary.google.errors.length < 10) {
              summary.google.errors.push(`${event.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
    }

    if (state.settings?.apple?.enabled) {
      try {
        await syncFromApple({ trigger });
        summary.apple.pulled = true;
      } catch {
        // keep going
      }
      for (const event of events) {
        try {
          await pushEventToApple(event);
          summary.apple.pushed += 1;
        } catch (error) {
          summary.apple.failed += 1;
          if (summary.apple.errors.length < 10) {
            summary.apple.errors.push(`${event.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } else {
      summary.apple.skippedReason = 'Apple sync is disabled in settings.';
    }

    const done = loadState();
    done.settings.syncControl.lastBidirectionalSyncAt = new Date().toISOString();
    if (trigger === 'idle-auto') done.settings.syncControl.lastIdleAutoSyncAt = done.settings.syncControl.lastBidirectionalSyncAt;
    saveState(done);
    return summary;
  })();
  try {
    return await bidirectionalSyncInFlight;
  } finally {
    bidirectionalSyncInFlight = null;
  }
}

function triggerAutoSyncOnLocalChange() {
  const state = loadState();
  if (state.settings?.syncControl?.autoSyncOnChange === false) return;
  syncBidirectional({ trigger: 'local-change' }).catch(() => {});
}

function scheduleIdleAutoSync() {
  if (idleAutoSyncTimer) clearInterval(idleAutoSyncTimer);
  idleAutoSyncTimer = setInterval(() => {
    const state = loadState();
    if (!shouldIdleAutoSync(state)) return;
    syncBidirectional({ trigger: 'idle-auto' }).catch(() => {});
  }, IDLE_CHECK_INTERVAL_MS);
}

function refreshIdleAutoSync() {
  scheduleIdleAutoSync();
}

async function syncFromApple({
  daysBefore,
  daysAfter,
  timeoutMs,
  trigger = 'manual',
} = {}) {
  if (appleSyncInFlight) throw new Error('Apple sync already running.');
  const state = loadState();
  const appleSettings = state.settings?.apple || {};
  const before = Number.isFinite(Number(daysBefore)) ? Number(daysBefore) : appleSettings.daysBefore;
  const after = Number.isFinite(Number(daysAfter)) ? Number(daysAfter) : appleSettings.daysAfter;
  const tm = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : appleSettings.timeoutSec * 1000;
  const escapedBefore = Math.max(0, Math.min(365, Math.floor(before)));
  const escapedAfter = Math.max(1, Math.min(365, Math.floor(after)));
  // Keep AppleScript minimal for locale compatibility.
  const script = `set nowDate to (current date)
set startDate to nowDate - (${escapedBefore} * days)
set endDate to nowDate + (${escapedAfter} * days)
tell application "Calendar"
set output to ""
repeat with aCalendar in calendars
set calName to (name of aCalendar as text)
set allEvents to (every event of aCalendar whose start date is greater than startDate and start date is less than endDate)
repeat with anEvent in allEvents
set evtTitle to (summary of anEvent as text)
set evtStart to (start date of anEvent as string)
set evtEnd to (end date of anEvent as string)
set output to output & calName & "\\t" & evtTitle & "\\t" & evtStart & "\\t" & evtEnd & "\\n"
end repeat
end repeat
return output
end tell`;

  const perform = async () => {
    const raw = await execAppleScript(script, { timeoutMs: Math.max(10000, Math.min(300000, tm || DEFAULT_APPLE_SYNC_TIMEOUT_MS)) });
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const imported = [];

    for (const line of lines) {
      const [calendarName, title, startRaw, endRaw] = line.split('\t');
      if (!title || !startRaw || !endRaw) continue;
      const startIso = normalizeDate(startRaw);
      const endIso = normalizeDate(endRaw);
      if (!startIso || !endIso) continue;
      const sourceId = crypto.createHash('sha1')
        .update(`${calendarName || ''}|${title}|${startIso}|${endIso}`)
        .digest('hex');
      imported.push({
        id: `apple_${sourceId}`,
        source: 'apple-calendar',
        sourceId,
        title,
        start: startIso,
        end: endIso,
        location: '',
        description: '',
        owner: 'user',
        participants: calendarName ? [calendarName] : [],
        editableBy: { user: true, golem: true },
      });
    }

    const result = importFromJson({ events: imported });
    return { ...result, importedFromApple: imported.length };
  };

  appleSyncInFlight = perform();
  try {
    const result = await appleSyncInFlight;
    const okState = loadState();
    okState.settings.apple.lastSyncAt = new Date().toISOString();
    okState.settings.apple.lastSyncStatus = 'success';
    okState.settings.apple.lastSyncMessage = trigger === 'auto'
      ? `Apple 自動同步成功，匯入 ${result.importedFromApple} 筆。`
      : `Apple 同步成功，匯入 ${result.importedFromApple} 筆。`;
    okState.settings.apple.nextSyncAt = computeNextAppleSyncAt(okState.settings.apple, new Date());
    saveState(okState);
    return result;
  } catch (error) {
    const failState = loadState();
    failState.settings.apple.lastSyncAt = new Date().toISOString();
    failState.settings.apple.lastSyncStatus = 'failed';
    failState.settings.apple.lastSyncMessage = error instanceof Error ? error.message : String(error);
    failState.settings.apple.nextSyncAt = computeNextAppleSyncAt(failState.settings.apple, new Date());
    saveState(failState);
    throw error;
  } finally {
    appleSyncInFlight = null;
  }
}

refreshAppleAutoSync();
refreshIdleAutoSync();

module.exports = {
  listEvents,
  createEvent,
  updateEvent,
  removeEvent,
  getSettings,
  updateSettings,
  exportAsJson,
  exportAsIcs,
  importFromJson,
  importFromIcs,
  syncFromGoogle,
  syncFromApple,
  syncBidirectional,
  refreshAppleAutoSync,
  refreshIdleAutoSync,
  checkDueReminders,
  // Google OAuth2
  buildAuthUrl,
  exchangeCodeForToken,
  getOAuthStatus,
  clearOAuthToken,
  pushEventToGoogle,
  deleteEventFromGoogle,
  pushEventToApple,
  deleteEventFromApple,
  listAppleCalendars,
  triggerAutoSyncOnLocalChange,
};
