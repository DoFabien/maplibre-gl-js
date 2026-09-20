# Using MapLibre Tile (MLT) vector sources

MapLibre GL JS can render [MapLibre Tile (MLT)](https://github.com/maplibre/maplibre-tile-spec)
data through an opt-in columnar pipeline. MLT keeps geometry, ids and properties
in typed column vectors while the worker filters, styles and indexes a tile.
Public query APIs still return ordinary GeoJSON features, but those objects are
created only for results selected by the query.

## Configure an MLT source

Set `encoding` to `mlt` on a vector source. The tile URL must return MLT bytes,
not MVT protobuf bytes.

```json
{
  "version": 8,
  "sources": {
    "basemap": {
      "type": "vector",
      "encoding": "mlt",
      "tiles": ["https://tiles.example.com/{z}/{x}/{y}.mlt"],
      "minzoom": 0,
      "maxzoom": 14
    }
  },
  "layers": [
    {
      "id": "roads",
      "type": "line",
      "source": "basemap",
      "source-layer": "transportation",
      "paint": {
        "line-color": ["match", ["get", "class"], "motorway", "#d95f02", "#666"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 4]
      }
    }
  ]
}
```

If the server compresses a tile, it must set the correct `Content-Encoding`
header so the browser hands decompressed MLT bytes to MapLibre GL JS.

## Support matrix

| Capability | MLT behavior |
| --- | --- |
| `fill`, `line`, `circle`, `fill-extrusion` | Native columnar buckets |
| `symbol`, including point, line and line-center placement | Native columnar selection and geometry views |
| `heatmap` | Rejected explicitly before bucket creation |
| Worker layer filters | Columnar only; unsupported filters fail deterministically |
| `within` | Evaluated directly against columnar geometry |
| `queryRenderedFeatures` | Filters and intersects columnar candidates before creating outputs |
| `querySourceFeatures` | Selects row indexes before creating outputs |
| `promoteId` and signed 64-bit ids | Read directly from the id/property vectors |
| `feature-state` paint updates | Uses compact transferred state data; no raw-tile decode |
| Overzoom | Clips typed geometry and encodes an MLT child tile |

Use current MapLibre Style Specification expression syntax for filters and
data-driven properties. The native filter evaluator covers comparisons,
membership and existence checks, boolean composition, `match`, `case`,
`coalesce`, numeric and string scalar operations, assertions/conversions,
`step`, `interpolate`, `let`, `global-state` and `within`. Style validation is
still authoritative. In particular, `feature-state` is valid in supported
paint expressions but not in layer filters.

An unsupported MLT layer or worker filter raises an error containing the layer
id and reason. It never falls back to `sourceLayer.feature()` or materializes
the complete source layer. This makes an incompatible style visible instead of
silently losing the columnar performance guarantee.

## Column projection and queries

At tile load, MapLibre GL JS derives the required source layers and property
columns from the current style, including filters, layout/paint expressions,
`promoteId` and state-dependent expressions. Statically known dependencies are
decoded eagerly; other property column offsets remain available for deferred
decode.

`queryRenderedFeatures` and `querySourceFeatures` create lazy GeoJSON output
objects only after filtering and geometric intersection. Reading
`feature.properties`, `feature.geometry`, or calling `toJSON()` materializes
the corresponding public output data. Rejected candidates do not create a
feature wrapper, and a property-only filter does not load geometry.

The first query on the main thread decodes the retained raw MLT tile with
deferred property columns. Later queries reuse that decoded view. Rendering by
itself does not pay this main-thread decode cost.

## Data and cache lifecycle

| Phase | Retained data | Released or bounded data |
| --- | --- | --- |
| Worker load | Raw MLT buffer and projected `FeatureTable`s | Layers and columns absent from the style are not eagerly decoded |
| Worker parse | Bucket buffers, feature index and compact state-dependent columns | Temporary selections, property views and symbol layout references are released after use |
| Worker → main transfer | One raw-buffer copy plus transferable bucket/index buffers | The worker does not send another raw copy on reload |
| Main-thread render | GPU/bucket data and the raw MLT buffer | Query layers are not decoded until an API needs them |
| First query | Deferred `FeatureTable` views cached by `FeatureIndex` | Public geometry/properties remain lazy per returned feature |
| Feature-state update | Id-to-bucket mapping and statically known state-dependent columns | Dynamic property dependencies conservatively retain property values, but never geometry, a complete `FeatureTable`, or a raw-tile decode |
| Overzoom | Native MLT child buffers | Cache is capped at 64 MiB and evicts by byte weight |
| Tile/source eviction | Tile buckets, query views, raw bytes and state data become unreachable | Overzoom entries disappear with eviction or worker-source disposal |

Temporary selection and sort buffers retain at most 65,536 entries. Larger
one-off selections are released after the operation. The overzoom cache is
bounded by bytes rather than by tile count, so large children cannot grow the
cache without limit.

## Performance verification

The isolated benchmark matrix covers all supported bucket families, scan,
projected and full decode, worker parse, end-to-end transfer, queries,
feature-state, overzoom, a 5/50/200-column projection matrix, the complete
memory lifecycle, OMT tiles, the standard Bing corpus and a separate fixture
whose FastPFOR streams are verified from the physical metadata.

See [the benchmark guide](https://github.com/maplibre/maplibre-gl-js/blob/main/test/bench/README.md#isolated-mlt-pipeline-benchmarks)
for reproduction commands. The nightly workflow compares paired median/p95
ratios and enforces zero-materialization and memory/transfer budgets against a
versioned baseline.
