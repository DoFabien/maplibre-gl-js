# Standard Bing benchmark fixture

`4-12-6.mlt` and `../../bing/4-12-6.mvt` are the unmodified expected/input
pair from the `maplibre-tile-spec` Bing corpus.

The standard MLT fixture is generated without FastPFOR. Benchmark setup scans
the physical stream metadata and fails if a `FAST_PFOR` stream is found.

SHA-256:

- MVT: `b056a3da02b708cd0cfa98d82c1ac449e23121ee8c3397b4af172a67f2b07944`
- MLT: `e9ef4ed749fc0da897ad530a518f44799d455dc2afd7c4e279df77b5e96eeef7`
