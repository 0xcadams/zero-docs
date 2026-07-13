import type {LogContext} from '@rocicorp/logger';
import type {Database} from '../../zqlite/src/db.ts';
export {initReplica} from './services/change-source/common/replica-schema.ts';
import {initialSync} from './services/change-source/pg/initial-sync.ts';

export const ZERO_VERSION = '1.0';
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
  context: Record<string, unknown>,
) {
  await initialSync(
    lc,
    shard,
    tx,
    upstreamURI,
    {tableCopyWorkers: options.workers, profileCopy: options.profileCopy},
    context as Parameters<typeof initialSync>[5],
  );
}
