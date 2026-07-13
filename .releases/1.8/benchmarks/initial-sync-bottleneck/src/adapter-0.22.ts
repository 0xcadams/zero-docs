import type {LogContext} from '@rocicorp/logger';
import type {Database} from '../../zqlite/src/db.ts';
export {initReplica} from './services/change-source/replica-schema.ts';
import {initialSync} from './services/change-source/pg/initial-sync.ts';

export const ZERO_VERSION = '0.22';
export const supportsBinaryCopy = false;

export async function runInitialSync(
  lc: LogContext,
  shard: {appID: string; shardNum: number; publications: string[]},
  tx: Database,
  upstreamURI: string,
  options: {
    workers: number;
    copyFormat: 'binary' | 'text';
    profileCopy: boolean;
  },
  _context: Record<string, unknown>,
) {
  await initialSync(lc, shard, tx, upstreamURI, {
    tableCopyWorkers: options.workers,
    profileCopy: options.profileCopy,
  });
}
