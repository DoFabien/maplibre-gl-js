# Using MapLibre Tile (MLT) vector sources

MapLibre GL JS renders [MapLibre Tile (MLT)](https://github.com/maplibre/maplibre-tile-spec) sources by reading
their feature tables column by column in the worker. The rendered result is the same as with Mapbox Vector Tiles
(MVT): the buckets hold the same vertices, and query APIs return the same features.

## Configure an MLT source

Set `encoding` to `mlt` on a vector source. The tile URL must return MLT bytes.

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

If the server compresses tiles, it must set the matching `Content-Encoding` header so that the browser hands the
decompressed MLT bytes to MapLibre GL JS.

## What runs on the columns

- **Decoding.** Only the source layers and the property columns that the style reads are decoded when a tile
  loads: the columns used by filters, layout and paint expressions and `promoteId`. Other columns are decoded when
  a query first reads them.
- **Filters.** Comparisons, membership and existence tests of a property or of the geometry type against literal
  or `global-state` values, their `all`, `any` and `!` combinations, and boolean `match` and `case` select rows on
  the columns. Any other expression, such as `zoom`, `coalesce`, `collator`, `within` or `distance`, is evaluated
  row by row by the style specification, only on the rows that the columnar parts of an `all` keep.
- **Data-driven values.** A paint or layout expression that reads one property is evaluated once for all the rows
  that share its value, for instance once per dictionary entry of a string column.
- **Buckets.** Fill, line, circle, heatmap, fill-extrusion and symbol layers build their buffers from the selected
  rows, reading each row's geometry when the bucket adds it.

## Queries, feature state and overzoom

`queryRenderedFeatures`, `querySourceFeatures` and `feature-state` work as with MVT sources. The first query of a
tile decodes it on the main thread, with property columns decoded when first read. Tiles shown beyond the source's
`maxzoom` are overzoomed as vector tiles are.
