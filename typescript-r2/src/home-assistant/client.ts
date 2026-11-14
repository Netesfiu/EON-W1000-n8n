import WebSocket from 'ws';
import { ImportError } from '../utils/log.js';

type Message = {
  type?: unknown;
  id?: unknown;
  success?: unknown;
  result?: unknown;
  error?: { code?: unknown };
};

const SAFE_CODES = new Set(['unknown_command', 'invalid_format', 'unauthorized', 'unknown_error']);

export class HomeAssistant {
  private readonly socket: WebSocket;
  private id = 0;
  private readonly authenticated: Promise<void>;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();

  constructor(url: string, token: string) {
    const endpoint = new URL(url);
    endpoint.protocol = ['https:', 'wss:'].includes(endpoint.protocol) ? 'wss:' : 'ws:';
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/api/websocket';
    this.socket = new WebSocket(endpoint, { handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024 });
    this.authenticated = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ImportError('Home Assistant authentication timed out'));
        this.socket.terminate();
      }, 10_000);
      const fail = () => {
        clearTimeout(timer);
        reject(new ImportError('Home Assistant WebSocket disconnected'));
        for (const entry of this.pending.values()) entry.reject(new ImportError('Home Assistant WebSocket disconnected'));
      };
      this.socket.on('error', fail).on('close', fail).on('message', (raw) => {
        let message: Message;
        try {
          message = JSON.parse(raw.toString()) as Message;
          if (!message || typeof message !== 'object') throw new Error('expected object');
        } catch {
          this.socket.terminate();
          return;
        }
        if (message.type === 'auth_required') this.socket.send(JSON.stringify({ type: 'auth', access_token: token }));
        if (message.type === 'auth_ok') {
          clearTimeout(timer);
          resolve();
        }
        if (message.type === 'auth_invalid') {
          clearTimeout(timer);
          reject(new ImportError('Home Assistant rejected the access token'));
          this.socket.close();
        }
        if (message.type !== 'result' || typeof message.id !== 'number') return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        if (message.success === true) entry.resolve(message.result);
        else {
          const code = message.error?.code;
          const detail = typeof code === 'string' && SAFE_CODES.has(code) ? ` (${code})` : '';
          entry.reject(new ImportError(`Home Assistant rejected the Recorder command${detail}`));
        }
      });
    });
    // Authentication may fail before a caller gets to its first request.
    void this.authenticated.catch(() => {});
  }

  async request(command: { type: string }): Promise<unknown> {
    await this.authenticated;
    if (this.socket.readyState !== WebSocket.OPEN) throw new ImportError('Home Assistant WebSocket is closed');
    const id = ++this.id;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          reject(new ImportError('Home Assistant Recorder command timed out'));
          this.socket.terminate();
        }, 15_000);
        this.socket.send(JSON.stringify({ ...command, id }), (error) => {
          if (error) reject(new ImportError('Home Assistant WebSocket send failed'));
        });
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  close(): void {
    this.socket.terminate();
  }
}
