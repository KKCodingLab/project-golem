jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const fs = require('fs');
const { execFile } = require('child_process');

function buildState() {
  return {
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
        enabled: true,
        calendarId: '',
        calendarName: '居家',
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
}

const stateJson = JSON.stringify(buildState());
fs.existsSync.mockReturnValue(true);
fs.readFileSync.mockImplementation((p) => {
  if (String(p || '').includes('google-oauth-token.json')) return JSON.stringify({});
  return stateJson;
});

execFile.mockImplementation((_cmd, _args, _opts, cb) => {
  cb(null, 'apple-id', '');
  return {
    kill: jest.fn(),
    on: (_event, handler) => {
      if (typeof handler === 'function') handler();
    },
  };
});

const service = require('../src/services/CalendarCollabService');

describe('CalendarCollabService AppleScript date construction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, 'apple-id', '');
      return {
        kill: jest.fn(),
        on: (_event, handler) => {
          if (typeof handler === 'function') handler();
        },
      };
    });
  });

  test('pushEventToApple uses relative offset date construction', async () => {
    expect(service.getSettings().apple.enabled).toBe(true);
    await service.pushEventToApple({
      title: '測試事件',
      description: '',
      location: '',
      start: '2026-05-16T08:30:00.000Z',
      end: '2026-05-16T09:30:00.000Z',
    });

    const args = execFile.mock.calls[0][1];
    const script = args[1];
    expect(script).toContain('set nowDate to current date');
    expect(script).toContain('set evtStart to nowDate + (');
    expect(script).toContain('set evtEnd to nowDate + (');
    expect(script).not.toContain('set year of evtStart');
    expect(script).not.toContain('set month of evtStart');
    expect(script).not.toContain('set day of evtStart');
  });

  test('deleteEventFromApple uses relative offset date construction', async () => {
    expect(service.getSettings().apple.enabled).toBe(true);
    await service.deleteEventFromApple({
      title: '測試事件',
      start: '2026-05-16T08:30:00.000Z',
    });

    const args = execFile.mock.calls[0][1];
    const script = args[1];
    expect(script).toContain('set nowDate to current date');
    expect(script).toContain('set evtStart to nowDate + (');
    expect(script).not.toContain('set year of evtStart');
    expect(script).not.toContain('set month of evtStart');
    expect(script).not.toContain('set day of evtStart');
  });
});
