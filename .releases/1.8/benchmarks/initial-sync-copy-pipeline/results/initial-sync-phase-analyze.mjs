import fs from 'node:fs';

const root =
  '/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/initial-sync-phase-measurement';
const reports = [
  'overhead',
  'full',
  'narrow',
  'imports1cpu',
  'imports1cpu3g',
].map(mode =>
  JSON.parse(fs.readFileSync(`${root}/results-${mode}.json`, 'utf8')),
);
const measuredRuns = reports.flatMap(report => report.runs).filter(run =>
  Boolean(run.measurement),
);
const profiles = [...new Set(measuredRuns.map(run => run.meta.runConfig.profile))];

const analysis = {
  generatedAt: new Date().toISOString(),
  overhead: analyzeOverhead(reports.find(report => report.mode === 'overhead')),
  profiles: Object.fromEntries(
    profiles.map(profile => [
      profile,
      analyzeProfile(
        measuredRuns.filter(run => run.meta.runConfig.profile === profile),
      ),
    ]),
  ),
};

fs.writeFileSync(`${root}/analysis.json`, `${JSON.stringify(analysis, null, 2)}\n`);
console.log(JSON.stringify(analysis, null, 2));

function analyzeOverhead(report) {
  const output = {};
  for (const profile of [...new Set(report.runs.map(run => run.meta.runConfig.profile))]) {
    const runs = report.runs.filter(run => run.meta.runConfig.profile === profile);
    output[profile] = Object.fromEntries(
      ['callbackMs', 'copyMs', 'flushMs', 'indexMs', 'outerMs', 'rawCopyMs'].map(
        metric => {
          const disabled = runs.filter(
            run => run.meta.runConfig.treatment === 'disabled',
          );
          const enabled = runs.filter(
            run => run.meta.runConfig.treatment === 'enabled',
          );
          const ratios = [];
          for (let repetition = 1; repetition <= 10; repetition++) {
            const before = disabled.find(
              run => run.meta.runConfig.repetition === repetition,
            );
            const after = enabled.find(
              run => run.meta.runConfig.repetition === repetition,
            );
            ratios.push(metricValue(after, metric) / metricValue(before, metric));
          }
          const disabledMedian = median(disabled.map(run => metricValue(run, metric)));
          const enabledMedian = median(enabled.map(run => metricValue(run, metric)));
          return [
            metric,
            {
              disabledMedian,
              enabledMedian,
              medianChangePct: percent(enabledMedian / disabledMedian - 1),
              pairedChangePct: percent(median(ratios) - 1),
            },
          ];
        },
      ),
    );
  }
  return output;
}

function analyzeProfile(runs) {
  const stageValues = runs.map(run => exclusiveStages(run.measurement));
  const stageNames = Object.keys(stageValues[0]);
  const migrationWall = runs.map(run => run.measurement.migrationWallMs);
  const sync = runs.map(run => run.measurement.initialSync);
  const dominant = runs.map(run =>
    [...run.measurement.tableCopies].sort((a, b) => b.copyBytes - a.copyBytes)[0],
  );
  const indexNames = runs[0].measurement.indexes.map(index => index.index);
  const rawBytes = runs.map(run => run.result.rawCopy.bytes);
  const copyBytes = runs.map(run => run.result.phases.summary.copyBytes);
  const ioReadBytes = runs.map(run => linuxDelta(run, 'ioStat', 'rbytes'));
  const ioWriteBytes = runs.map(run => linuxDelta(run, 'ioStat', 'wbytes'));

  return {
    n: runs.length,
    rows: runs[0].result.rows,
    copyBytes: summary(copyBytes),
    sqliteFileBytes: summary(runs.map(run => run.result.sqlite.fileBytes)),
    migrationWallMs: summary(migrationWall),
    stages: Object.fromEntries(
      stageNames.map(name => [
        name,
        {
          ...summary(stageValues.map(stages => stages[name])),
          sharePct: summary(
            stageValues.map((stages, index) =>
              percent(stages[name] / migrationWall[index]),
            ),
          ),
        },
      ]),
    ),
    setup: Object.fromEntries(
      Object.keys(sync[0].setup).map(name => [
        name,
        summary(sync.map(value => value.setup[name])),
      ]),
    ),
    source: {
      rawCopyMs: summary(runs.map(run => run.result.rawCopy.ms)),
      rawCopyMBps: summary(
        runs.map(run => run.result.rawCopy.throughputMBps),
      ),
      pipelineCopyMBps: summary(
        runs.map(
          run =>
            run.result.phases.summary.copyBytes /
            run.measurement.initialSync.copyWallMs /
            1000,
        ),
      ),
      rawToPipelineRatio: summary(
        runs.map(
          run =>
            run.result.rawCopy.ms /
            run.measurement.initialSync.copyWallMs,
        ),
      ),
    },
    cpu: Object.fromEntries(
      Object.keys(sync[0].cpu).map(name => [
        name,
        {
          totalMs: summary(sync.map(value => value.cpu[name].totalMs)),
          userMs: summary(sync.map(value => value.cpu[name].userMs)),
          systemMs: summary(sync.map(value => value.cpu[name].systemMs)),
          cpuToWallRatio:
            name === 'total'
              ? summary(
                  sync.map(value => value.cpu.total.totalMs / value.totalMs),
                )
              : undefined,
        },
      ]),
    ),
    dominantTable: {
      table: dominant[0].table,
      elapsedMs: summary(dominant.map(value => value.elapsedMs)),
      preStreamMs: summary(dominant.map(value => value.preStreamMs)),
      streamMs: summary(dominant.map(value => value.streamMs)),
      destinationProcessingMs: summary(
        dominant.map(value => value.destinationProcessingMs),
      ),
      sqliteFlushMs: summary(dominant.map(value => value.sqliteFlushMs)),
      nonFlushProcessingMs: summary(
        dominant.map(value => value.nonFlushProcessingMs),
      ),
      sourceOrEventLoopResidualMs: summary(
        dominant.map(value => value.sourceOrEventLoopResidualMs),
      ),
      copyChunks: summary(dominant.map(value => value.copyChunks)),
      flushCount: summary(dominant.map(value => value.flushCount)),
      insertStatementCount: summary(
        dominant.map(value => value.insertStatementCount),
      ),
    },
    indexes: indexNames.map((name, index) => {
      const values = runs.map(run => run.measurement.indexes[index]);
      return {
        index: name,
        table: values[0].table,
        columns: values[0].columns,
        elapsedMs: summary(values.map(value => value.elapsedMs)),
        cpuMs: summary(values.map(value => value.cpu.totalMs)),
        cpuToWallRatio: summary(
          values.map(value => value.cpu.totalMs / value.elapsedMs),
        ),
      };
    }),
    resources: {
      peakRssBytes: summary(runs.map(run => run.result.peakRssBytes)),
      peakHeapUsedBytes: summary(
        runs.map(run => run.result.peakHeapUsedBytes),
      ),
      peakExternalBytes: summary(
        runs.map(run => run.result.peakExternalBytes),
      ),
      cgroupPeakBytes: summary(runs.map(run => run.cgroup.memoryPeakBytes)),
      memoryMaxEvents: summary(
        runs.map(run => linuxDelta(run, 'memoryEvents', 'max')),
      ),
      oomEvents: summary(runs.map(run => linuxDelta(run, 'memoryEvents', 'oom'))),
      majorPageFaults: summary(
        runs.map(run => run.result.resourceUsage.majorPageFault),
      ),
      pageScans: summary(
        runs.map(run => linuxDelta(run, 'memoryStat', 'pgscan')),
      ),
      ioReadBytes: summary(ioReadBytes),
      ioReadToSqliteFileRatio: summary(
        ioReadBytes.map(
          (bytes, index) => bytes / runs[index].result.sqlite.fileBytes,
        ),
      ),
      ioWriteBytes: summary(ioWriteBytes),
      ioWriteToSqliteFileRatio: summary(
        ioWriteBytes.map(
          (bytes, index) => bytes / runs[index].result.sqlite.fileBytes,
        ),
      ),
      ioPressureFullMs: summary(
        runs.map(run =>
          microsecondsToMilliseconds(
            linuxDeltaNested(run, 'ioPressure', 'full', 'total'),
          ),
        ),
      ),
      memoryPressureFullMs: summary(
        runs.map(run =>
          microsecondsToMilliseconds(
            linuxDeltaNested(run, 'memoryPressure', 'full', 'total'),
          ),
        ),
      ),
      gcCount: summary(runs.map(run => run.result.gc.count)),
      gcMs: summary(runs.map(run => run.result.gc.ms)),
      eventLoopUtilization: summary(
        runs.map(run => run.result.eventLoopUtilization.utilization),
      ),
    },
    correctness: {
      copyBytesStable: new Set(copyBytes).size === 1,
      rawBytesStable: new Set(rawBytes).size === 1,
      noOom: runs.every(
        run =>
          run.cgroup.memoryEvents.oom === 0 &&
          run.cgroup.memoryEvents.oom_kill === 0,
      ),
    },
  };
}

function exclusiveStages(measurement) {
  const sync = measurement.initialSync;
  return {
    setupMs: sync.setupMs,
    copySqliteFlushMs: sync.sqliteFlushMs,
    copyNonFlushProcessingMs: sync.nonFlushProcessingMs,
    copySourceOrEventLoopResidualMs: sync.sourceOrEventLoopResidualMs,
    indexMs: sync.indexMs,
    replicaRegistrationMs: sync.replicaRegistrationMs,
    initialSyncUnclassifiedMs: sync.unclassifiedMs,
    transactionCommitMs: measurement.transactionCommitMs,
    analyzeMs: measurement.analyzeMs,
    migrationOtherMs: measurement.migrationOtherMs,
  };
}

function metricValue(run, metric) {
  return {
    callbackMs: run.result.timing.callbackMs,
    copyMs: run.result.phases.summary.copyMs,
    flushMs: run.result.phases.summary.flushMs,
    indexMs: run.result.phases.summary.indexMs,
    outerMs: run.result.timing.outerMs,
    rawCopyMs: run.result.rawCopy.ms,
  }[metric];
}

function linuxDelta(run, section, field) {
  return (
    run.result.linuxDiagnostics.after[section][field] -
    run.result.linuxDiagnostics.before[section][field]
  );
}

function linuxDeltaNested(run, section, subsection, field) {
  return (
    run.result.linuxDiagnostics.after[section][subsection][field] -
    run.result.linuxDiagnostics.before[section][subsection][field]
  );
}

function microsecondsToMilliseconds(value) {
  return value / 1000;
}

function summary(input) {
  const values = [...input].sort((a, b) => a - b);
  return {
    median: median(values),
    min: values[0],
    max: values.at(-1),
  };
}

function median(input) {
  const values = [...input].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function percent(value) {
  return value * 100;
}
