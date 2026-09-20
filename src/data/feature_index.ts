import {type VectorTileFeatureLike, type VectorTileLayerLike, GEOJSON_TILE_LAYER_NAME} from '@maplibre/vt-pbf';
import {loadGeometry} from './load_geometry.ts';
import {toEvaluationFeature} from './evaluation_feature.ts';
import {EXTENT} from './extent.ts';
import {featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {TransferableGridIndex} from '../util/transferable_grid_index.ts';
import {DictionaryCoder} from '../util/dictionary_coder.ts';
import {PbfReader} from 'pbf';
import {GeoJSONFeature} from '../util/vectortile_to_geojson.ts';
import {register} from '../util/web_worker_transfer.ts';
import {EvaluationParameters} from '../style/evaluation_parameters.ts';
import {polygonIntersectsBox} from '../util/intersection_tests.ts';
import {PossiblyEvaluated} from '../style/properties.ts';
import {FeatureIndexArray} from './array_types.g.ts';
import {getMltFeatureTable, MLTVectorTile} from '../source/vector_tile_mlt.ts';
import {Bounds} from '../geo/bounds.ts';
import {VectorTile} from '@mapbox/vector-tile';
import {sliceFeatureTable, type FeatureTable, type Vector, type TileLike} from '@maplibre/mlt';
import {forEachFeatureGeometryPart} from './bucket/columnar/geometry_traversal.ts';
import VectorUtils from './bucket/columnar/vectorUtils.ts';
import {isMltMaterializationStatsActive, MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES, MLT_ESTIMATED_RENDERED_QUERY_WRAPPER_BYTES, recordMltMaterialization} from '../util/mlt_materialization_stats.ts';
import {createMltFilterEvaluator, getMltFilterSupport, type MltFilterEvaluator} from './filter/mlt/filter.ts';
import {ColumnarEvaluationFeature, getColumnarEvaluationFeature} from './bucket/columnar/evaluation_feature.ts';
import {getColumnarPropertyValue, normalizeColumnarValue} from './bucket/columnar/feature_properties.ts';
import {normalizeMltFeatureId} from '../util/mlt_feature_id.ts';

import type {MltTileData} from '../source/mlt_tile_data.ts';
import type Point from '@mapbox/point-geometry';
import type {OverscaledTileID} from '../tile/tile_id.ts';
import type {SourceFeatureState} from '../source/source_state.ts';
import type {PossiblyEvaluatedPropertyValue} from '../style/properties.ts';
import type {mat4} from 'gl-matrix';
import type {MapGeoJSONFeature} from '../util/vectortile_to_geojson.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {ExpressionSpecification, FeatureFilter, FeatureState, FilterSpecification, PromoteIdSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {IReadonlyTransform, GetElevation} from '../geo/transform_interface.ts';
import type {TileEncoding} from '../source/worker_source.ts';
import type {FeatureGeometry} from '../util/geometry_view.ts';

export {GEOJSON_TILE_LAYER_NAME};

export type FeatureIndexBBox = [number, number, number, number];

type QueryParameters = {
    scale: number;
    pixelPosMatrix: mat4;
    transform: IReadonlyTransform;
    tileSize: number;
    queryGeometry: Point[];
    cameraQueryGeometry: Point[];
    queryPadding: number;
    getElevation: GetElevation | undefined;
    params: {
        filter?: FilterSpecification;
        layers?: Set<string> | null;
        availableImages?: string[];
        globalState?: Record<string, any>;
    };
};

export type QueryResults = {
    [_: string]: QueryResultsItem[];
};

export type QueryResultsItem = {
    featureIndex: number;
    feature: GeoJSONFeature;
    intersectionZ?: boolean | number;
};

export type MltIdResolver = (featureIndex: number) => string | number | undefined;

type PreparedQueryProperty = {
    key: string;
    property: any;
};

type PreparedQueryLayer = {
    styleLayer?: StyleLayer;
    serializedEntries: Array<[string, any]>;
    paint: PreparedQueryProperty[];
    layout: PreparedQueryProperty[];
};

type MltQuerySourceLayer = {
    sourceLayerName: string;
    sourceLayer: VectorTileLayerLike;
    featureTable: FeatureTable;
    evaluationFeature: ColumnarEvaluationFeature;
    resolveId: MltIdResolver;
};

type QueryExecutionContext = {
    collectMltStats: boolean;
    evaluationParameters: EvaluationParameters;
    styleLayers: {[_: string]: StyleLayer};
    serializedLayers: {[_: string]: any};
    sourceLayers: Map<number, MltQuerySourceLayer>;
    layers: Map<string, PreparedQueryLayer>;
};

const emptyFeatureState: FeatureState = Object.freeze({});

/**
 * An in memory index class to allow fast interaction with features
 */
export class FeatureIndex {
    tileID: OverscaledTileID;
    x: number;
    y: number;
    z: number;
    grid: TransferableGridIndex;
    grid3D: TransferableGridIndex;
    featureIndexArray: FeatureIndexArray;
    promoteId?: PromoteIdSpecification;
    encoding: TileEncoding;
    rawTileData: ArrayBuffer;
    /** When present, rawTileData holds the parent MLT; clipped query geometry is constructed only on demand. */
    mltOverzoom?: TileLike;
    /** Main-thread owner shared by sibling tiles; never serialized back to a worker. */
    mltTileData?: MltTileData;
    bucketLayerIDs: string[][];

    vtLayers: {[_: string]: VectorTileLayerLike};
    sourceLayerCoder: DictionaryCoder;
    /** Worker index order when layer projection differs from the complete raw tile decoded for public queries. */
    sourceLayerNames?: string[];

    constructor(tileID: OverscaledTileID, promoteId?: PromoteIdSpecification | null) {
        this.tileID = tileID;
        this.x = tileID.canonical.x;
        this.y = tileID.canonical.y;
        this.z = tileID.canonical.z;
        this.grid = new TransferableGridIndex(EXTENT, 16, 0);
        this.grid3D = new TransferableGridIndex(EXTENT, 16, 0);
        this.featureIndexArray = new FeatureIndexArray();
        this.promoteId = promoteId;
    }

    insert(feature: VectorTileFeatureLike, geometry: Point[][], featureIndex: number, sourceLayerIndex: number, bucketIndex: number, is3D?: boolean): void {
        const key = this.featureIndexArray.length;
        this.featureIndexArray.emplaceBack(featureIndex, sourceLayerIndex, bucketIndex);

        const grid = is3D ? this.grid3D : this.grid;

        for (const ring of geometry) {

            const bbox = [Infinity, Infinity, -Infinity, -Infinity];
            for (const p of ring) {
                bbox[0] = Math.min(bbox[0], p.x);
                bbox[1] = Math.min(bbox[1], p.y);
                bbox[2] = Math.max(bbox[2], p.x);
                bbox[3] = Math.max(bbox[3], p.y);
            }

            if (bbox[0] < EXTENT &&
                bbox[1] < EXTENT &&
                bbox[2] >= 0 &&
                bbox[3] >= 0) {
                grid.insert(key, bbox[0], bbox[1], bbox[2], bbox[3]);
            }
        }
    }

    insertFeatureTable(featureTable: FeatureTable, featureIndex: number, sourceLayerIndex: number, bucketIndex: number, is3D?: boolean): void {
        const key = this.featureIndexArray.length;
        this.featureIndexArray.emplaceBack(featureIndex, sourceLayerIndex, bucketIndex);

        const grid = is3D ? this.grid3D : this.grid;
        const scale = EXTENT / featureTable.extent;
        const geometryVector = featureTable.geometryVector;

        forEachFeatureGeometryPart(featureTable, featureIndex, (_partIndex, start, end) => {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const rawX = VectorUtils.getVertexX(geometryVector, vertexIndex);
                const rawY = VectorUtils.getVertexY(geometryVector, vertexIndex);
                const x = rawX * scale;
                const y = rawY * scale;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }

            if (minX < EXTENT &&
                minY < EXTENT &&
                maxX >= 0 &&
                maxY >= 0) {
                grid.insert(key, minX, minY, maxX, maxY);
            }
        });
    }

    insertBBoxes(featureIndex: number, sourceLayerIndex: number, bucketIndex: number, bboxes: FeatureIndexBBox[], is3D?: boolean): void {
        const key = this.featureIndexArray.length;
        this.featureIndexArray.emplaceBack(featureIndex, sourceLayerIndex, bucketIndex);

        const grid = is3D ? this.grid3D : this.grid;
        for (const bbox of bboxes) {
            if (bbox[0] < EXTENT &&
                bbox[1] < EXTENT &&
                bbox[2] >= 0 &&
                bbox[3] >= 0) {
                grid.insert(key, bbox[0], bbox[1], bbox[2], bbox[3]);
            }
        }
    }

    insertBBox(featureIndex: number, sourceLayerIndex: number, bucketIndex: number, bbox: FeatureIndexBBox, is3D?: boolean): void {
        const key = this.featureIndexArray.length;
        this.featureIndexArray.emplaceBack(featureIndex, sourceLayerIndex, bucketIndex);

        if (bbox[0] < EXTENT &&
            bbox[1] < EXTENT &&
            bbox[2] >= 0 &&
            bbox[3] >= 0) {
            const grid = is3D ? this.grid3D : this.grid;
            grid.insert(key, bbox[0], bbox[1], bbox[2], bbox[3]);
        }
    }

    loadVTLayers(): {[_: string]: VectorTileLayerLike} {
        if (!this.vtLayers) {
            switch (this.encoding) {
                case 'mlt':
                    recordMltMaterialization('rawTileMainThreadDecodes', 1, {detail: 'FeatureIndex.loadVTLayers'});
                    this.vtLayers = this.loadMltQueryLayers();
                    break;
                case 'mvt':
                default:
                    this.vtLayers = new VectorTile(new PbfReader(this.rawTileData)).layers;
            }
            this.sourceLayerCoder = new DictionaryCoder(this.sourceLayerNames ?? (this.vtLayers ? Object.keys(this.vtLayers).sort() : [GEOJSON_TILE_LAYER_NAME]));
        }
        return this.vtLayers;
    }

    /** Keeps synchronous query semantics without putting child-tile encoding on the rendering path. */
    private loadMltQueryLayers(): Record<string, VectorTileLayerLike> {
        if (this.mltOverzoom && this.mltTileData) {
            return this.mltTileData.createView(this.mltOverzoom, this.tileID.canonical, {
                deferPropertyColumns: true, layerNames: this.sourceLayerNames,
            }).layers;
        }
        const tile = new MLTVectorTile(this.rawTileData, {
            deferPropertyColumns: true,
            ...(this.mltOverzoom ? {layerNames: this.sourceLayerNames} : {}),
        });
        if (!this.mltOverzoom) return tile.layers;
        return MLTVectorTile.fromFeatureTableResolver(Object.keys(tile.layers), name => sliceFeatureTable(
            getMltFeatureTable(tile.layers[name]), this.mltOverzoom, this.tileID.canonical, {deferProperties: true},
        )).layers;
    }

    // Finds non-symbol features in this tile at a particular position.
    query(
        args: QueryParameters,
        styleLayers: {[_: string]: StyleLayer},
        serializedLayers: {[_: string]: any},
        sourceFeatureState: SourceFeatureState
    ): QueryResults {
        this.loadVTLayers();

        const params = args.params;
        const executionContext = createQueryExecutionContext(
            this.tileID.overscaledZ,
            styleLayers,
            serializedLayers,
        );
        const pixelsToTileUnits = EXTENT / args.tileSize / args.scale;
        const mltFilterSupport = this.encoding === 'mlt' && params.filter
            ? getMltFilterSupport(params.filter, params.globalState)
            : undefined;
        const mltFilterEvaluator = mltFilterSupport?.supported && params.filter
            ? createMltFilterEvaluator(params.filter as ExpressionSpecification, params.globalState, this.tileID.canonical, executionContext.evaluationParameters)
            : undefined;
        const filter = mltFilterEvaluator
            ? undefined
            : featureFilter(params.filter, 'queryRenderedFeatures filter', params.globalState);

        const queryGeometry = args.queryGeometry;
        const queryPadding = args.queryPadding * pixelsToTileUnits;

        const bounds = Bounds.fromPoints(queryGeometry);
        const matching = this.grid.query(bounds.minX - queryPadding, bounds.minY - queryPadding, bounds.maxX + queryPadding, bounds.maxY + queryPadding);

        const cameraBounds = Bounds.fromPoints(args.cameraQueryGeometry).expandBy(queryPadding);
        const matching3D = this.grid3D.query(
            cameraBounds.minX, cameraBounds.minY, cameraBounds.maxX, cameraBounds.maxY,
            (bx1, by1, bx2, by2) => {
                return polygonIntersectsBox(args.cameraQueryGeometry, bx1 - queryPadding, by1 - queryPadding, bx2 + queryPadding, by2 + queryPadding);
            });

        for (const key of matching3D) {
            matching.push(key);
        }

        matching.sort(topDownFeatureComparator);

        const result: QueryResults = {};
        let previousIndex;
        for (const index of matching) {

            // don't check the same feature more than once
            if (index === previousIndex) continue;
            previousIndex = index;

            const match = this.featureIndexArray.get(index);
            let featureGeometry: FeatureGeometry | null = null;
            this.loadMatchingFeature(
                result,
                match.bucketIndex,
                match.sourceLayerIndex,
                match.featureIndex,
                filter,
                params.layers,
                params.availableImages,
                styleLayers,
                serializedLayers,
                sourceFeatureState,
                mltFilterEvaluator,
                (feature: VectorTileFeatureLike, styleLayer: StyleLayer, featureState: FeatureState, _id, filteredGeometry) => {
                    if (!featureGeometry) {
                        if (filteredGeometry) {
                            featureGeometry = filteredGeometry;
                        } else {
                            featureGeometry = feature instanceof ColumnarEvaluationFeature
                                ? feature.getGeometryView(executionContext.collectMltStats)
                                : loadGeometry(feature);
                        }
                    }

                    return styleLayer.queryIntersectsFeature({
                        queryGeometry,
                        feature,
                        featureState,
                        geometry: featureGeometry,
                        zoom: this.z,
                        transform: args.transform,
                        pixelsToTileUnits,
                        pixelPosMatrix: args.pixelPosMatrix,
                        unwrappedTileID: this.tileID.toUnwrapped(),
                        getElevation: args.getElevation
                    });
                },
                executionContext,
            );
        }

        return result;
    }

    loadMatchingFeature(
        result: QueryResults,
        bucketIndex: number,
        sourceLayerIndex: number,
        featureIndex: number,
        filter: FeatureFilter | undefined,
        filterLayerIDs: Set<string> | undefined,
        availableImages: string[],
        styleLayers: {[_: string]: StyleLayer},
        serializedLayers: {[_: string]: any},
        sourceFeatureState?: SourceFeatureState,
        mltFilterEvaluator?: MltFilterEvaluator,
        intersectionTest?: (
            feature: VectorTileFeatureLike,
            styleLayer: StyleLayer,
            featureState: any,
            id: string | number | void,
            filteredGeometry?: FeatureGeometry,
        ) => boolean | number,
        executionContext?: QueryExecutionContext): void {

        const layerIDs = this.bucketLayerIDs[bucketIndex];
        if (filterLayerIDs && !layerIDs.some(id => filterLayerIDs.has(id)))
            return;

        const context = executionContext ?? createQueryExecutionContext(
            this.tileID.overscaledZ,
            styleLayers,
            serializedLayers,
        );
        if (this.encoding === 'mlt' && context.collectMltStats) {
            recordMltMaterialization('queryCandidates');
        }

        const mltSourceLayer = this.encoding === 'mlt'
            ? getMltQuerySourceLayer(this, context, sourceLayerIndex, featureIndex)
            : undefined;
        const sourceLayerName = mltSourceLayer?.sourceLayerName ?? this.sourceLayerCoder.decode(sourceLayerIndex);
        const sourceLayer = mltSourceLayer?.sourceLayer ?? this.vtLayers[sourceLayerName];
        const featureTable = mltSourceLayer?.featureTable;
        if (featureTable && mltFilterEvaluator && !mltFilterEvaluator.matches(featureTable, featureIndex)) {
            return;
        }
        const feature = mltSourceLayer
            ? mltSourceLayer.evaluationFeature.setIndex(featureIndex)
            : sourceLayer.feature(featureIndex);

        let filteredGeometry: FeatureGeometry | undefined;
        if (filter?.needGeometry) {
            if (this.encoding === 'mlt' && context.collectMltStats) {
                recordMltMaterialization('queryGeometriesLoaded');
            }
            const evaluationFeature = toEvaluationFeature(feature, true);
            filteredGeometry = evaluationFeature.geometry;
            if (!filter.filter(context.evaluationParameters, evaluationFeature, this.tileID.canonical)) {
                return;
            }
        } else if (filter && !filter.filter(context.evaluationParameters, feature)) {
            return;
        }

        let id: string | number | undefined;
        let idResolved = false;
        for (const layerID of layerIDs) {

            if (filterLayerIDs && !filterLayerIDs.has(layerID)) {
                continue;
            }

            const layerContext = getPreparedQueryLayer(context, layerID);
            const styleLayer = layerContext.styleLayer;

            if (!styleLayer) continue;

            if (!idResolved) {
                id = mltSourceLayer
                    ? (this.promoteId ? mltSourceLayer.resolveId(featureIndex) : feature.id)
                    : this.getId(feature, sourceLayerName);
                idResolved = true;
            }

            let featureState = emptyFeatureState;
            if (id !== undefined && sourceFeatureState) {
                // `feature-state` expression evaluation requires feature state to be available
                featureState = sourceFeatureState.getState(styleLayer.sourceLayer || GEOJSON_TILE_LAYER_NAME, id);
            }

            const intersectionZ = !intersectionTest || intersectionTest(feature, styleLayer, featureState, id, filteredGeometry);
            if (!intersectionZ) {
                // Only applied for non-symbol features
                continue;
            }

            const serializedLayer = clonePreparedObject(layerContext.serializedEntries);
            serializedLayer.paint = evaluatePreparedProperties(layerContext.paint, feature, featureState, availableImages);
            serializedLayer.layout = evaluatePreparedProperties(layerContext.layout, feature, featureState, availableImages);

            const geojsonFeature = (featureTable
                ? GeoJSONFeature.fromFeatureTable(featureTable, featureIndex, this.z, this.x, this.y, id)
                : new GeoJSONFeature(feature, this.z, this.x, this.y, id)) as MapGeoJSONFeature;
            if (this.encoding === 'mlt' && context.collectMltStats) {
                recordMltMaterialization('queryResults');
                recordMltMaterialization(
                    'estimatedQueryResultBytes',
                    MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES + MLT_ESTIMATED_RENDERED_QUERY_WRAPPER_BYTES,
                    {sourceLayerId: sourceLayerName, layerId: layerID, detail: 'shallow rendered query result estimate'},
                );
            }
            geojsonFeature.layer = serializedLayer;
            let layerResult = result[layerID];
            if (layerResult === undefined) {
                layerResult = result[layerID] = [];
            }
            layerResult.push({featureIndex, feature: geojsonFeature, intersectionZ});
        }
    }

    // Given a set of symbol indexes that have already been looked up,
    // return a matching set of GeoJSONFeatures
    lookupSymbolFeatures(symbolFeatureIndexes: number[],
        serializedLayers: {[_: string]: StyleLayer},
        bucketIndex: number,
        sourceLayerIndex: number,
        filterParams: {
            filterSpec: FilterSpecification;
            globalState: Record<string, any>;
        },
        filterLayerIDs: Set<string> | null,
        availableImages: string[],
        styleLayers: {[_: string]: StyleLayer}): QueryResults {
        const result: QueryResults = {};
        this.loadVTLayers();

        const executionContext = createQueryExecutionContext(
            this.tileID.overscaledZ,
            styleLayers,
            serializedLayers,
        );

        const mltFilterSupport = this.encoding === 'mlt' && filterParams.filterSpec
            ? getMltFilterSupport(filterParams.filterSpec, filterParams.globalState)
            : undefined;
        const mltFilterEvaluator = mltFilterSupport?.supported && filterParams.filterSpec
            ? createMltFilterEvaluator(filterParams.filterSpec as ExpressionSpecification, filterParams.globalState, this.tileID.canonical, executionContext.evaluationParameters)
            : undefined;
        const filter = mltFilterEvaluator
            ? undefined
            : featureFilter(filterParams.filterSpec, 'queryRenderedFeatures symbol filter', filterParams.globalState);

        for (const symbolFeatureIndex of symbolFeatureIndexes) {
            this.loadMatchingFeature(
                result,
                bucketIndex,
                sourceLayerIndex,
                symbolFeatureIndex,
                filter,
                filterLayerIDs,
                availableImages,
                styleLayers,
                serializedLayers,
                undefined,
                mltFilterEvaluator,
                undefined,
                executionContext,
            );

        }
        return result;
    }

    hasLayer(id: string): boolean {
        for (const layerIDs of this.bucketLayerIDs) {
            for (const layerID of layerIDs) {
                if (id === layerID) return true;
            }
        }

        return false;
    }

    getId(feature: VectorTileFeatureLike, sourceLayerId: string): string | number | undefined {
        let id: string | number | undefined = feature.id;
        if (this.promoteId) {
            const propName = typeof this.promoteId === 'string' ? this.promoteId : this.promoteId[sourceLayerId];
            id = feature.properties[propName] as string | number;
            if (typeof id === 'boolean') id = Number(id);

            // When cluster is true, the id is the cluster_id even though promoteId is set
            if (id === undefined && feature.properties?.cluster && this.promoteId) {
                id = Number(feature.properties.cluster_id);
            }
        }
        return id;
    }

    /**
     * Resolves all id/promoteId columns once, so high-cardinality query output
     * loops only perform indexed vector reads.
     */
    createMltIdResolver(featureTable: FeatureTable, sourceLayerId: string): MltIdResolver {
        if (!this.promoteId) {
            const idVector = featureTable.idVector;
            return idVector
                ? (featureIndex) => normalizeMltFeatureId(idVector.getValue(featureIndex), featureIndex)
                : (featureIndex) => featureIndex;
        }

        const propertyName = typeof this.promoteId === 'string'
            ? this.promoteId
            : this.promoteId[sourceLayerId];
        const promotedIdVector = propertyName === undefined
            ? undefined
            : featureTable.getPropertyVector(propertyName);
        const clusterVector = featureTable.getPropertyVector('cluster');
        const clusterIdVector = featureTable.getPropertyVector('cluster_id');

        return (featureIndex) => {
            const promotedId = readColumnarVector(promotedIdVector, featureIndex);
            if (promotedId !== undefined) {
                return typeof promotedId === 'boolean'
                    ? Number(promotedId)
                    : promotedId as string | number;
            }

            if (readColumnarVector(clusterVector, featureIndex)) {
                return Number(readColumnarVector(clusterIdVector, featureIndex));
            }
            return undefined;
        };
    }

    getMltId(featureTable: FeatureTable, featureIndex: number, sourceLayerId: string): string | number | undefined {
        let id: string | number | undefined = normalizeMltFeatureId(
            featureTable.idVector?.getValue(featureIndex),
            featureIndex,
        );

        if (!this.promoteId) return id;

        const propertyName = typeof this.promoteId === 'string'
            ? this.promoteId
            : this.promoteId[sourceLayerId];
        const promotedId = propertyName === undefined
            ? undefined
            : getColumnarPropertyValue(featureTable, featureIndex, propertyName);
        id = typeof promotedId === 'boolean'
            ? Number(promotedId)
            : promotedId as string | number | undefined;

        // GeoJSON cluster sources use cluster_id even when promoteId is set.
        if (id === undefined && getColumnarPropertyValue(featureTable, featureIndex, 'cluster')) {
            id = Number(getColumnarPropertyValue(featureTable, featureIndex, 'cluster_id'));
        }

        return id;
    }
}

register(
    'FeatureIndex',
    FeatureIndex,
    {omit: ['rawTileData', 'sourceLayerCoder', 'mltTileData']}
);

function createQueryExecutionContext(
    overscaledZ: number,
    styleLayers: {[_: string]: StyleLayer},
    serializedLayers: {[_: string]: any},
): QueryExecutionContext {
    return {
        collectMltStats: isMltMaterializationStatsActive(),
        evaluationParameters: new EvaluationParameters(overscaledZ),
        styleLayers,
        serializedLayers,
        sourceLayers: new Map(),
        layers: new Map(),
    };
}

function getMltQuerySourceLayer(
    featureIndex: FeatureIndex,
    context: QueryExecutionContext,
    sourceLayerIndex: number,
    initialFeatureIndex: number,
): MltQuerySourceLayer | undefined {
    const cached = context.sourceLayers.get(sourceLayerIndex);
    if (cached) return cached;

    const sourceLayerName = featureIndex.sourceLayerCoder.decode(sourceLayerIndex);
    const sourceLayer = featureIndex.vtLayers[sourceLayerName];
    const featureTable = getMltFeatureTable(sourceLayer);
    if (!featureTable) return undefined;

    const sourceContext = {
        sourceLayerName,
        sourceLayer,
        featureTable,
        evaluationFeature: getColumnarEvaluationFeature(featureTable, initialFeatureIndex),
        resolveId: featureIndex.createMltIdResolver(featureTable, sourceLayerName),
    };
    context.sourceLayers.set(sourceLayerIndex, sourceContext);
    return sourceContext;
}

function getPreparedQueryLayer(context: QueryExecutionContext, layerID: string): PreparedQueryLayer {
    let prepared = context.layers.get(layerID);
    if (prepared) return prepared;

    const styleLayer = context.styleLayers[layerID];
    const serializedLayer = context.serializedLayers[layerID];
    prepared = {
        styleLayer,
        serializedEntries: prepareObjectEntries(serializedLayer),
        paint: prepareQueryProperties(serializedLayer?.paint, styleLayer?.paint),
        layout: prepareQueryProperties(serializedLayer?.layout, styleLayer?.layout),
    };
    context.layers.set(layerID, prepared);
    return prepared;
}

function prepareObjectEntries(input: any): Array<[string, any]> {
    const entries: Array<[string, any]> = [];
    for (const key in input) entries.push([key, input[key]]);
    return entries;
}

function clonePreparedObject(entries: Array<[string, any]>): any {
    const output = {};
    for (const entry of entries) {
        output[entry[0]] = entry[1];
    }
    return output;
}

function prepareQueryProperties(serializedProperties: any, styleLayerProperties: any): PreparedQueryProperty[] {
    const properties: PreparedQueryProperty[] = [];
    for (const key in serializedProperties) {
        properties.push({
            key,
            property: styleLayerProperties instanceof PossiblyEvaluated
                ? styleLayerProperties.get(key)
                : serializedProperties[key],
        });
    }
    return properties;
}

function evaluatePreparedProperties(
    properties: PreparedQueryProperty[],
    feature: VectorTileFeatureLike,
    featureState: FeatureState,
    availableImages: string[],
): any {
    const output = {};
    for (const {key, property} of properties) {
        output[key] = needsEvaluating(property)
            ? property.evaluate(feature, featureState, undefined, availableImages)
            : property;
    }
    return output;
}

function readColumnarVector(vector: Vector | undefined, featureIndex: number): unknown {
    if (!vector) return undefined;
    if (typeof (vector as any).has === 'function' && !(vector as any).has(featureIndex)) {
        return undefined;
    }
    const value = vector.getValue(featureIndex);
    return value === null || value === undefined ? undefined : normalizeColumnarValue(value);
}

/**
 * Whether a possibly-evaluated property still has to be evaluated against a feature, as a
 * data-driven one does.
 *
 * A data-constant property is already the value it will be drawn with, and that value is often a
 * primitive -- `'map'` for an alignment, a number for an opacity -- which the `in` operator throws
 * on, so it is not reached for until the value is known to be an object.
 */
function needsEvaluating(value: unknown): value is PossiblyEvaluatedPropertyValue<unknown> {
    return typeof value === 'object' && value !== null && 'evaluate' in value;
}

function topDownFeatureComparator(a: number, b: number) {
    return b - a;
}
