# Terrain symbol elevation while moving

This experiment adds an opt-in `MapOptions.terrainSymbolElevationMode` switch for
terrain symbol elevation sampling while the map is moving.

The default mode is unchanged:

```js
terrainSymbolElevationMode: 'exact'
```

Experimental moving modes:

```js
terrainSymbolElevationMode: 'cached-while-moving'
terrainSymbolElevationMode: 'approximate-while-moving'
```

When the map is idle, placement still uses exact bilinear DEM sampling. When the
map is moving, `cached-while-moving` reuses exact cached symbol-anchor elevations
when available and falls back to nearest DEM sampling otherwise. The approximate
mode always uses nearest DEM sampling while moving.

## Implementation notes

- `TerrainSamplingContext` now exposes exact, cached-or-approximate, and nearest
  sampling entry points.
- Symbol placement and symbol draw-time updates use the same moving-mode policy.
- Exact anchor-elevation preload is skipped while moving for non-exact modes, so
  the degraded mode does not immediately pay the exact sampling cost.
- The option is global and opt-in. Existing behavior is preserved by default.

## Benchmark setup

Scenario:

- style/data: Mapeak / Israel Hiking Map style case
- terrain enabled
- no extra synthetic symbol or extrusion grid layers
- benchmark mode: `cpu-deterministic`
- motion: manual deterministic replay
- `forceMoving=1`
- comparison: `exact` vs `cached-while-moving`
- 3 isolated rounds

The raw local benchmark JSON files were produced under the ignored
`wFabien/terrain-profile-results/` directory.

## Results

Desktop, default exact mode overhead check:

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| CPU frame trimmed mean | 40.3 ms | 40.2 ms | neutral |
| Frame median | 39.3 ms | 39.3 ms | neutral |
| Frame p95 | 63.4 ms | 63.7 ms | neutral |
| Page errors | 0 | 0 | none |

Desktop, `cached-while-moving`:

| Metric | Exact | Cached while moving | Delta |
| --- | ---: | ---: | ---: |
| CPU frame median | 38.9 ms | 34.8 ms | +10.4% |
| CPU frame trimmed mean | 38.4 ms | 35.0 ms | +9.0% paired mean gain |
| Frame median | 37.8 ms | 34.3 ms | -3.5 ms |
| Frame p95 | 59.4 ms | 53.4 ms | -6.0 ms |
| Page errors | 0 | 0 | none |

Pixel 8 Pro, Chrome Android 149, `cached-while-moving`:

| Metric | Exact | Cached while moving | Delta |
| --- | ---: | ---: | ---: |
| CPU frame median | 19.7 ms | 18.6 ms | +5.4% |
| CPU frame trimmed mean | 19.8 ms | 18.7 ms | +5.7% paired mean gain |
| Frame median | 19.1 ms | 18.3 ms | -0.8 ms |
| Frame p95 | 33.1 ms | 30.3 ms | -2.8 ms |
| Page errors | 0 | 0 | none |

Android Chrome did not expose usable GPU timer results in this run
(`gpuSupported=false`), so the Pixel result should be read as a CPU/frame-time
signal rather than a GPU breakdown.

## Interpretation

`cached-while-moving` is the stronger candidate from these measurements. It is
neutral when the option remains at the default exact mode, and it improves the
Mapeak moving-placement case on both desktop and Pixel 8 Pro. The Android gain is
smaller than desktop, but still positive in the same direction.

The mode is intentionally conservative: exact placement is restored when idle,
which limits the visual risk to transient camera movement.
