/**
 * Current wire keys take precedence over legacy tiles. Literal keys keep the GeoJSON tiler
 * out of the shared renderer chunk; a unit test checks them against the upstream exports.
 */
export const lineClipPropertyNames: ReadonlyArray<readonly [string, string]> = [
    ['geojsonvt_clip_start', 'geojsonvt_clip_end'],
    ['mapbox_clip_start', 'mapbox_clip_end'],
];
