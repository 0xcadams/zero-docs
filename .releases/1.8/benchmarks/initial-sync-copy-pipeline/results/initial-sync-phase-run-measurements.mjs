import {spawnSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const mode = process.argv[2];
if (
  ![
    'overhead',
    'full',
    'narrow',
    'imports1cpu',
    'imports1cpu3g',
  ].includes(mode)
) {
  throw new Error(
    'Usage: node run-measurements.mjs <overhead|full|narrow|imports1cpu|imports1cpu3g>',
  );
}

const outputRoot =
  '/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/initial-sync-phase-measurement';
const image = 'zero-initial-sync-phase-measurement:local';
const imageID = capture('docker', [
  'image',
  'inspect',
  '--format',
  '{{.Id}}',
  image,
]).trim();
const allProfiles = {
  'email-683m': {
    fixture: 'email',
    rows: 1000,
    payloadBytes: 683000,
    expectedCopyBytes: 683000000,
    cpus: 1,
    memory: '3g',
    nodeHeapMB: 2304,
  },
  'imports-550m': {
    fixture: 'imports',
    rows: 2000,
    payloadBytes: 275000,
    expectedCopyBytes: 550000000,
    cpus: 2,
    memory: '6g',
    nodeHeapMB: 4608,
  },
  'email-6.83g': {
    fixture: 'email',
    rows: 10000,
    payloadBytes: 683000,
    expectedCopyBytes: 6830000000,
    cpus: 1,
    memory: '3g',
    nodeHeapMB: 2304,
  },
  'imports-2.75g': {
    fixture: 'imports',
    rows: 10000,
    payloadBytes: 275000,
    expectedCopyBytes: 2750000000,
    cpus: 2,
    memory: '6g',
    nodeHeapMB: 4608,
  },
  'email-narrow-250k': {
    fixture: 'email',
    rows: 250000,
    payloadBytes: 128,
    cpus: 1,
    memory: '3g',
    nodeHeapMB: 2304,
  },
  'imports-narrow-250k': {
    fixture: 'imports',
    rows: 250000,
    payloadBytes: 128,
    cpus: 2,
    memory: '6g',
    nodeHeapMB: 4608,
  },
  'imports-550m-1cpu': {
    fixture: 'imports',
    rows: 2000,
    payloadBytes: 275000,
    expectedCopyBytes: 550000000,
    cpus: 1,
    memory: '6g',
    nodeHeapMB: 4608,
  },
  'imports-2.75g-1cpu': {
    fixture: 'imports',
    rows: 10000,
    payloadBytes: 275000,
    expectedCopyBytes: 2750000000,
    cpus: 1,
    memory: '6g',
    nodeHeapMB: 4608,
  },
  'imports-narrow-250k-1cpu': {
    fixture: 'imports',
    rows: 250000,
    payloadBytes: 128,
    cpus: 1,
    memory: '6g',
    nodeHeapMB: 4608,
  },
  'imports-550m-1cpu-3g': {
    fixture: 'imports',
    rows: 2000,
    payloadBytes: 275000,
    expectedCopyBytes: 550000000,
    cpus: 1,
    memory: '3g',
    nodeHeapMB: 2304,
  },
  'imports-2.75g-1cpu-3g': {
    fixture: 'imports',
    rows: 10000,
    payloadBytes: 275000,
    expectedCopyBytes: 2750000000,
    cpus: 1,
    memory: '3g',
    nodeHeapMB: 2304,
  },
  'imports-narrow-250k-1cpu-3g': {
    fixture: 'imports',
    rows: 250000,
    payloadBytes: 128,
    cpus: 1,
    memory: '3g',
    nodeHeapMB: 2304,
  },
};
const modeConfig = {
  overhead: {
    profiles: ['email-683m', 'imports-550m'],
    treatments: ['disabled', 'enabled'],
    repetitions: 10,
  },
  full: {
    profiles: ['email-6.83g', 'imports-2.75g'],
    treatments: ['enabled'],
    repetitions: 5,
  },
  narrow: {
    profiles: ['email-narrow-250k', 'imports-narrow-250k'],
    treatments: ['enabled'],
    repetitions: 3,
  },
  imports1cpu: {
    profiles: [
      'imports-550m-1cpu',
      'imports-2.75g-1cpu',
      'imports-narrow-250k-1cpu',
    ],
    treatments: ['enabled'],
    repetitions: 5,
  },
  imports1cpu3g: {
    profiles: [
      'imports-550m-1cpu-3g',
      'imports-2.75g-1cpu-3g',
      'imports-narrow-250k-1cpu-3g',
    ],
    treatments: ['enabled'],
    repetitions: 5,
  },
}[mode];
const rawDirectory = join(outputRoot, `raw-${mode}`);
await mkdir(rawDirectory, {recursive: true});

const runs = [];
for (let repetition = 1; repetition <= modeConfig.repetitions; repetition++) {
  const profiles =
    repetition % 2 === 1
      ? modeConfig.profiles
      : [...modeConfig.profiles].reverse();
  const treatments =
    repetition % 2 === 1
      ? modeConfig.treatments
      : [...modeConfig.treatments].reverse();
  for (const profile of profiles) {
    for (const treatment of treatments) {
      runs.push({profile, treatment, repetition});
    }
  }
}

const suffix = `${process.pid}-${Date.now()}`;
const network = `zero-phase-measurement-${suffix}`;
const postgres = `zero-phase-measurement-postgres-${suffix}`;
run('docker', ['network', 'create', network]);
run('docker', [
  'run',
  '--detach',
  '--name',
  postgres,
  '--network',
  network,
  '--network-alias',
  'postgres',
  '--memory',
  '2g',
  '--cpus',
  '2',
  '--env',
  'POSTGRES_PASSWORD=postgres',
  'postgres:17-alpine',
  '-c',
  'wal_level=logical',
  '-c',
  'max_replication_slots=100',
  '-c',
  'max_wal_senders=100',
]);

const completed = [];
try {
  waitForPostgres(postgres);
  for (let index = 0; index < runs.length; index++) {
    const runConfig = runs[index];
    const profile = allProfiles[runConfig.profile];
    const id = `${runConfig.profile}-${runConfig.treatment}-r${runConfig.repetition}`;
    const output = join(
      rawDirectory,
      `${String(index + 1).padStart(3, '0')}-${id}.log`,
    );
    const measurementEnabled = runConfig.treatment === 'enabled';
    const env = {
      TEST_PG_17: 'postgres://postgres:postgres@postgres:5432/postgres',
      NODE_OPTIONS: `--max-old-space-size=${profile.nodeHeapMB}`,
      ZERO_COPY_PIPELINE_PROFILE: runConfig.profile,
      ZERO_COPY_PIPELINE_RUN_LABEL: id,
      ZERO_COPY_PIPELINE_FIXTURE: profile.fixture,
      ZERO_COPY_PIPELINE_ROWS: String(profile.rows),
      ZERO_COPY_PIPELINE_PAYLOAD_BYTES: String(profile.payloadBytes),
      ...(profile.expectedCopyBytes === undefined
        ? {}
        : {
            ZERO_COPY_PIPELINE_EXPECTED_COPY_BYTES: String(
              profile.expectedCopyBytes,
            ),
          }),
      ZERO_COPY_PIPELINE_COPY_CHUNK_BYTES: 'native',
      ZERO_COPY_PIPELINE_MODE: 'sync',
      ZERO_COPY_PIPELINE_WORKERS: '5',
      ZERO_COPY_PIPELINE_PARTIAL_BATCHES: '0',
      ZERO_COPY_PIPELINE_DIRECT_TEXT_BUFFERS: '0',
      ZERO_COPY_PIPELINE_EAGER_INDEXES: '0',
      ZERO_COPY_PIPELINE_EAGER_SECONDARY_INDEXES: '0',
      ZERO_COPY_PIPELINE_ADAPTIVE_SECONDARY_INDEXES: '0',
      ZERO_COPY_PIPELINE_INSTRUMENT_COPY_PHASES: '0',
      ZERO_COPY_PIPELINE_REUSE_FIELD_BUFFERS: '0',
      ZERO_COPY_PIPELINE_NATIVE_TEXT_BUFFERS: '0',
      ZERO_COPY_PIPELINE_NATIVE_TEXT_STATIC: '0',
      ZERO_COPY_PIPELINE_BUFFER_MB: '8',
      ZERO_COPY_PIPELINE_MMAP_GIB: '0',
      ZERO_COPY_PIPELINE_INSTRUMENT: '1',
      ZERO_INITIAL_SYNC_PHASE_MEASUREMENT: measurementEnabled ? '1' : '0',
    };
    const meta = {
      startedAt: new Date().toISOString(),
      mode,
      id,
      runConfig,
      profile,
      image,
      imageID,
      postgresTopology: 'direct-docker-bridge',
    };
    console.log(`[${index + 1}/${runs.length}] ${id}`);
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--init',
        '--network',
        network,
        '--platform',
        'linux/arm64',
        '--memory',
        profile.memory,
        '--memory-swap',
        profile.memory,
        '--cpus',
        String(profile.cpus),
        '--pids-limit',
        '1024',
        ...Object.entries(env).flatMap(([name, value]) => [
          '--env',
          `${name}=${value}`,
        ]),
        image,
        'bash',
        '-lc',
        linuxCommand(),
      ],
      {encoding: 'utf8', maxBuffer: 100 * 1024 * 1024},
    );
    const text = [
      `ZERO_COPY_PIPELINE_RUN_META ${JSON.stringify(meta)}`,
      result.stdout ?? '',
      result.stderr ?? '',
      `ZERO_COPY_PIPELINE_EXIT ${JSON.stringify({status: result.status, signal: result.signal, error: result.error?.message})}`,
    ].join('\n');
    await writeFile(output, text);
    if (result.status !== 0) {
      throw new Error(`Docker run failed: ${output}`);
    }
    const benchmarkResult = parseLine(text, 'ZERO_COPY_PIPELINE_RESULT ');
    const cgroup = parseLine(text, 'ZERO_COPY_PIPELINE_CGROUP ');
    if (!benchmarkResult || !cgroup) {
      throw new Error(`Missing benchmark protocol: ${output}`);
    }
    const measurement = benchmarkResult.phases.records.find(record =>
      record.message.includes('Synced initial-sync phase measurement'),
    )?.data;
    if (measurementEnabled !== Boolean(measurement)) {
      throw new Error(`Unexpected measurement state: ${output}`);
    }
    if (measurement) {
      validateMeasurement(measurement, output);
    }
    completed.push({meta, result: benchmarkResult, measurement, cgroup});
  }
} finally {
  spawnSync('docker', ['rm', '--force', postgres], {encoding: 'utf8'});
  spawnSync('docker', ['network', 'rm', network], {encoding: 'utf8'});
}

const report = {
  generatedAt: new Date().toISOString(),
  mode,
  platform: 'linux/arm64',
  topology: 'direct-docker-bridge',
  image,
  imageID,
  runs: completed,
};
await writeFile(
  join(outputRoot, `results-${mode}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      mode,
      runs: completed.length,
      measuredRuns: completed.filter(run => run.measurement).length,
      imageID,
    },
    null,
    2,
  ),
);

function validateMeasurement(measurement, output) {
  const sync = measurement.initialSync;
  const epsilon = 0.01;
  assertNear(
    sync.copyWallMs,
    sync.destinationProcessingMs + sync.sourceOrEventLoopResidualMs,
    epsilon,
    `copy accounting in ${output}`,
  );
  assertNear(
    sync.destinationProcessingMs,
    sync.sqliteFlushMs + sync.nonFlushProcessingMs,
    epsilon,
    `processing accounting in ${output}`,
  );
  assertNear(
    sync.totalMs,
    sync.setupMs +
      sync.copyWallMs +
      sync.indexMs +
      sync.replicaRegistrationMs +
      sync.unclassifiedMs,
    epsilon,
    `initial-sync accounting in ${output}`,
  );
  assertNear(
    measurement.migrationWallMs,
    sync.totalMs +
      measurement.transactionCommitMs +
      measurement.analyzeMs +
      measurement.migrationOtherMs,
    epsilon,
    `migration accounting in ${output}`,
  );
  if (
    sync.sourceOrEventLoopResidualMs < -epsilon ||
    sync.nonFlushProcessingMs < -epsilon
  ) {
    throw new Error(`Negative measurement residual in ${output}`);
  }
}

function assertNear(actual, expected, epsilon, label) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${label}: ${actual} != ${expected}`);
  }
}

function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync(
      'docker',
      ['exec', container, 'pg_isready', '-U', 'postgres'],
      {encoding: 'utf8'},
    );
    if (result.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('Postgres did not become ready');
}

function linuxCommand() {
  const cgroupScript = String.raw`
    const fs = require('node:fs');
    const read = name => fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();
    const pairs = value => Object.fromEntries(value.split(/\n/).filter(Boolean).map(line => {
      const [key, number] = line.split(/\s+/);
      return [key, Number(number)];
    }));
    const pressure = value => Object.fromEntries(value.split(/\n/).filter(Boolean).map(line => {
      const [kind, ...fields] = line.split(/\s+/);
      return [kind, Object.fromEntries(fields.map(field => {
        const [key, number] = field.split('=');
        return [key, Number(number)];
      }))];
    }));
    console.log('ZERO_COPY_PIPELINE_CGROUP ' + JSON.stringify({
      memoryPeakBytes: Number(read('memory.peak')),
      memoryCurrentBytes: Number(read('memory.current')),
      memoryMax: read('memory.max'),
      memoryEvents: pairs(read('memory.events')),
      memoryStat: pairs(read('memory.stat')),
      memoryPressure: pressure(read('memory.pressure')),
      ioPressure: pressure(read('io.pressure')),
      ioStat: read('io.stat'),
    }));
  `;
  return [
    'status=0',
    '/usr/bin/time -v ./node_modules/.bin/vitest run --config vitest.config.bench.pg.ts -t "initial sync copy pipeline investigation" || status=$?',
    `node --input-type=commonjs -e ${shellQuote(cgroupScript)}`,
    'exit $status',
  ].join('; ');
}

function parseLine(text, prefix) {
  const line = text.split('\n').find(candidate => candidate.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : undefined;
}

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', stdio: 'inherit'});
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
  return result.stdout;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
