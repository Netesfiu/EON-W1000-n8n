import { parseArgs } from 'node:util';
import { ImportError } from './utils/log.js';

export const usage = 'Usage: npm run start -- [--dry-run] [--since YYYY-MM-DD] [--reprocess]';

export function options(args: string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        help: { type: 'boolean', short: 'h' },
        'dry-run': { type: 'boolean' },
        since: { type: 'string' },
        reprocess: { type: 'boolean' },
      },
    }));
  } catch {
    throw new ImportError(usage);
  }
  const since = values.since;
  if (since !== undefined) {
    const date = new Date(since);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== since) {
      throw new ImportError('--since must be a calendar date in YYYY-MM-DD format');
    }
  }
  return { help: values.help, dryRun: values['dry-run'] ?? false, since, reprocess: values.reprocess ?? false };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ImportError(`Missing environment variable ${key}`);
  return value;
}

function url(env: NodeJS.ProcessEnv, key: string, protocols: readonly string[]): string {
  const value = required(env, key);
  try {
    const endpoint = new URL(value);
    if (protocols.includes(endpoint.protocol) && !endpoint.username && !endpoint.password &&
        !endpoint.search && !endpoint.hash) return endpoint.toString();
  } catch {
    // Avoid printing the supplied URL.
  }
  throw new ImportError(`Invalid URL in ${key}`);
}

export function config(env: NodeJS.ProcessEnv, forceDryRun: boolean) {
  const mode = env.IMPORT_MODE || 'dry-run';
  if (mode !== 'dry-run' && mode !== 'write') throw new ImportError('IMPORT_MODE must be dry-run or write');
  const dryRun = forceDryRun || mode === 'dry-run';
  return {
    dryRun,
    directory: env.STATE_DIR || './state',
    r2: {
      endpoint: url(env, 'R2_ENDPOINT', ['https:']),
      bucket: required(env, 'R2_BUCKET'),
      accessKeyId: required(env, 'R2_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY'),
    },
    ha: dryRun ? undefined : {
      url: url(env, 'HA_URL', ['http:', 'https:', 'ws:', 'wss:']),
      token: required(env, 'HA_TOKEN'),
    },
  };
}
