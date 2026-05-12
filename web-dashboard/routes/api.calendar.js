const express = require('express');
const CalendarCollabService = require('../../src/services/CalendarCollabService');
const { buildOperationGuard } = require('../server/security');

module.exports = function registerCalendarRoutes(server) {
  const router = express.Router();
  const requireCalendarWrite = buildOperationGuard(server, 'calendar_write');

  function handleError(res, error) {
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({ error: error?.message || String(error) });
  }

  // ── Events CRUD ──────────────────────────────────────────────

  router.get('/api/calendar/events', (req, res) => {
    try {
      const { start, end, owner } = req.query || {};
      return res.json(CalendarCollabService.listEvents({ start, end, owner }));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/api/calendar/events', requireCalendarWrite, (req, res) => {
    try {
      return res.json({ success: true, ...CalendarCollabService.createEvent(req.body || {}) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/api/calendar/events/:id', requireCalendarWrite, (req, res) => {
    try {
      const result = CalendarCollabService.updateEvent(req.params.id, req.body || {});
      if (!result) return res.status(404).json({ error: 'Event not found.' });
      return res.json({ success: true, ...result });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.delete('/api/calendar/events/:id', requireCalendarWrite, async (req, res) => {
    try {
      // 若事件來自 Google，同步刪除 Google 端
      const state = CalendarCollabService.listEvents();
      const event = state.events && state.events.find((e) => e.id === req.params.id);
      if (event && event.source === 'google-calendar' && event.sourceId) {
        const oauthStatus = CalendarCollabService.getOAuthStatus();
        if (oauthStatus.authorized) {
          await CalendarCollabService.deleteEventFromGoogle(event.sourceId).catch(() => {});
        }
      }
      const removed = CalendarCollabService.removeEvent(req.params.id);
      if (!removed) return res.status(404).json({ error: 'Event not found.' });
      return res.json({ success: true });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // ── Settings ─────────────────────────────────────────────────

  router.get('/api/calendar/settings', (req, res) => {
    try {
      return res.json({ settings: CalendarCollabService.getSettings() });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/api/calendar/settings', requireCalendarWrite, (req, res) => {
    try {
      return res.json({ success: true, ...CalendarCollabService.updateSettings(req.body || {}) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // ── Import / Export ───────────────────────────────────────────

  router.post('/api/calendar/import', requireCalendarWrite, (req, res) => {
    try {
      const { format = 'json', payload } = req.body || {};
      if (format === 'ics') {
        return res.json({ success: true, ...CalendarCollabService.importFromIcs(payload) });
      }
      return res.json({ success: true, ...CalendarCollabService.importFromJson(payload) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/api/calendar/export', (req, res) => {
    try {
      const format = String(req.query.format || 'json').toLowerCase();
      if (format === 'ics') {
        const ics = CalendarCollabService.exportAsIcs();
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="golem-collab-calendar-${Date.now()}.ics"`);
        return res.send(ics);
      }
      return res.json(CalendarCollabService.exportAsJson());
    } catch (error) {
      return handleError(res, error);
    }
  });

  // ── Google OAuth2 ─────────────────────────────────────────────

  // 取得 OAuth 狀態（是否已授權、Client ID 是否設定）
  router.get('/api/calendar/google/oauth/status', (req, res) => {
    try {
      return res.json(CalendarCollabService.getOAuthStatus());
    } catch (error) {
      return handleError(res, error);
    }
  });

  // 產生授權 URL，前端開啟此 URL 讓使用者授權
  router.get('/api/calendar/google/oauth/url', requireCalendarWrite, (req, res) => {
    try {
      const state = String(req.query.state || '');
      const url = CalendarCollabService.buildAuthUrl(state);
      return res.json({ url });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // OAuth callback — Google 授權後重導向到此
  router.get('/api/calendar/google/callback', async (req, res) => {
    try {
      const { code, error: oauthError } = req.query || {};
      if (oauthError) {
        return res.redirect(`/dashboard/calendar?oauth_error=${encodeURIComponent(String(oauthError))}`);
      }
      if (!code) {
        return res.redirect('/dashboard/calendar?oauth_error=missing_code');
      }
      await CalendarCollabService.exchangeCodeForToken(String(code));
      return res.redirect('/dashboard/calendar?oauth_success=1');
    } catch (error) {
      return res.redirect(`/dashboard/calendar?oauth_error=${encodeURIComponent(error.message)}`);
    }
  });

  // 撤銷授權（清除本地 token）
  router.post('/api/calendar/google/oauth/revoke', requireCalendarWrite, (req, res) => {
    try {
      CalendarCollabService.clearOAuthToken();
      return res.json({ success: true });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // ── Google 同步 ───────────────────────────────────────────────

  // 從 Google 拉取（Google → 本地）
  router.post('/api/calendar/google/sync', requireCalendarWrite, async (req, res) => {
    try {
      const result = await CalendarCollabService.syncFromGoogle();
      return res.json({ success: true, ...result });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // 推送單一事件到 Google（本地 → Google）
  router.post('/api/calendar/google/push/:id', requireCalendarWrite, async (req, res) => {
    try {
      const eventsData = CalendarCollabService.listEvents();
      const event = eventsData.events && eventsData.events.find((e) => e.id === req.params.id);
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      const googleEvent = await CalendarCollabService.pushEventToGoogle(event);
      // 若是新建事件，更新本地的 sourceId
      if (event.source !== 'google-calendar' && googleEvent?.id) {
        CalendarCollabService.updateEvent(event.id, {
          source: 'google-calendar',
          sourceId: googleEvent.id,
        });
      }
      return res.json({ success: true, googleEventId: googleEvent?.id });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // 全量推送（本地所有事件 → Google）
  router.post('/api/calendar/google/push-all', requireCalendarWrite, async (req, res) => {
    try {
      const eventsData = CalendarCollabService.listEvents();
      const events = eventsData.events || [];
      let pushed = 0;
      let failed = 0;
      for (const event of events) {
        try {
          const googleEvent = await CalendarCollabService.pushEventToGoogle(event);
          if (event.source !== 'google-calendar' && googleEvent?.id) {
            CalendarCollabService.updateEvent(event.id, {
              source: 'google-calendar',
              sourceId: googleEvent.id,
            });
          }
          pushed++;
        } catch {
          failed++;
        }
      }
      return res.json({ success: true, pushed, failed, total: events.length });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // ── Apple 同步 ────────────────────────────────────────────────

  router.post('/api/calendar/apple/sync', requireCalendarWrite, async (req, res) => {
    try {
      const { daysBefore = 30, daysAfter = 180, timeoutMs } = req.body || {};
      const result = await CalendarCollabService.syncFromApple({ daysBefore, daysAfter, timeoutMs, trigger: 'manual' });
      return res.json({ success: true, ...result });
    } catch (error) {
      return handleError(res, error);
    }
  });

  return router;
};
