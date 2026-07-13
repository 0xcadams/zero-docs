import type {LogContext} from '@rocicorp/logger';
import type {Database} from '../../zqlite/src/db.ts';
export {initReplica} from './services/change-source/common/replica-schema.ts';
import {initialSync} from './services/change-source/pg/initial-sync.ts';

export const ZERO_VERSION = '1.8';
export const supportsBinaryCopy = true;

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
    {
      tableCopyWorkers: options.workers,
      textCopy: options.copyFormat === 'text',
      profileCopy: options.profileCopy,
    },
    context as Parameters<typeof initialSync>[5],
  );
}
