import {mat4} from 'gl-matrix';

import type Point from '@mapbox/point-geometry';
import type {TileManager} from '../tile/tile_manager.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {CollisionIndex} from '../symbol/collision_index.ts';
import type {IReadonlyTransform} from '../geo/transform_interface.ts';
import type {RetainedQueryData} from '../symbol/placement.ts';
import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {GeoJSONFeature, MapGeoJSONFeature} from '../util/vectortile_to_geojson.ts';
import type {QueryResults, QueryResultsItem} from '../data/feature_index.ts';
import type {OverscaledTileID} from '../tile/tile_id.ts';

/**
 * Options to pass to query the map for the rendered features
 */
export type QueryRenderedFeaturesOptions = {
    /**
     * An array or set of [style layer IDs](https://maplibre.org/maplibre-style-spec/#layer-id) for the query to inspect.
     * Only features within these layers will be returned. If this parameter is undefined, all layers will be checked.
     */
    layers?: string[] | Set<string>;
    /**
     * A [filter](https://maplibre.org/maplibre-style-spec/layers/#filter) to limit query results.
     */
    filter?: FilterSpecification;
    /**
     * An array of string representing the available images
     */
    availableImages?: string[];
    /**
     * Whether to check if the `options.filter` conforms to the MapLibre Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
     */
    validate?: boolean;
};

/**
 * @internal
 * A version of QueryRenderedFeaturesOptions used internally
 */
export type QueryRenderedFeaturesOptionsStrict = Omit<QueryRenderedFeaturesOptions, 'layers'> & {
    layers: Set<string> | null;
    globalState?: Record<string, any>;
};

/**
 * The options object related to the {@link Map.querySourceFeatures} method
 */
export type QuerySourceFeatureOptions = {
    /**
     * The name of the source layer to query. *For vector tile sources, this parameter is required.* For GeoJSON sources, it is ignored.
     */
    sourceLayer?: string;
    /**
     * A [filter](https://maplibre.org/maplibre-style-spec/layers/#filter)
     * to limit query results.
     */
    filter?: FilterSpecification;
    /**
     * Whether to check if the `parameters.filter` conforms to the MapLibre Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
     * @defaultValue true
     */
    validate?: boolean;
};

/**
 * @internal
 * A version of QuerySourceFeatureOptions used internally
 */
export type QuerySourceFeatureOptionsStrict = QuerySourceFeatureOptions & {
    globalState?: Record<string, any>;
};

export type QueryRenderedFeaturesResults = {
    [key: string]: QueryRenderedFeaturesResultsItem[];
};

export type QueryRenderedFeaturesResultsItem = QueryResultsItem & { feature: MapGeoJSONFeature };

export type QueryProfileRecord = {
    phase: 'query.tilesIn' | 'query.sortTiles' | 'query.collectTile' | 'query.mergeDeduplicate' | 'query.enrich' | 'query.flattenSort' | 'query.sourceDeduplicate' | 'query.sourceCollectTile';
    duration: number;
    kind: 'exclusive';
    inputCount?: number;
    outputCount?: number;
    tileCount?: number;
};

export type QueryProfile = {
    records: QueryProfileRecord[];
};

function queryResultCount(result: QueryResults): number {
    let count = 0;
    for (const layerID in result) count += result[layerID].length;
    return count;
}

function recordQueryProfile(
    profile: QueryProfile,
    phase: QueryProfileRecord['phase'],
    start: number,
    counts: Omit<QueryProfileRecord, 'phase' | 'duration' | 'kind'> = {},
): void {
    profile.records.push({phase, duration: performance.now() - start, kind: 'exclusive', ...counts});
}

/*
 * Returns a matrix that can be used to convert from tile coordinates to viewport pixel coordinates.
 */
function getPixelPosMatrix(transform, tileID: OverscaledTileID) {
    const t = mat4.create();
    mat4.translate(t, t, [1, 1, 0]);
    mat4.scale(t, t, [transform.width * 0.5, transform.height * 0.5, 1]);
    if (transform.calculatePosMatrix) { // Globe: TODO: remove this hack once queryRendererFeatures supports globe properly
        return mat4.multiply(t, t, transform.calculatePosMatrix(tileID.toUnwrapped()));
    } else {
        return t;
    }
}

function queryIncludes3DLayer(layers: Set<string> | undefined, styleLayers: {[_: string]: StyleLayer}, sourceID: string) {
    if (layers) {
        for (const layerID of layers) {
            const layer = styleLayers[layerID];
            if (layer?.source === sourceID && layer.type === 'fill-extrusion') {
                return true;
            }
        }
    } else {
        for (const key in styleLayers) {
            const layer = styleLayers[key];
            if (layer.source === sourceID && layer.type === 'fill-extrusion') {
                return true;
            }
        }
    }
    return false;
}

export function queryRenderedFeatures(
    tileManager: TileManager,
    styleLayers: {[_: string]: StyleLayer},
    serializedLayers: {[_: string]: any},
    queryGeometry: Point[],
    params: QueryRenderedFeaturesOptionsStrict | undefined,
    transform: IReadonlyTransform,
    getElevation: undefined | ((id: OverscaledTileID, x: number, y: number) => number),
    profile?: QueryProfile,
): QueryRenderedFeaturesResults {

    const has3DLayer = queryIncludes3DLayer(params?.layers ?? null, styleLayers, tileManager.id);
    const maxPitchScaleFactor = transform.maxPitchScaleFactor();
    const tilesInStart = profile ? performance.now() : 0;
    const tilesIn = tileManager.tilesIn(queryGeometry, maxPitchScaleFactor, has3DLayer);
    if (profile) {
        recordQueryProfile(profile, 'query.tilesIn', tilesInStart, {
            outputCount: tilesIn.length,
            tileCount: tilesIn.length,
        });
    }
    if (tilesIn.length === 0) return {};
    const sourceFeatureState = tileManager.getState();

    const sortStart = profile ? performance.now() : 0;
    tilesIn.sort(sortTilesIn);
    if (profile) {
        recordQueryProfile(profile, 'query.sortTiles', sortStart, {
            inputCount: tilesIn.length,
            outputCount: tilesIn.length,
            tileCount: tilesIn.length,
        });
    }
    const result: QueryResults = {};
    const seenByWrappedTile = new Map<string, Map<string, Set<number>>>();
    for (const tileIn of tilesIn) {
        const collectStart = profile ? performance.now() : 0;
        const tileResults = tileIn.tile.queryRenderedFeatures(
            styleLayers,
            serializedLayers,
            sourceFeatureState,
            tileIn.queryGeometry,
            tileIn.cameraQueryGeometry,
            tileIn.scale,
            params,
            transform,
            maxPitchScaleFactor,
            getPixelPosMatrix(transform, tileIn.tileID),
            getElevation ? (x: number, y: number) => getElevation(tileIn.tileID, x, y) : undefined,
        );
        const tileResultCount = profile ? queryResultCount(tileResults) : undefined;
        if (profile) {
            recordQueryProfile(profile, 'query.collectTile', collectStart, {
                outputCount: tileResultCount,
                tileCount: 1,
            });
        }
        const mergeStart = profile ? performance.now() : 0;
        const resultCountBefore = profile ? queryResultCount(result) : 0;
        mergeRenderedFeatureLayer(
            result,
            seenByWrappedTile,
            tileIn.tileID.wrapped().key,
            tileResults,
        );
        if (profile) {
            recordQueryProfile(profile, 'query.mergeDeduplicate', mergeStart, {
                inputCount: tileResultCount,
                outputCount: queryResultCount(result) - resultCountBefore,
                tileCount: 1,
            });
        }
    }

    const enrichStart = profile ? performance.now() : 0;
    const converted = convertFeaturesToMapFeatures(result, tileManager, sourceFeatureStateIsEmpty(sourceFeatureState));
    if (profile) {
        const resultCount = queryResultCount(result);
        recordQueryProfile(profile, 'query.enrich', enrichStart, {
            inputCount: resultCount,
            outputCount: resultCount,
            tileCount: tilesIn.length,
        });
    }
    return converted;
}

/**
 * Applies the production final ordering/flattening step to per-source query
 * results. The optional profile records one exclusive phase and has no timing
 * overhead when omitted.
 */
export function flattenAndSortRenderedFeatures(
    sourceResults: QueryRenderedFeaturesResults[],
    styleLayers: {[_: string]: StyleLayer},
    order: string[],
    profile?: QueryProfile,
): MapGeoJSONFeature[] {
    const start = profile ? performance.now() : 0;
    const isLayer3D = (layerId: string) => styleLayers[layerId].type === 'fill-extrusion';
    const layerIndex: Record<string, number> = {};
    const features3D: QueryRenderedFeaturesResultsItem[] = [];
    for (let l = order.length - 1; l >= 0; l--) {
        const layerId = order[l];
        if (isLayer3D(layerId)) {
            layerIndex[layerId] = l;
            for (const sourceResult of sourceResults) {
                const layerFeatures = sourceResult[layerId];
                if (layerFeatures) features3D.push(...layerFeatures);
            }
        }
    }

    features3D.sort((a, b) => (b.intersectionZ as number) - (a.intersectionZ as number));

    const features: MapGeoJSONFeature[] = [];
    for (let l = order.length - 1; l >= 0; l--) {
        const layerId = order[l];
        if (isLayer3D(layerId)) {
            for (let i = features3D.length - 1; i >= 0; i--) {
                const topmost3D = features3D[i].feature;
                if (layerIndex[topmost3D.layer.id] < l) break;
                features.push(topmost3D);
                features3D.pop();
            }
        } else {
            for (const sourceResult of sourceResults) {
                const layerFeatures = sourceResult[layerId];
                if (!layerFeatures) continue;
                for (const featureWrapper of layerFeatures) features.push(featureWrapper.feature);
            }
        }
    }

    if (profile) {
        recordQueryProfile(profile, 'query.flattenSort', start, {
            inputCount: sourceResults.reduce((count, result) => count + queryResultCount(result), 0),
            outputCount: features.length,
        });
    }
    return features;
}

export function queryRenderedSymbols(styleLayers: {[_: string]: StyleLayer},
    serializedLayers: {[_: string]: StyleLayer},
    tileManagers: {[_: string]: TileManager},
    queryGeometry: Point[],
    params: QueryRenderedFeaturesOptionsStrict,
    collisionIndex: CollisionIndex,
    retainedQueryData: {
        [_: number]: RetainedQueryData;
    }): QueryRenderedFeaturesResults {
    const result: QueryResults = {};
    const renderedSymbols = collisionIndex.queryRenderedSymbols(queryGeometry);
    const bucketQueryData: RetainedQueryData[] = [];
    for (const bucketInstanceId of Object.keys(renderedSymbols).map(Number)) {
        bucketQueryData.push(retainedQueryData[bucketInstanceId]);
    }
    bucketQueryData.sort(sortTilesIn);

    for (const queryData of bucketQueryData) {
        const bucketSymbols = queryData.featureIndex.lookupSymbolFeatures(
            renderedSymbols[queryData.bucketInstanceId],
            serializedLayers,
            queryData.bucketIndex,
            queryData.sourceLayerIndex,
            {
                filterSpec: params.filter,
                globalState: params.globalState
            },
            params.layers,
            params.availableImages,
            styleLayers);

        for (const layerID in bucketSymbols) {
            result[layerID] ||= [];
            const layerSymbols = bucketSymbols[layerID];
            layerSymbols.sort((a, b) => {
                // Match topDownFeatureComparator from FeatureIndex, but using
                // most recent sorting of features from bucket.sortFeatures
                const featureSortOrder = queryData.featureSortOrder;
                if (featureSortOrder) {
                    // queryRenderedSymbols documentation says we'll return features in
                    // "top-to-bottom" rendering order (aka last-to-first).
                    // Actually, there can be multiple symbol instances per feature, so
                    // we sort each feature based on the first matching symbol instance.
                    const sortedA = featureSortOrder.indexOf(a.featureIndex);
                    const sortedB = featureSortOrder.indexOf(b.featureIndex);
                    return sortedB - sortedA;
                } else {
                    // Bucket hasn't been re-sorted based on angle, so use the
                    // reverse of the order the features appeared in the data.
                    return b.featureIndex - a.featureIndex;
                }
            });
            for (const symbolFeature of layerSymbols) {
                result[layerID].push(symbolFeature);
            }
        }
    }

    return convertFeaturesToMapFeaturesMultiple(result, styleLayers, tileManagers);
}

export function querySourceFeatures(
    tileManager: TileManager,
    params: QuerySourceFeatureOptionsStrict | undefined,
    profile?: QueryProfile,
): GeoJSONFeature[] {
    const result: GeoJSONFeature[] = [];
    const dataTiles = new Set<string>();
    for (const id of tileManager.getRenderableIds()) {
        const tile = tileManager.getTileByID(id);
        const dataID = tile.tileID.canonical.key;
        const deduplicateStart = profile ? performance.now() : 0;
        const duplicate = dataTiles.has(dataID);
        if (!duplicate) dataTiles.add(dataID);
        if (profile) {
            recordQueryProfile(profile, 'query.sourceDeduplicate', deduplicateStart, {
                inputCount: 1,
                outputCount: duplicate ? 0 : 1,
                tileCount: 1,
            });
        }
        if (duplicate) continue;
        const collectStart = profile ? performance.now() : 0;
        const resultCountBefore = result.length;
        tile.querySourceFeatures(result, params);
        if (profile) {
            recordQueryProfile(profile, 'query.sourceCollectTile', collectStart, {
                outputCount: result.length - resultCountBefore,
                tileCount: 1,
            });
        }
    }

    return result;
}

function sortTilesIn(a: {tileID: OverscaledTileID}, b: {tileID: OverscaledTileID}) {
    const idA = a.tileID;
    const idB = b.tileID;
    return (idA.overscaledZ - idB.overscaledZ) || (idA.canonical.y - idB.canonical.y) || (idA.wrap - idB.wrap) || (idA.canonical.x - idB.canonical.x);
}

function mergeRenderedFeatureLayer(
    result: QueryResults,
    seenByWrappedTile: Map<string, Map<string, Set<number>>>,
    wrappedTileID: string,
    queryResults: QueryResults,
): void {
    let seenLayers = seenByWrappedTile.get(wrappedTileID);
    if (!seenLayers) {
        seenLayers = new Map();
        seenByWrappedTile.set(wrappedTileID, seenLayers);
    }

    for (const layerID in queryResults) {
        let seenFeatures = seenLayers.get(layerID);
        if (!seenFeatures) {
            seenFeatures = new Set();
            seenLayers.set(layerID, seenFeatures);
        }
        const layerResult = result[layerID] ||= [];
        for (const tileFeature of queryResults[layerID]) {
            if (seenFeatures.has(tileFeature.featureIndex)) continue;
            seenFeatures.add(tileFeature.featureIndex);
            layerResult.push(tileFeature);
        }
    }
}

function convertFeaturesToMapFeatures(result: QueryResults, tileManager: TileManager, stateIsEmpty = false): QueryRenderedFeaturesResults {
    // Merge state from TileManager into the results
    for (const layerID in result) {
        for (const featureWrapper of result[layerID]) {
            convertFeatureToMapFeature(featureWrapper, tileManager, stateIsEmpty);
        }
    }
    return result as QueryRenderedFeaturesResults;
}

function convertFeaturesToMapFeaturesMultiple(result: QueryResults, styleLayers: {[_: string]: StyleLayer}, tileManagers: {[_: string]: TileManager}): QueryRenderedFeaturesResults {
    // Merge state from TileManager into the results
    const stateIsEmptyByTileManager = new Map<TileManager, boolean>();
    for (const layerName in result) {
        for (const featureWrapper of result[layerName]) {
            const layer = styleLayers[layerName];
            const tileManager = tileManagers[layer.source];
            let stateIsEmpty = stateIsEmptyByTileManager.get(tileManager);
            if (stateIsEmpty === undefined) {
                stateIsEmpty = tileManagerStateIsEmpty(tileManager);
                stateIsEmptyByTileManager.set(tileManager, stateIsEmpty);
            }
            convertFeatureToMapFeature(featureWrapper, tileManager, stateIsEmpty);
        };
    }
    return result as QueryRenderedFeaturesResults;
}

function convertFeatureToMapFeature(featureWrapper: QueryResultsItem, tileManager: TileManager, stateIsEmpty: boolean) {
    const feature = featureWrapper.feature as MapGeoJSONFeature;
    feature.source = feature.layer.source;
    if (feature.layer['source-layer']) {
        feature.sourceLayer = feature.layer['source-layer'];
    }
    feature.state = stateIsEmpty
        ? {}
        : tileManager.getFeatureState(feature.layer['source-layer'], feature.id);
}

function tileManagerStateIsEmpty(tileManager: TileManager): boolean {
    return sourceFeatureStateIsEmpty(tileManager.getState());
}

function sourceFeatureStateIsEmpty(sourceFeatureState: any): boolean {
    return !sourceFeatureState || (
        Object.keys(sourceFeatureState.state ?? {}).length === 0 &&
        Object.keys(sourceFeatureState.stateChanges ?? {}).length === 0 &&
        Object.keys(sourceFeatureState.deletedStates ?? {}).length === 0
    );
}
