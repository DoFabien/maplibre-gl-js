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
| `symbol`, including point, line and line-center placement | Native columnar selection; symbol layout reads each feature's geometry as for vector tiles |
| `heatmap` | Native columnar circle buckets |
| Worker layer filters | Any valid filter; simple tests run on the columns, other expressions row by row |
| `within` | Evaluated directly against columnar geometry |
| `queryRenderedFeatures` | Filters candidates on the columns before creating their features |
| `querySourceFeatures` | Selects row indexes before creating features |
| Data-driven paint and layout | Evaluated by the style specification through a columnar view of the row |
| `promoteId` and signed 64-bit ids | Read directly from the id/property vectors |
| `feature-state` paint updates | As with vector tiles, read from the tile decoded on the main thread |
| Overzoom | Clips the feature tables of the parent tile; children share the parent data |

Filters select the same features as with vector tiles. Comparisons,
membership and existence tests of a property, the id or the geometry type
against literal values, their `all`, `any` and `!` combinations, boolean
`match` and `case`, and `within` run directly on the columns. Any other
expression, such as `step`, `let`, `coalesce`, computed comparisons,
`collator` or `distance`, is evaluated row by row by the style specification's
own evaluator through a columnar view of the row: no feature object is
created, and geometry is only loaded when the expression needs it. Under a
top-level `all`, the columnar parts run first and narrow the rows that the
row-by-row parts visit. As with vector tiles, `feature-state` is not available
in layer filters and evaluates as null.

An unsupported MLT layer type raises an error containing the layer id. Filters
never fall back to `sourceLayer.feature()` or materialize the complete source
layer.

## Column projection and queries

At tile load, MapLibre GL JS derives the required source layers and property
columns from the current style, including filters, layout/paint expressions,
`promoteId` and state-dependent expressions. Statically known dependencies are
decoded eagerly; other property column offsets remain available for deferred
decode.

`queryRenderedFeatures` and `querySourceFeatures` evaluate their filter on the
columns, so rejected rows never become features. Selected rows are returned as
for vector tiles.

The first query or `feature-state` update on the main thread decodes the
retained raw MLT tile with deferred property columns. Later calls reuse that
decoded view. Rendering by itself does not pay this main-thread decode cost.

## Data and cache lifecycle

| Phase | Retained data | Released or bounded data |
| --- | --- | --- |
| Worker load | Raw MLT buffer and projected `FeatureTable`s | Layers and columns absent from the style are not eagerly decoded |
| Worker parse | Bucket buffers and feature index | Temporary selections, property views and symbol layout references are released after use |
| Worker → main transfer | One raw-buffer copy plus transferable bucket/index buffers | The worker does not send another raw copy on reload |
| Main-thread render | GPU/bucket data and the raw MLT buffer | Query layers are not decoded until an API needs them |
| First query or `feature-state` update | Deferred `FeatureTable` views cached by `FeatureIndex` | Property columns absent from the style are decoded when read |
| Overzoom | Clipped feature tables; the parent raw data, shared by the loaded children | The parent data is released with its last child |
| Tile/source eviction | Tile buckets, query views and raw bytes become unreachable | |

## Performance verification

The isolated benchmark matrix covers all supported bucket families, scan,
projected and full decode, worker parse, end-to-end transfer, queries,
feature-state, overzoom, a 5/50/200-column projection matrix, the complete
memory lifecycle, OMT tiles, the standard Bing corpus and a separate fixture
whose FastPFOR streams are verified from the physical metadata.

See [the benchmark guide](https://github.com/maplibre/maplibre-gl-js/blob/main/test/bench/README.md#isolated-mlt-pipeline-benchmarks)
for reproduction commands. The nightly workflow compares paired median/p95
ratios and enforces materialization and memory/transfer budgets against a
versioned baseline.
