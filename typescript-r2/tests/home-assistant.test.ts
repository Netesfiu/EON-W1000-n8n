import { afterEach, expect, it, vi } from 'vitest';
import { HomeAssistant } from '../src/home-assistant/client.js';
import { importRequest } from '../src/home-assistant/statistics.js';
import { firstHour } from './fixtures/report.js';

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class MockSocket extends EventEmitter {
    static OPEN = 1;
    static current: MockSocket;
    readyState = MockSocket.OPEN;
    send = vi.fn<(message: string, callback?: (error?: Error) => void) => void>();

    constructor(readonly url: URL) {
      super();
      MockSocket.current = this;
    }

    terminate() {
      this.emit('close');
    }

    close() {
      this.terminate();
    }

    receive(message: object) {
      this.emit('message', Buffer.from(JSON.stringify(message)));
    }
  }
  return { default: MockSocket };
});
const { default: transport } = await import('ws');
type TestSocket = {
  url: URL;
  receive(message: object): void;
  send: { mock: { calls: [string][] } };
};
const mockTransport = transport as unknown as { current: TestSocket };
afterEach(() => vi.restoreAllMocks());

it('uses Recorder external-statistic metadata and UTC hourly sums', () => {
  expect(importRequest('-A', [{ direction: '-A', startMs: firstHour, sumMicros: 250_000 }])).toEqual({
    type: 'recorder/import_statistics',
    metadata: {
      statistic_id: 'eon:grid_export', name: 'E.ON grid export', source: 'eon',
      mean_type: 0, has_sum: true, unit_class: 'energy', unit_of_measurement: 'kWh',
    },
    stats: [{ start: '2026-11-01T11:00:00.000Z', sum: 0.25 }],
  });
});

it('authenticates, sends a correlated request and handles Recorder rejection', async () => {
  const ha = new HomeAssistant('https://example.test/ha/', 'synthetic-token');
  const socket = mockTransport.current;
  try {
    expect(socket.url.toString()).toBe('wss://example.test/ha/api/websocket');
    socket.receive({ type: 'auth_required' });
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({ type: 'auth', access_token: 'synthetic-token' });
    const first = ha.request({ type: 'recorder/list_statistic_ids' });
    const second = ha.request({ type: 'recorder/statistics_during_period' });
    const failure = expect(second).rejects.toThrow('unauthorized');
    socket.receive({ type: 'auth_ok' });
    await Promise.resolve();
    expect(JSON.parse(socket.send.mock.calls[1]![0])).toEqual({ type: 'recorder/list_statistic_ids', id: 1 });
    socket.receive({ type: 'result', id: 2, success: false, error: { code: 'unauthorized' } });
    socket.receive({ type: 'result', id: 1, success: true, result: [] });
    await expect(first).resolves.toEqual([]);
    await failure;
  } finally {
    ha.close();
  }
});
