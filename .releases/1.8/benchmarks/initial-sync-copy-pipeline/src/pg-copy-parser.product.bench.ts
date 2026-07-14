import {expect, test} from 'vitest';
import {BigIntJSON} from '../../shared/src/bigint-json.ts';
import {BinaryCopyParser} from './db/pg-copy-binary.ts';

const profile = process.env.ZERO_COPY_PIPELINE_PROFILE ?? 'manual';
const runLabel =
  process.env.ZERO_COPY_PIPELINE_RUN_LABEL ?? `manual-${process.pid}`;
const fieldBytes = envInteger('ZERO_COPY_PIPELINE_FIELD_BYTES', 276_480, 1);
const chunkBytes = envInteger('ZERO_COPY_PIPELINE_CHUNK_BYTES', 5_632, 1);
const columns = envInteger('ZERO_COPY_PIPELINE_COLUMNS', 7, 1);
const rows = envInteger('ZERO_COPY_PIPELINE_ROWS', 64, 1);
const warmups = envInteger('ZERO_COPY_PIPELINE_WARMUPS', 1, 0);
const iterations = envInteger('ZERO_COPY_PIPELINE_ITERATIONS', 5, 1);

test('initial sync copy parser investigation', () => {
  const stream = buildCopyStream(fieldBytes, columns, rows);
  const chunks = fixedChunks(stream, chunkBytes);
  const expectedFields = columns * rows;
  const expectedPayloadBytes = rows * (fieldBytes + (columns - 1) * 16);
  const samples: Record<string, unknown>[] = [];

  for (let iteration = 0; iteration < warmups + iterations; iteration++) {
    const parser = new BinaryCopyParser();
    const resourcesBefore = process.resourceUsage();
    const cpuBefore = process.cpuUsage();
    let fields = 0;
    let payloadBytes = 0;
    let checksum = 0;
    let peakRssBytes = process.memoryUsage().rss;
    const start = performance.now();

    for (const chunk of chunks) {
      for (const field of parser.parse(chunk)) {
        fields++;
        if (field !== null) {
          payloadBytes += field.length;
          checksum =
            (checksum +
              field.length +
              (field[0] ?? 0) +
              (field.at(-1) ?? 0)) >>>
            0;
        }
      }
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }

    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuBefore);
    const resources = subtractNumericRecords(
      process.resourceUsage(),
      resourcesBefore,
    );
    expect(fields).toBe(expectedFields);
    expect(payloadBytes).toBe(expectedPayloadBytes);

    if (iteration >= warmups) {
      samples.push({
        wallMs,
        cpuUserMs: cpu.user / 1_000,
        cpuSystemMs: cpu.system / 1_000,
        throughputMBps: stream.length / 1_000_000 / (wallMs / 1_000),
        fields,
        payloadBytes,
        checksum,
        peakRssBytes,
        resourceUsage: resources,
        assemblyStats:
          'assemblyStats' in parser
            ? (parser as BinaryCopyParser & {assemblyStats: unknown})
                .assemblyStats
            : undefined,
      });
    }
  }

  emitResult({
    kind: 'parser',
    profile,
    runLabel,
    fieldBytes,
    chunkBytes,
    columns,
    rows,
    streamBytes: stream.length,
    chunks: chunks.length,
    averageChunkBytes: stream.length / chunks.length,
    warmups,
    iterations,
    samples,
  });
});

function buildCopyStream(
  largeFieldBytes: number,
  columnCount: number,
  rowCount: number,
) {
  const header = Buffer.from([
    0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00, 0, 0, 0,
    0, 0, 0, 0, 0,
  ]);
  const trailer = Buffer.alloc(2);
  trailer.writeInt16BE(-1);
  const large = patternedBuffer(largeFieldBytes, 17);
  const small = patternedBuffer(16, 29);
  const row = tuple([
    large,
    ...Array.from({length: columnCount - 1}, () => small),
  ]);
  return Buffer.concat([
    header,
    ...Array.from({length: rowCount}, () => row),
    trailer,
  ]);
}

function tuple(fields: readonly Buffer[]) {
  const count = Buffer.alloc(2);
  count.writeInt16BE(fields.length);
  const parts: Buffer[] = [count];
  for (const field of fields) {
    const length = Buffer.alloc(4);
    length.writeInt32BE(field.length);
    parts.push(length, field);
  }
  return Buffer.concat(parts);
}

function patternedBuffer(size: number, seed: number) {
  const buffer = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index++) {
    buffer[index] = (index * 31 + seed) & 0xff;
  }
  return buffer;
}

function fixedChunks(data: Buffer, size: number) {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += size) {
    chunks.push(data.subarray(offset, offset + size));
  }
  return chunks;
}

function subtractNumericRecords(afterValue: object, beforeValue: object) {
  const after = afterValue as Record<string, number>;
  const before = beforeValue as Record<string, number>;
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      value - (before[key] ?? 0),
    ]),
  );
}

function envInteger(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer >= ${minimum}; got ${process.env[name]}`,
    );
  }
  return value;
}

function emitResult(result: Record<string, unknown>) {
  console.log(`ZERO_COPY_PIPELINE_RESULT ${BigIntJSON.stringify(result)}`);
}
