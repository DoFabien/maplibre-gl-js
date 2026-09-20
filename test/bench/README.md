# Benchmarks

## Continuous MVT/MLT navigation

`e2e/mlt-navigation.ts` compares a real-time Dortmund pan/zoom/overzoom journey,
including road/place/POI labels and icons, with ordinary caches and label fades.
It separates fresh-context initial loading, a first pass and an immediate warm
repeat. Gzip is actually served over HTTP, optionally through a shared 20 Mbit/s,
40 ms network model. Public feature queries and pixel readback run only in a
separate parity mode, never in timing sessions. See the
[navigation protocol and results](baselines/MLT_NAVIGATION_20260908.md).

Benchmarks help us catch performance regressions and improve performance.

There are two kinds of benchmarks in this repository:

* **Micro benchmarks** live next to the code they measure as `src/**/*.bench.ts` files and run under [Vitest bench mode](https://vitest.dev/guide/features.html#benchmarking). They answer "did my change make this code path faster on my machine, right now" while you work on it.
* **End-to-end benchmarks** under `test/bench/e2e/` load real production artifacts (your `dist/` build, a release from the CDN) in headless Chrome and time a map through the public API. They answer "did the library get slower between versions".

## Local benchmark artifacts

Keep large local campaign outputs under the sibling `../wFabien/` directory,
outside this Git checkout, for example with `--output ../wFabien/bench-runs/<run>`.
The generated benchmark viewer bundles and `test/bench/results/` are ignored.
Selected baseline reports, summaries and source fixtures remain versioned.

On 13 September 2026, the untracked baseline evidence and benchmark results were
moved to `../wFabien/bench-artifacts-20260913/maplibre-gl-js/`, preserving their
repository-relative paths. Its `manifest.json` records the original paths,
sizes and SHA-256 hashes; its `README.md` explains selective restoration.
The archive contains local evidence, not a complete source checkout.

Historical reports retain their original artifact paths and hashes. Restore
the required raw files to those paths before running their verifiers; changing
the saved paths or hashes would alter the recorded evidence. New campaigns can
write directly to `wFabien` and record that location from the start.

## Native MLT mesh experiment

For the native MLT mesh experiment, see
[MLT_PRETRIANGULATED_FILL_20260908.md](baselines/MLT_PRETRIANGULATED_FILL_20260908.md).
The existing Berlin fixtures already contain triangle streams. The experiment
compares the same tile bytes against the frozen pre-change renderer, not new
tiles against a different corpus. It shows a native improvement and fewer
estimated allocations. The [warm-overzoom recheck](baselines/MLT_OVERZOOM_RECHECK_20260913.md)
identifies and removes redundant mesh eligibility probes; the historical slowdown
is not reproduced consistently, and the correction has no established overall latency gain.
`generate-mlt-pretriangulated.mjs <new-directory>` audits Java encoding provenance;
`mlt-pretriangulated-certify.mjs` verifies the saved experiment evidence.

## Micro benchmarks

Run all micro benchmarks:

```bash
npm run bench
```

Run a single file, or only the benchmark tests matching a name:

```bash
npm run bench -- src/render/subdivision.bench.ts
npm run bench -- -t coveringTiles
```

To measure a change, record a baseline before it and read that baseline back after. Add `writeResult` to the benchmark you are working on and run it on `main`:

```ts
test('subdividePolygon', async ({bench}) => {
    await bench('subdividePolygon', {writeResult: './bench-baseline.json'}, () => {
        subdividePolygon(polygon, tileID, granularity, true);
    }).run();
});
```

```bash
git checkout main && npm run bench -- src/render/subdivision.bench.ts
```

Then compare your branch against the recorded file with `bench.from()`:

```ts
test('subdividePolygon', async ({bench}) => {
    await bench.compare(
        bench.from('baseline', './bench-baseline.json'),
        bench('subdividePolygon', () => {
            subdividePolygon(polygon, tileID, granularity, true);
        }),
    );
});
```

```bash
git checkout your-branch && npm run bench -- src/render/subdivision.bench.ts
```

`bench.compare()` runs both entries in one table and marks the fastest, so a single run shows the before/after difference. If your PR claims a performance effect, paste that table into the PR description, along with the `writeResult`/`bench.from()` edit you used, so reviewers can reproduce it. Drop that edit again before committing.

Results are only comparable on the same machine in the same session: identical code routinely drifts a few percent between runs, so treat small deltas as noise. Vitest also runs the source through its own transform rather than the production build, which makes micro benchmark numbers useful for relative comparison but not as absolute production numbers.

To write a micro benchmark, create a `*.bench.ts` file next to the code you are measuring. Benchmarks are registered inside a regular `test()` through the `bench` fixture, and a single benchmark is started with `.run()`:

```ts
import {test} from 'vitest';
import {subdividePolygon} from './subdivision.ts';

test('subdividePolygon', async ({bench}) => {
    await bench('subdividePolygon', () => {
        subdividePolygon(polygon, tileID, granularity, true);
    }).run();
});
```

Benchmarks that belong together go through `bench.compare()` instead, which runs them with interleaved iterations and prints them as one table:

```ts
test('coveringTiles', async ({bench}) => {
    await bench.compare(
        bench('mercator', () => {
            coverWithPitch(new MercatorTransform(), 0);
        }),
        bench('globe', () => {
            coverWithPitch(new GlobeTransform(), 0);
        }),
    );
});
```

Keep setup work (building fixtures, parsing data) at module level so the measured call is the only thing inside `bench()`. See `src/geo/projection/covering_tiles.bench.ts` and `src/render/subdivision.bench.ts` for examples.

### Isolated MLT pipeline benchmarks

The MLT runner separates scanning, decoding, parse-only work and the full worker pipeline. Each requested case runs in a fresh Node process so decoded tiles and synthetic corpora from another case cannot affect its heap measurements:

```bash
npm run bench:mlt-isolated -- --iterations 30 --warmup 10 \
  --output /tmp/mlt-benchmark.json \
  MltRealTileScanMLT \
  MltRealTileDecodeMLTProjected \
  MltRealTileParseOnlyMLTNative \
  MltRealTileEndToEndMLT
```

With no benchmark names, the runner executes the core MVT/MLT matrix. It covers the `fill`, `line`, `circle`, `fill-extrusion`, point-symbol and line-symbol buckets separately, in addition to scan/decode/end-to-end phases, OMT corpora, the standard Bing corpus, a separate physically validated FastPFOR fixture, queries, feature-state, overzoom, transfer strategies, the 5/50/200-column matrix and the full memory lifecycle. Use `--suite extended` to include the line-symbol stress matrix, query access modes and 10,000-result workloads required by the current budget configuration.

The default 30 measured iterations prevent p95 from collapsing to the single slowest sample; percentiles use R7 linear interpolation after 10 warmups. Reports retain every duration sample as well as median/p95 duration, observed and retained heap, total and per-iteration MLT materialization counters, commit, Node version, CPU and platform. Relative MLT/MVT budgets use an additional process per pair, alternating reference and candidate order on every iteration; the checker summarizes the 30 per-iteration MLT/MVT ratios instead of dividing two unrelated tail samples. Individual cases remain isolated for memory and materialization measurements. Short query cases execute 20 operations per sample and real decode corpus cases execute three decodes per sample to avoid timer- and CPU-frequency-dominated ratios. The budget checker rejects reports and baselines with fewer than 30 samples or 10 warmups per case. `Decode` forces layer getters; `DecodeFullAccess` also reads feature properties and geometry. `EndToEnd` starts from the tile buffer and includes decode, `WorkerTile.parse()` and worker serialization.

The current budget reference is [`mlt-next-observability-a236ec257.json`](./baselines/mlt-next-observability-a236ec257.json), selected by [`mlt-budgets.json`](./baselines/mlt-budgets.json). It contains 168 cases and 75 paired comparisons recorded with Node 26.7.0. [`MLT_V6_3_B3AA80EE8.md`](./baselines/MLT_V6_3_B3AA80EE8.md) describes an older reference, not the baseline used by the guard. Use the same Node version for historical comparisons; the guard rejects a different Node major. Run the full guard locally with:

```bash
npm run bench:mlt-isolated -- --suite extended --iterations 30 --warmup 10 \
  --output test/bench/results/mlt-current.json
npm run bench:mlt-check -- --report test/bench/results/mlt-current.json
```

For repeated measurements, run `npm run bench:mlt-campaigns -- --suite extended --campaigns 3 --iterations 30 --warmup 10 --output-dir <new-directory>`. By default a budget failure stops the campaign runner. To retain all three campaigns even when budgets fail, use `--skip-check` during collection, then run `bench:mlt-check` separately on **every** report and retain each exit status. Skipping collection-time checks is not a passing budget result.

The [September 2026 post-merge measurements](./baselines/MLT_POST_MERGE_20260906.md) record the pinned implementation, runtime, individual campaign results and outstanding checks. Heap/RSS values include the isolated Node process and benchmark harness, not only tile data or browser rendering. `worktreeDirty` also counts untracked benchmark artifacts: inspect tracked source changes separately when identifying the measured implementation.

The [final-snapshot qualification](./baselines/MLT_FINAL_QUALIFICATION_20260906.md) repeats the full extended matrix on `cfb9f34ae` and records CPU profiles, 1,000-cycle retention diagnostics with Vite and a standalone Node bundle, and a separate comparison of eager versus deferred public geometry decoding. These diagnostics do not replace the historical budget checks or browser product measurements.

Run `npm run bench:mlt-profile` for exclusive parse sub-phases. Rows marked `aggregate` are totals for context and must not be added together; rows marked `exclusive` sum to `parse.total`.

## End-to-end benchmarks

The e2e runner measures the real built library. It loads production `.mjs` artifacts in headless Chrome, drives a map through the public API against fully local fixtures (style, tiles, glyphs, sprite; zero network), and reads the timeline through the map's own events: bundle import, style load, first tile, load, first idle.

Compare the latest release against your working copy (run `npm run build-dist` first):

```bash
npm run bench-e2e
```

Artifacts are positional: `dist` is the local build, `latest` resolves through unpkg, a bare version like `6.0.0` fetches that release, and any URL to a `maplibre-gl.mjs` is used as-is. `--runs N` controls samples per artifact (default 8):

```bash
npm run bench-e2e -- 6.0.0 dist --runs 16
```

Columns are labeled by each artifact's own reported version. With exactly two artifacts the table adds a delta column. Artifacts run sequentially on one machine, and the same-session noise caveat from micro benchmarks applies here unchanged.

### Paired MVT/MLT browser lifecycle

`e2e/mlt-lifecycle.ts` exercises the same production build with four local Berlin tiles,
one worker, an 800×600 viewport, and fill/line/circle/heatmap layers. It uses public map
APIs for three camera positions (including overzoom/pitch), source/rendered GeoJSON
queries, feature-state, `setTiles`, source removal/recreation, and map removal.

```bash
npm run build-prod
npm run build-css
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --output /tmp/mlt-browser-new-run
```

Defaults: three alternating MVT/MLT pairs, one unmeasured animated warmup and 30
measured cycles per session; separate memory sessions use five warmups and 100
non-animated cycles. `--runs`, `--cycles`, and `--memory-cycles` override those counts.
The output directory must not exist. The server binds only to loopback, serves a fixed
local allowlist without caching/compression, and uses CSP to disallow external traffic.

`--scenario symbols` keeps the base layers and adds point text/icons and street text
along lines, using the local Open Sans glyphs and sprite. Real POI labels are filtered
to `localrank <= 5`; collisions remain enabled. Three additional checkpoints exercise
symbol-only feature-state, reload and clearing, for ten checkpoints in total. Both
symbol layers must return visible features at every checkpoint, and PBF/sprite requests
are recorded. The map explicitly pins `pixelRatio: 1` and verifies an 800×600 canvas;
the host's reported `devicePixelRatio` may differ by floating-point rounding.
Maps are non-interactive: only the scripted public camera API drives them. Camera
coordinates/zoom/pitch/bearing are checked and archived so desktop input cannot
silently change the workload in a visible hardware-browser session.
The [symbol qualification report](baselines/MLT_SYMBOLS_20260906.md) records exact
ten-checkpoint parity and 160 animated cycles; noisy timings are retained without
claiming an overall performance improvement.

`--scenario styles --phase correctness` extends the symbol scenario to 25 checkpoints:
direct paint/layout/filter setters, `setStyle` diff, glyph/sprite URL changes, full
rebuild with `diff: false`, swapping vector encoding, removing/re-adding the source,
and style changes in overzoom. Source object identity and feature-state are checked
through public APIs: retained sources preserve state, replaced sources clear it.
Alternate glyph/sprite routes serve the same bytes and must trigger new requests.
Three additional five-mutation cycles run by default (`--style-cycles` overrides this),
checking full query signatures after every mutation without additional screenshots.
This scenario is correctness-only: no style-change performance or memory claim is made.
The historical [style qualification report](baselines/MLT_STYLES_20260907.md) records
exact GPU parity but a failing SwiftShader final frame. The subsequent
[idle investigation](baselines/MLT_IDLE_20260907.md) reduces this to a camera round
trip: symbol-fade tile cleanup changed placement inputs after drawing without
requesting another frame. The renderer now repaints after actual cleanup, before
emitting `idle`; software style checkpoints are exact without relaxing any assertion.

`mlt-render-isolation.ts --journeys repaint,camera --read-idle --assert-stable --runs 2
--output <new-directory>` captures the terminal screenshot before explicitly requesting
another frame, plus raw WebGL pixels during `render`. Without `--assert-stable`,
`diagnostic-complete` records observations and does not claim parity. Layer ablation
(`--layers background,poi-labels`) is restricted to camera/repaint journeys.

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --scenario styles --phase correctness \
  --style-cycles 5 --output <new-style-directory>
```

Add `--strict` for the separately built instrumented worker, and repeat with
`PUPPETEER_GPU=software`. Both session orders exercise both encodings during the
swap; a session labelled `mvt` is therefore not a pure-MVT strict-counter control.
Validate all three archives, plus fresh symbol/base regressions and the unit report:

```bash
node test/bench/e2e/mlt-styles-validate.mjs \
  <production-directory> <strict-gpu-directory> <strict-software-directory> \
  <unit.json> <symbols-results.json> <base-results.json>
```

The validator's `--record-render-failures` option archives exact mismatch diagnostics
but **still exits with code 1**. An optional seventh path includes a repeat software
campaign. All query/state/resource/counter checks remain mandatory.

### First-overzoom latency with a fresh worker

`mlt-first-overzoom-browser.ts` compares a frozen production build with the current
one over twelve balanced rotations of before/after × MVT/MLT. Every observation
uses a fresh map and worker: changing URLs alone does not bypass a content-addressed
geometry cache. Native map/style setup is excluded. It records the first loaded
draw submission, then complete public queries separately, with PNG/GeoJSON archives.
This is not GPU completion/presentation timing or a warmed-cache benchmark.

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-first-overzoom-browser.ts --runs 12 \
  --reference <frozen-dist-directory> --output <new-output-directory>
node test/bench/e2e/mlt-first-overzoom-browser.ts --verify <output-directory>
```

The verifier recomputes all query/image comparisons, input hashes and execution
order. Runs must be a multiple of four and at least twelve. Performance campaigns
must run without concurrent builds, tests or other browser campaigns.

### Globe and terrain correctness

`mlt-geography.ts` adds 23 deterministic checkpoints: local terrain lifetime and
reloads, exaggeration, world Mercator/50%-blend/globe, globe terrain, rotation and
exact restoration. It uses the existing Berlin and z0 MVT/MLT pairs, local glyphs
and sprites, and five generated **synthetic** non-flat Mapbox RGB DEM tiles. They
are not measured topography. A non-drawing custom layer observes the real projection
uniform; public APIs check camera, vector source identity, feature-state, elevation
and complete query results. Every checkpoint has a PNG and compressed full GeoJSON.
Additional cycles check queries/state after nine mutations each, without more PNGs.

```bash
npm run build-prod
BUILD=production npx rolldown -c rolldown.config.mlt-validation.ts
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-geography.ts --cycles 2 --output <new-geography-directory>
```

Repeat with `--strict`, then with `PUPPETEER_GPU=software` and `--strict`. Use Node,
not vite-node: browser-evaluated functions must retain native dynamic imports.
The runner never tolerates pixel differences. This is correctness-only, not a
benchmark of subdivision cost, animation, real gestures or GPU memory.
The [geography report](baselines/MLT_GEOGRAPHY_20260907.md) records projection and
columnar subdivision fixes, before/after evidence, final campaigns and the arguments
for `mlt-geography-validate.mjs`, which independently verifies the archives.

### Native input and animated-frame correctness

`mlt-motion.ts` extends that corpus with eight mouse/keyboard journeys and four
two-second animations. Puppeteer/CDP inputs are browser-trusted and use the real
handlers; they are not physical-device tests. Each journey runs in both encodings.
Actual render buffers and full GeoJSON are archived at the final pose and at three
distinct loaded intermediate frames per animation. The observed pose is then
replayed in the other encoding: PNG and query equality remain exact, with only a
1e-9 tolerance for public camera setter/getter round-trips. Native trajectories
are not asserted identical. Loading frames are separate diagnostics, not successes.

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-motion.ts --output <new-motion-directory>
```

Repeat with `--strict`, then `PUPPETEER_GPU=software --strict --runs 2`. Run these
campaigns **sequentially**, without another heavy browser suite: missing three
loaded frames is a coverage failure. `--only` accepts comma-separated journey names.
`--self-reference --only globe-terrain-orbit,globe-terrain-flight` runs same-encoding
controls, not MVT/MLT qualification. Use Node directly, not vite-node.

Moving terrain zoom retains history-dependent drape textures. Its intermediate
frames differ even in MVT-to-MVT replay at an identical pose; static replay is not
an exact oracle for those frames. The runner collects all image comparisons but
**exits 1 on any difference**, without pixel tolerance or cache changes. The
[motion report](baselines/MLT_MOTION_20260907.md) documents this partial qualification,
the common wheel-event provenance fix, and `mlt-motion-validate.mjs` arguments.
The independent validator also exits 1 while retaining all non-exact comparisons.
Render-buffer/query capture is intrusive: these are not FPS, latency or GPU-memory
measurements.

### Controlled render-history parity

`mlt-history.ts` uses the public `setNow()` clock and a held browser animation-frame
scheduler. It runs real `easeTo`/`flyTo` code at 16 logical times (125 ms increments),
waiting for public source readiness between draws without an extra repaint. This
preserves terrain texture history while allowing intrusive capture on SwiftShader.
Every frame, including frames that initiate new tile loads, has an exact PNG and
full GeoJSON comparison. Requested-target checks use 1e-9 for camera conversions;
observed cameras and all paired query results remain exact.

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-history.ts --runs 2 --output <new-history-directory>
```

Repeat sequentially with `--strict`, then `PUPPETEER_GPU=software --strict`. The four
journeys cover both projection directions, terrain orbit and terrain flight. Two
runs reverse encoding order and check same-encoding repeatability from fresh maps.
After setup, the world source is reloaded at the starting pose using the same URLs;
this clears setup-dependent out-of-view tiles before recording, never during motion.
Warm-cache histories from other preparation paths are outside this contract.
Two negative controls insert a same-time repaint: their states must match but their
images must differ, exposing the history-dependent terrain cache in each encoding.
No cache behavior, expected image or pixel tolerance is changed.

```bash
node test/bench/e2e/mlt-history-validate.mjs \
  <production> <strict-gpu> <strict-software> <unit-report.json>
```

The validator requires the full repeated matrix and both controls, independently
reconstructs comparisons, checks raw PNG/GeoJSON, events, barriers, counters and
source/bundle hashes. `--only terrain-flight --no-controls` is for reduced probes.
The [history report](baselines/MLT_HISTORY_20260907.md) distinguishes this controlled
schedule from native real-time traces and arbitrary partial network arrivals. This
is neither an FPS benchmark nor retroactive certification of the old motion runs.

### Warm preparation and controlled partial delivery

`mlt-warm.ts` records the world-source preparation itself: Mercator entry,
projection/terrain setup, an excursion, a warm return, then the four real animations.
It never calls `setTiles` or replaces a vector source. Source-initialization browser
callbacks also run; those initial barriers are explicitly annotated. The return
must not issue network requests or repeat MLT decoding/clipping.

Run the same three configurations and `--runs 2` as above, replacing
`mlt-history.ts` with `mlt-warm.ts`, then validate with:

```bash
node test/bench/e2e/mlt-warm-validate.mjs \
  <warm-production> <warm-strict-gpu> <warm-strict-software> <unit-report.json>
```

The validator additionally checks all preparation repeats from raw captures,
including the 66 preparation-repeat comparisons absent from the runner's comparison
list. See the [warm/delivery report](baselines/MLT_WARM_ARRIVALS_20260907.md).

`mlt-arrival.ts` holds real local HTTP responses for a separate four-tile source
while the original Berlin corpus remains warm. It delivers one tile at each
500 ms boundary during rotation/pitch, with forward/reversed delivery orders and
reversed encoding order on the second run. Every partial frame is retained.
The original campaign **failed query parity**: points in an unfiltered line layer
appeared in MVT queries but not MLT, although pixels matched. The columnar index
now preserves nonempty degenerate-part bounds; the runner/style remain unchanged.
See the [line-index report](baselines/MLT_LINE_INDEX_20260907.md): production GPU
and strict GPU/SwiftShader pass 276 positive comparisons and 12 delivery controls.
`mlt-arrival-analyze.mjs <old-run> <server-unit.json>` preserves the original failed
audit; it is not a parity certificate.

```bash
npx vitest run test/bench/e2e/mlt-arrival-server.test.ts --environment node \
  --reporter=json --outputFile=<server-unit.json>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-arrival.ts --runs 2 --output <new-arrival-directory>
```

`mlt-arrival-validate.mjs <production> <strict-gpu> <strict-software>` requires three
complete passing directories and checks current source/bundle hashes. The separate
`mlt-line-index-validate.mjs` audits unchanged pixels and restoration of just the
two missing points against the old production captures, preserving duplicates.
That vector-only campaign does not cover partial DEM delivery or globe flights
with incomplete sources; the separate terrain-delivery campaign below does.

### Controlled vector and DEM arrivals

`mlt-terrain-arrival.ts` combines a local orbit across four DEM tiles with a real
globe flight. It gates physical vector/DEM resources at fixed clock boundaries,
in both delivery orders, and retains every preparation, partial and settling
frame. A delayed-DEM control isolates terrain's visual effect at identical camera
coordinates and vector arrivals. Two runs reverse MVT/MLT order.

The real HTTP server separates ordinary assets, gated vectors and gated DEMs onto
three local origins to avoid held HTTP/1 connections starving unrelated assets.
Gates apply to repeated requests for a physical tile, including overzoom. Native
cancellations remain observable. Requested/aborted HTTP counts can differ only
for cancellations before release, with no response delivered; these differences
are retained in `transportOutcomes`. Completed responses, public events, resource
barriers, camera/query/state metadata and within-backend parity pixels must match.
`arrivals` records cumulative receipts, not currently retained tiles.

```bash
npx vitest run test/bench/e2e/mlt-terrain-arrival-server.test.ts --environment node \
  --reporter=json --outputFile=<server-unit.json>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-terrain-arrival.ts --runs 2 --output <production>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-terrain-arrival.ts --strict --runs 2 --output <strict-gpu>
PUPPETEER_GPU=software \
  node test/bench/e2e/mlt-terrain-arrival.ts --strict --runs 2 --output <strict-software>
node test/bench/e2e/mlt-terrain-arrival-validate.mjs \
  <production> <strict-gpu> <strict-software> <unit-report-405.json> <server-unit.json>
```

Use existing normal/strict production `.mjs` bundles and run browsers sequentially.
The validator independently reconstructs comparisons from PNG/full GeoJSON,
checks complete capture inventories, gate/event timing and worker counters, and
requires unchanged product/bundle bytes from the line-index lot. Final images
across different arrival orders are diagnostic, not a general convergence gate.
See the [terrain-arrival report](baselines/MLT_TERRAIN_ARRIVALS_20260907.md) for
results and limitations: the independent three-campaign certificate verifies
828 positive comparisons and 36 discriminating controls, with 405 targeted unit
tests and five HTTP-server tests passing. Synthetic DEMs, fixed gates and these natural
cancellations do not qualify HTTP failures/retries, native timing, touch/pinch,
real multi-level DEMs or GPU memory/performance.

For separate **correctness-only** worker materialization checks:

```bash
BUILD=production npx rolldown -c rolldown.config.mlt-validation.ts
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --scenario symbols --strict --phase correctness \
  --output <new-strict-directory>
```

`--strict` loads the dedicated instrumented build and rejects timing/profile phases.
Repeat with `PUPPETEER_GPU=software` for software rendering. Production measurements
must omit `--strict`; use an even number of pairs for balanced MVT/MLT ordering.
Do not interpret changes between `base` and `symbols` as implementation speedups.
The symbol qualification validator independently recomputes archived query signatures,
checks PNG pixels, assets, strict counters and workload counts:

```bash
node test/bench/e2e/mlt-symbols-validate.mjs \
  <production-directory> <strict-gpu-directory> <strict-software-directory> \
  <unit.json> <base-results.json>
```

`--phase correctness` runs only the seven parity checkpoints. `--phase timing` adds
the animated timing sessions but omits memory. `--phase profile` adds fixed-camera
rendered-query diagnostics: 10 warmups, 50 uninstrumented samples separating query,
GeoJSON materialization and JSON serialization, then a distinct 100-query CPU-sampling
batch at each of the three cameras. CDP profiles (`.cpuprofile.gz`) and source-mapped
self-time summaries are archived; profiled batches are never used as benchmark timings.
The default `--phase all` retains the original timing-plus-memory lifecycle, without
CPU sampling. For a before/after profile comparison with an unchanged harness, use
`node test/bench/e2e/mlt-query-compare.mjs <before-directory> <after-directory>`.

For an interleaved version comparison, freeze a production build **before** editing
the implementation, then rebuild the candidate and compare both versions in the same
browser campaign:

```bash
npm run build-prod
node test/bench/e2e/mlt-snapshot.mjs <new-reference-directory>
# Apply the implementation change, then rebuild.
npm run build-prod
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --phase compare --runs 4 \
  --reference-dist <reference-directory> --output <new-results-directory>
node test/bench/e2e/mlt-intersections-analyze.mjs <results-directory>
```

This mode checks exact seven-checkpoint query and pixel parity across both encodings
and both versions before collecting timings. Four conditions (before/after × MVT/MLT)
rotate through every execution position; use a multiple of four runs for balanced
ordering. Each condition has its own page and worker, with 10 warmups and 50 measured
rendered queries per fixed camera. No CPU profiling or forced GC runs during these
measurements. The archive includes the frozen reference source diff, bundle hashes,
raw samples and a paired session-median summary. This is not an animated frame-rate
or whole-lifecycle benchmark; the MVT control helps expose desktop drift.

Correctness sessions archive PNGs and complete public query results (`.json.gz`) at
seven checkpoints. Attributes, evaluated layer paint/layout, IDs, state, result counts,
geometry hashes and pixels are compared separately. A mismatch in attributes/state/counts
aborts collection. Geometry/pixel differences normally stop before timing, with exit 1.
`--measure-with-differences` explicitly permits descriptive measurements to continue,
but preserves the differences, the non-passing status and exit 1. It does not relax a
render golden or establish a new acceptable-error threshold.

RAF intervals cover camera animations, not GPU frame durations. Long tasks are
observed around these windows; a task crossing their boundary can also include
adjacent query work, so the counter is not exclusive rendering time. Query timings
include serialization of the complete returned GeoJSON.
Memory samples use CDP collection outside timing sessions and report the main isolate,
live workers and their backing storage separately; these are not process RSS or GPU
memory. Each loaded checkpoint has exercised public queries, and source/map removal is
measured without closing the page first. The global dispatcher can retain its worker
after `map.remove()`; page closure ends each session.

HTTP counters are uncompressed response-body bytes, **not worker transfers or peaks**.
Animation timing and canceled requests can change request counts between formats;
the input files and their hashes are fixed. Production bundle hashes, product source
diff, harness hashes, runtime, actual renderer and every measured sample are archived.
Run `node test/bench/e2e/mlt-lifecycle-analyze.mjs <output-directory>` to summarize
session-median ratios, memory checkpoints, and coordinate differences. Ambiguous
duplicate rendered geometries are counted without inventing point correspondences.

The [rounding/query follow-up](baselines/MLT_ROUNDING_QUERY_20260906.md) records exact
seven-checkpoint parity, fixed-camera CPU profiles and the explicit MVT query-reference
changes induced by final coordinate rounding. Set `QUERY_TEST_OUTPUT=<directory>` on
the integration query suite to capture mismatches without changing expected results.
`node --experimental-transform-types test/bench/e2e/mlt-query-reference-audit.ts <directory>`
checks the seven counties overzoom cases against raw-tile slicing under both the old
float-delta encoding and the new integer-coordinate contract.

## Direct MLT overzoom experiment (8 September 2026)

The current optimization removes intermediate child MLT encoding from overzoom.
It preserves deferred public-query properties, but transfers the full parent and
clips queried layers on first use. Do not infer an end-to-end win from worker time
alone: see [the direct-overzoom report](baselines/MLT_DIRECT_OVERZOOM_20260908.md).

The frozen pre-change source, compiled MLT and browser bundles are in
`baselines/direct-overzoom-before-20260908/workspace.tar.gz`. Extract into a new
temporary directory; never restore them over the working tree. The two Node
modules must use the same explicit TypeScript configuration and dependencies.

```bash
node test/bench/build-mlt-direct.mjs <new-before-module-dir> <extracted-frozen-root>
node test/bench/build-mlt-direct.mjs <new-after-module-dir>
MLT_DIRECT_BEFORE=<before-module-dir> MLT_DIRECT_AFTER=<after-module-dir> \
  MLT_DIRECT_OUTPUT=<new-result.json> \
  npx vitest run --config test/bench/vitest.mlt-direct.config.ts

PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-direct-browser.ts --runs 3 --samples 20 --warmup 5 \
  --reference <extracted-frozen-root>/browser-dist --output <new-browser-directory>
```

The Node diagnostic alternates cold/warm MVT and MLT for both versions and verifies
exact geometry-buffer and complete-query parity. The browser diagnostic uses
production bundles without strict counters or profiling: reload-to-first-render
(CPU submission, not GPU completion), first-query time and post-GC main/worker
heaps are separate. Run it without concurrent test/build/browser campaigns.

### Production render CPU profiles

Profile the main thread and its worker around native-zoom reloads, the first
overzoom and subsequent overzoom reloads:

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-render-profile.ts --runs 2 --repeats 5 --scenario symbols \
  --output <new-profile-directory>
```

Use native Node TypeScript support, not `vite-node`: page functions are serialized
into Chrome. Production bundles and matching sourcemaps must already exist in
`dist/`. MVT/MLT order alternates; each session uses a fresh page and one worker.
The harness records compressed Chrome CPU profiles and source-mapped exclusive
and inclusive frame samples, and requires exact public-query and pixel parity.
Initial map/style/glyph setup, queries and screenshots are outside profiles.
Inclusive frames overlap and must not be added together. Sampling adds overhead;
these are diagnostics, not uninstrumented benchmark results or GPU execution times.
See the [indexed-view qualification and next target](baselines/MLT_SHARED_PARENT_20260908.md).

### Geometry preparation at native zoom and overzoom

The worker diagnostic also accepts `MLT_DIRECT_ZOOM=native`. This runs four
before/after × MVT/MLT variants with fresh native tile loads (120 retained rows),
instead of eight overzoom/cold/warm variants (240 rows). Its geometry hash covers
positions and triangle indices; it is not a complete paint/outline buffer hash.

Use the geometry browser harness to compare the two zoom stages with production
builds. Four runs balance each variant across every execution position:

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-geometry-browser.ts --runs 4 --samples 20 --warmup 5 \
  --reference <frozen-dist-directory> --output <new-browser-directory>
node test/bench/e2e/mlt-geometry-validate.mjs <browser-directory> <new-summary.json> \
  <optional-worker-report.json>
```

The default `base` scenario includes polygons, lines and circles; pass
`--scenario symbols` to add labels. Both stages change tile URLs on each reload;
native loads decode fresh tables, whereas overzoom can reuse identical parent
content. Complete queries and PNGs must match every before/after and MVT/MLT
variant. Retained memory is collected separately after each stage. Initial map
setup is excluded; the first native reload and first overzoom are kept separately
from warmed samples. `settledMs` includes the scenario stability fence and is not
strictly the first `idle` event. Neither this timing nor CPU profiles measure GPU
completion/presentation. Run performance campaigns without concurrent tests/builds.

### Warm-overzoom diagnosis with an identical-build control

`mlt-overzoom-diagnostic.ts` compares two frozen production directories using the
Berlin base scenario, one worker and alternating before/after session order.
After native prefill and overzoom warmup, it records forced URL reloads, the last
tile `sourcedata` event and the first loaded render. Complete queries and PNGs are
checked after each session, outside measurement. By default it performs no public
queries, Node-side feature serialization or hashing between observations; this
differs from `mlt-geometry-browser.ts` and does not measure ordinary cached navigation.

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-overzoom-diagnostic.ts --mode timing \
  --reference <frozen-before-dist> --candidate <frozen-after-dist> \
  --runs 6 --samples 40 --native 26 --warmup 10 --output <new-timing-directory>
node test/bench/e2e/mlt-overzoom-verify.mjs <new-summary.json> <timing-directory>
```

For an A/A control, pass the same frozen directory to `--reference` and
`--candidate`. For a separate CPU sampling campaign, use `--mode profile --runs 2
--samples 80`; its latency is not performance evidence. `--queries` optionally
runs public queries outside each reload clock, without serializing their results
to Node. The verifier accepts multiple completed directories and recomputes their
aggregates, full query signatures, exact pixels, artifact hashes and sampled CPU
costs. It requires the original bundles, sourcemaps and raw outputs to remain
available. See the [13 September investigation](baselines/MLT_OVERZOOM_RECHECK_20260913.md)
for all completed cohorts, including unfavorable results and protocol limitations.

### Temporary allocation profiles

Compare allocation pressure independently of rendering latency:

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-allocation-profile.ts --runs 4 --repeats 10 --warmup 5 \
  --reference <frozen-dist-directory> --output <new-allocation-directory>
node test/bench/e2e/mlt-allocation-profile.ts --verify <allocation-directory>
```

This uses production bundles and their exact sourcemaps. Four rotations balance
before/after × MVT/MLT order. Each fresh map has one worker, five unprofiled native
reloads, then ten reloads sampled in both execution contexts. Public queries and
PNGs are captured after sampling and must match exactly across all sessions.
Raw compressed heap profiles include objects already collected by minor and major
GC; source-mapped self and inclusive estimates are retained and independently
recomputed by `--verify`, together with input hashes and captured parity.

The default 16 KiB Poisson sampling interval gives allocation **estimates**, not
exact byte counts, retained/peak heap or GPU memory. Inclusive costs overlap.
These profiles do not establish latency or GC-pause improvements; run the
uninstrumented geometry benchmark separately, without concurrent campaigns.

### FastPFOR versus pretriangulated VARINT

`generate-mlt-fastpfor.mjs` writes separate fixtures with `--enable-fastpfor`,
audits actual stream metadata and compares complete decoded layers and meshes.
`e2e/mlt-fastpfor-browser.ts` compares MVT, MLT VARINT and MLT FastPFOR with one
unchanged build; its `parity`, `timing` and `allocations` modes run separately.
Six runs balance all variant permutations. `e2e/mlt-fastpfor-verify.ts` checks
raw profiles, complete query archives, pixels, input/build hashes and medians.

The [8 September experiment](baselines/MLT_FASTPFOR_20260908.md) finds no stable
render gain and 3.52% larger gzip tiles than VARINT. The displayed base scene
passes exact GPU/software parity, but full input parity fails on one `contour`
layer: the generator deliberately reports failure. This is not a global
FastPFOR qualification or a change to the default encoding.
