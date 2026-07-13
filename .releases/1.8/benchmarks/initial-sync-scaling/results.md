# Focused Initial Sync Scaling Results

- 10 sequential, paired rounds per configuration and size
- Four table-copy workers
- Throughput is deterministic fixture payload in decimal MB/s
- Parentheses show median elapsed initial-sync time
- Ratios above `1.0` mean the newer/first-named configuration is faster
- Brackets show paired-round bootstrap 95% intervals for the median ratio

| Payload | Zero 0.22 text | Zero 1.0 text | Zero 1.8 binary | Zero 1.8 text |
| --- | ---: | ---: | ---: | ---: |
| 40 MB | 82.3 MB/s (0.48 s) | 75.9 MB/s (0.52 s) | 83.1 MB/s (0.48 s) | 74.5 MB/s (0.53 s) |
| 400 MB | 108.5 MB/s (3.64 s) | 106.4 MB/s (3.71 s) | 125.4 MB/s (3.15 s) | 106.1 MB/s (3.72 s) |
| 1.2 GB | 70.5 MB/s (16.81 s) | 67.9 MB/s (17.46 s) | 79.8 MB/s (14.85 s) | 69.5 MB/s (17.06 s) |

## Paired Speedups

| Payload | 1.0 vs 0.22 | 1.8 binary vs 0.22 | 1.8 binary vs 1.0 | 1.8 binary vs text |
| --- | ---: | ---: | ---: | ---: |
| 40 MB | 0.92x [0.90, 0.94] | 1.01x [0.96, 1.04] | 1.10x [1.06, 1.12] | 1.12x [1.10, 1.15] |
| 400 MB | 0.98x [0.92, 1.04] | 1.16x [1.12, 1.22] | 1.19x [1.14, 1.25] | 1.17x [1.12, 1.25] |
| 1.2 GB | 0.98x [0.95, 1.01] | 1.13x [1.12, 1.16] | 1.18x [1.14, 1.18] | 1.15x [1.13, 1.19] |

## Piecewise Scaling

The 40-400 MB segment estimates fixed startup cost plus unconstrained marginal throughput. The 400 MB-1.2 GB segment shows throughput after the local workload enters a slower scaling regime.

| Configuration | Estimated Fixed Cost | 40-400 MB Marginal Throughput | 400 MB-1.2 GB Marginal Throughput |
| --- | ---: | ---: | ---: |
| Zero 0.22 | 0.129 s | 112.5 MB/s | 60.0 MB/s |
| Zero 1.0 | 0.166 s | 111.4 MB/s | 57.5 MB/s |
| Zero 1.8 binary | 0.178 s | 132.9 MB/s | 67.6 MB/s |
| Zero 1.8 text | 0.176 s | 111.3 MB/s | 59.2 MB/s |

A single linear fit across all three sizes has a negative intercept for every configuration, so it is retained in `aggregate.json` only as a diagnostic and must not be interpreted as fixed startup cost.

## Dispersion

| Payload | Configuration | Median | Min-Max | CV |
| --- | --- | ---: | ---: | ---: |
| 40 MB | Zero 0.22 | 82.3 MB/s | 79.7-87.0 MB/s | 2.3% |
| 40 MB | Zero 1.0 | 75.9 MB/s | 74.0-79.7 MB/s | 2.3% |
| 40 MB | Zero 1.8 binary | 83.1 MB/s | 78.0-86.7 MB/s | 3.2% |
| 40 MB | Zero 1.8 text | 74.5 MB/s | 68.2-78.3 MB/s | 4.6% |
| 400 MB | Zero 0.22 | 108.5 MB/s | 89.9-114.2 MB/s | 6.9% |
| 400 MB | Zero 1.0 | 106.4 MB/s | 99.4-111.9 MB/s | 4.6% |
| 400 MB | Zero 1.8 binary | 125.4 MB/s | 107.7-133.5 MB/s | 6.2% |
| 400 MB | Zero 1.8 text | 106.1 MB/s | 96.3-112.0 MB/s | 4.6% |
| 1.2 GB | Zero 0.22 | 70.5 MB/s | 65.2-73.5 MB/s | 3.8% |
| 1.2 GB | Zero 1.0 | 67.9 MB/s | 67.0-73.0 MB/s | 2.9% |
| 1.2 GB | Zero 1.8 binary | 79.8 MB/s | 71.8-83.4 MB/s | 4.1% |
| 1.2 GB | Zero 1.8 text | 69.5 MB/s | 65.1-71.2 MB/s | 2.8% |

