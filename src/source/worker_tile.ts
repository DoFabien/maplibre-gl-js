import {FeatureIndex, type FeatureIndexBBox} from '../data/feature_index.ts';
import {CollisionBoxArray} from '../data/array_types.g.ts';
import {DictionaryCoder} from '../util/dictionary_coder.ts';
import {warnOnce, mapObject} from '../util/util.ts';
import {ImageAtlas} from '../render/image_atlas.ts';
import {GlyphAtlas} from '../render/glyph_atlas.ts';
import {EvaluationParameters} from '../style/evaluation_parameters.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {type GetDashesResponse, MessageType, type GetGlyphsResponse, type GetImagesResponse} from '../util/actor_messages.ts';
import {getMltFilterSupport, type MltFilterSupport} from '../data/filter/mlt/filter.ts';
import {recordParseProfile, type ParseProfile} from '../data/bucket.ts';

import type {Bucket, PopulateParameters} from '../data/bucket.ts';
import type {IActor} from '../util/actor.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {StyleLayerIndex} from '../style/style_layer_index.ts';
import type {
    WorkerTileParameters,
    WorkerTileWithData,
} from './worker_source.ts';
import type {PromoteIdSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileLike} from '@maplibre/vt-pbf';
import type {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import type {SelectionVector, TileLike} from '@maplibre/mlt';

type ProfileContext = {
    encoding?: 'mvt' | 'mlt';
    sourceLayerId?: string;
    layerId?: string;
    layerType?: string;
    featureCount?: number;
    detail?: string;
};

const mltFilterSupportCache = new WeakMap<StyleLayer, {
    filter: unknown;
    support: MltFilterSupport;
}>();

const COLUMNAR_MLT_LAYER_TYPES = new Set(['fill', 'line', 'fill-extrusion', 'circle', 'symbol', 'heatmap']);

function assertSupportedMltWorkerLayer(layer: StyleLayer, filterSupport: MltFilterSupport): void {
    if (!COLUMNAR_MLT_LAYER_TYPES.has(layer.type)) {
        throw new Error(`MLT no-materialization pipeline does not support ${layer.type} layer "${layer.id}".`);
    }
    if ('reason' in filterSupport) {
        throw new Error(`MLT no-materialization pipeline does not support the filter for layer "${layer.id}": ${filterSupport.reason}`);
    }
}

function getCachedMltFilterSupport(layer: StyleLayer, globalState: Record<string, unknown> | undefined): MltFilterSupport {
    if (globalState && Object.keys(globalState).length > 0) {
        return getMltFilterSupport(layer.filter, globalState);
    }

    const cached = mltFilterSupportCache.get(layer);
    if (cached?.filter === layer.filter && cached !== undefined) {
        return cached.support;
    }

    const support = getMltFilterSupport(layer.filter, globalState);
    mltFilterSupportCache.set(layer, {filter: layer.filter, support});
    return support;
}

export class WorkerTile {
    tileID: OverscaledTileID;
    uid: string | number;
    zoom: number;
    pixelRatio: number;
    tileSize: number;
    source: string;
    promoteId: PromoteIdSpecification;
    overscaling: number;
    showCollisionBoxes: boolean;
    collectResourceTiming: boolean;
    returnDependencies: boolean;
    encoding?: 'mvt' | 'mlt';
    /** Parent coordinates for deferred queries of a columnar, directly clipped MLT tile. */
    mltOverzoom?: TileLike;

    data: VectorTileLike;
    collisionBoxArray: CollisionBoxArray;

    abort: AbortController;
    vectorTile: VectorTileLike;
    /**
     * The etag of the response this tile was loaded from. A reload has no new response, so it is returned again
     * to keep the main thread's tile etag intact for the next expiry refresh.
     */
    etag?: string;
    inFlightDependencies: AbortController[];

    constructor(params: WorkerTileParameters) {
        this.tileID = new OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
        this.uid = params.uid;
        this.zoom = params.zoom;
        this.pixelRatio = params.pixelRatio;
        this.tileSize = params.tileSize;
        this.source = params.source;
        this.overscaling = this.tileID.overscaleFactor();
        this.showCollisionBoxes = params.showCollisionBoxes;
        this.collectResourceTiming = !!params.collectResourceTiming;
        this.returnDependencies = !!params.returnDependencies;
        this.promoteId = params.promoteId;
        this.encoding = params.encoding;
        if (params.encoding === 'mlt' && params.overzoomParameters) {
            const {z, x, y} = params.overzoomParameters.maxZoomTileID;
            this.mltOverzoom = {z, x, y};
        }
        this.inFlightDependencies = [];
    }

    async parse(data: VectorTileLike, layerIndex: StyleLayerIndex, availableImages: string[], actor: IActor, subdivisionGranularity: SubdivisionGranularitySetting, profile?: ParseProfile): Promise<WorkerTileWithData> {
        const parseStart = performance.now();
        const profileStartIndex = profile?.records.length ?? 0;
        this.data = data;

        this.collisionBoxArray = new CollisionBoxArray();
        const sourceLayerNames = Object.keys(data.layers).sort();
        const sourceLayerCoder = new DictionaryCoder(sourceLayerNames);

        const featureIndex = new FeatureIndex(this.tileID, this.promoteId);
        featureIndex.mltOverzoom = this.mltOverzoom;
        featureIndex.bucketLayerIDs = [];
        featureIndex.sourceLayerCoder = sourceLayerCoder;
        if (this.encoding === 'mlt') featureIndex.sourceLayerNames = sourceLayerNames;

        const buckets: {[_: string]: Bucket} = {};

        const options: PopulateParameters = {
            featureIndex,
            iconDependencies: {},
            patternDependencies: {},
            glyphDependencies: {},
            dashDependencies: {},
            availableImages,
            subdivisionGranularity,
            profile
        };
        const recordProfileDuration = (phase: string, duration: number, context: ProfileContext = {}, kind: 'exclusive' | 'aggregate' = 'exclusive') => {
            recordParseProfile(profile, {
                phase,
                duration,
                kind,
                encoding: this.encoding,
                ...context
            });
        };
        const recordProfile = (phase: string, start: number, context: ProfileContext = {}, kind: 'exclusive' | 'aggregate' = 'exclusive') => {
            recordProfileDuration(phase, performance.now() - start, context, kind);
        };
        const finishNestedProfile = (phase: string, start: number, nestedRecordStart: number, context: ProfileContext = {}) => {
            const duration = performance.now() - start;
            const nestedExclusiveDuration = profile?.records
                .slice(nestedRecordStart)
                .filter((record) => record.kind !== 'aggregate')
                .reduce((total, record) => total + record.duration, 0) ?? 0;
            recordProfileDuration(`${phase}.self`, Math.max(0, duration - nestedExclusiveDuration), context);
            recordProfileDuration(`${phase}.total`, duration, context, 'aggregate');
        };

        const layerFamilies = layerIndex.familiesBySource[this.source];
        for (const sourceLayerId in layerFamilies) {
            const sourceLayer = data.layers[sourceLayerId];
            if (!sourceLayer) {
                continue;
            }

            if (sourceLayer.version === 1) {
                warnOnce(`Vector tile source "${this.source}" layer "${sourceLayerId}" ` +
                    'does not use vector tile spec v2 and therefore may have some rendering errors.');
            }

            const sourceLayerIndex = sourceLayerCoder.encode(sourceLayerId);
            const featureTable = this.encoding === 'mlt' ? (sourceLayer as any).featureTable : undefined;
            if (this.encoding === 'mlt' && !featureTable) {
                throw new Error(`MLT layer "${sourceLayerId}" is missing its FeatureTable.`);
            }

            // The legacy MVT pipeline consumes materialized features. MLT must never reach this
            // helper: unsupported MLT layers and filters are rejected before bucket creation.
            let allFeatures: Array<{feature: any; id: any; index: number; sourceLayerIndex: number}> | null = null;
            const getAllFeatures = () => {
                if (this.encoding === 'mlt') {
                    throw new Error(`Internal error: MLT layer "${sourceLayerId}" reached the legacy feature materialization path.`);
                }
                if (!allFeatures) {
                    const materializeStart = performance.now();
                    allFeatures = [];
                    for (let index = 0; index < sourceLayer.length; index++) {
                        const feature = sourceLayer.feature(index);
                        const id = featureIndex.getId(feature, sourceLayerId);
                        allFeatures.push({feature, id, index, sourceLayerIndex});
                    }
                    recordProfile('materializeFeatures', materializeStart, {sourceLayerId, featureCount: sourceLayer.length});
                }
                return allFeatures;
            };

            for (const family of layerFamilies[sourceLayerId]) {
                const layer = family[0];

                if (layer.source !== this.source) {
                    warnOnce(`layer.source = ${layer.source} does not equal this.source = ${this.source}`);
                }
                if (layer.isHidden(this.zoom, true)) continue;
                const recalculateStart = performance.now();
                recalculateLayers(family, this.zoom, availableImages);
                recordProfile('recalculateLayer', recalculateStart, {sourceLayerId, layerId: layer.id, layerType: layer.type});

                const globalState = layer.getGlobalState();
                const filterSupportStart = performance.now();
                const mltFilterSupport: MltFilterSupport = this.encoding === 'mlt'
                    ? getCachedMltFilterSupport(layer, globalState)
                    : {supported: true};
                recordProfile('filterSupport', filterSupportStart, {sourceLayerId, layerId: layer.id, layerType: layer.type, detail: mltFilterSupport.supported ? 'supported' : ('reason' in mltFilterSupport ? mltFilterSupport.reason : 'unsupported')});
                if (this.encoding === 'mlt') {
                    assertSupportedMltWorkerLayer(layer, mltFilterSupport);
                }

                const createBucketStart = performance.now();
                const bucket = buckets[layer.id] = layer.createBucket({
                    index: featureIndex.bucketLayerIDs.length,
                    layers: family,
                    zoom: this.zoom,
                    pixelRatio: this.pixelRatio,
                    overscaling: this.overscaling,
                    collisionBoxArray: this.collisionBoxArray,
                    sourceLayerIndex,
                    sourceID: this.source,
                    encoding: this.encoding
                });
                recordProfile('createBucket', createBucketStart, {sourceLayerId, layerId: layer.id, layerType: layer.type});

                if (this.encoding === 'mlt') {
                    if (!(bucket as any).isColumnar) {
                        throw new Error(`MLT no-materialization v1 requires a columnar bucket for ${layer.type} layer "${layer.id}".`);
                    }

                    const populateStart = performance.now();
                    const populateProfileStart = profile?.records.length ?? 0;
                    options.skipLayerFeatureFilter = true;
                    try {
                        bucket.populate(featureTable, options, this.tileID.canonical);
                    } finally {
                        options.skipLayerFeatureFilter = false;
                    }
                    finishNestedProfile('bucket.populate', populateStart, populateProfileStart, {sourceLayerId, layerId: layer.id, layerType: layer.type, featureCount: featureTable.numFeatures, detail: 'columnar'});
                    if (layer.type !== 'symbol' && featureTable.geometryVector) {
                        const featureIndexStart = performance.now();
                        const selectionVector = (bucket as any).featureIndexSelectionVector as SelectionVector | undefined;
                        const bucketFeatureIndexBBoxes = (bucket as any).featureIndexBBoxes as Array<FeatureIndexBBox[] | FeatureIndexBBox> | undefined;
                        if (!selectionVector) {
                            throw new Error(`MLT columnar ${layer.type} bucket "${layer.id}" did not expose its feature-index selection.`);
                        }
                        for (let i = 0; i < selectionVector.limit; i++) {
                            const selectedFeatureIndex = Number(selectionVector.getIndex(i));
                            const bboxes = bucketFeatureIndexBBoxes?.[selectedFeatureIndex];
                            if (bboxes) {
                                if (typeof bboxes[0] === 'number') {
                                    featureIndex.insertBBox(selectedFeatureIndex, sourceLayerIndex, featureIndex.bucketLayerIDs.length, bboxes as FeatureIndexBBox, layer.type === 'fill-extrusion');
                                } else {
                                    featureIndex.insertBBoxes(selectedFeatureIndex, sourceLayerIndex, featureIndex.bucketLayerIDs.length, bboxes as FeatureIndexBBox[], layer.type === 'fill-extrusion');
                                }
                            } else {
                                featureIndex.insertFeatureTable(
                                    featureTable,
                                    selectedFeatureIndex,
                                    sourceLayerIndex,
                                    featureIndex.bucketLayerIDs.length,
                                    layer.type === 'fill-extrusion'
                                );
                            }
                        }
                        recordProfile('featureIndex', featureIndexStart, {sourceLayerId, layerId: layer.id, layerType: layer.type, featureCount: selectionVector.limit, detail: bucketFeatureIndexBBoxes ? 'bucketBBoxes' : 'featureTable'});
                    }
                } else {
                    const populateStart = performance.now();
                    const populateProfileStart = profile?.records.length ?? 0;
                    bucket.populate(getAllFeatures(), options, this.tileID.canonical);
                    finishNestedProfile('bucket.populate', populateStart, populateProfileStart, {sourceLayerId, layerId: layer.id, layerType: layer.type, featureCount: allFeatures?.length, detail: 'legacy'});
                }
                featureIndex.bucketLayerIDs.push(family.map((l) => l.id));
            }
        }

        const dependencyCollectStart = performance.now();
        const stacks = mapObject(options.glyphDependencies, (glyphs) => Object.keys(glyphs));

        for (const request of this.inFlightDependencies) {
            request?.abort();
        }
        this.inFlightDependencies = [];

        let getGlyphsPromise = Promise.resolve<GetGlyphsResponse>({});
        if (Object.keys(stacks).length) {
            const abortController = new AbortController();
            this.inFlightDependencies.push(abortController);
            getGlyphsPromise = actor.sendAsync({type: MessageType.getGlyphs, data: {stacks, source: this.source, tileID: this.tileID, type: 'glyphs'}}, abortController);
        }

        const icons = Object.keys(options.iconDependencies);
        let getIconsPromise = Promise.resolve<GetImagesResponse>({});
        if (icons.length) {
            const abortController = new AbortController();
            this.inFlightDependencies.push(abortController);
            getIconsPromise = actor.sendAsync({type: MessageType.getImages, data: {icons, source: this.source, tileID: this.tileID, type: 'icons'}}, abortController);
        }

        const patterns = Object.keys(options.patternDependencies);
        let getPatternsPromise = Promise.resolve<GetImagesResponse>({});
        if (patterns.length) {
            const abortController = new AbortController();
            this.inFlightDependencies.push(abortController);
            getPatternsPromise = actor.sendAsync({type: MessageType.getImages, data: {icons: patterns, source: this.source, tileID: this.tileID, type: 'patterns'}}, abortController);
        }

        const dashes = options.dashDependencies;
        let getDashesPromise = Promise.resolve<GetDashesResponse>({} as GetDashesResponse);
        if (Object.keys(dashes).length) {
            const abortController = new AbortController();
            this.inFlightDependencies.push(abortController);
            getDashesPromise = actor.sendAsync({type: MessageType.getDashes, data: {dashes}}, abortController);
        }
        recordProfile('dependencyCollect', dependencyCollectStart);

        const dependencyFetchStart = performance.now();
        const [glyphMap, iconMap, patternMap, dashPositions] = await Promise.all([getGlyphsPromise, getIconsPromise, getPatternsPromise, getDashesPromise]);
        recordProfile('dependencyFetch', dependencyFetchStart);

        const atlasStart = performance.now();
        const glyphAtlas = new GlyphAtlas(glyphMap);
        const imageAtlas = new ImageAtlas(iconMap, patternMap);
        recordProfile('atlasCreate', atlasStart);

        for (const key in buckets) {
            const bucket = buckets[key];
            if (!bucket.hasDependencies) continue;

            const addFeaturesStart = performance.now();
            const addFeaturesProfileStart = profile?.records.length ?? 0;
            recalculateLayers(bucket.layers, this.zoom, availableImages);
            bucket.addFeatures({
                options,
                canonical: this.tileID.canonical,
                glyphMap,
                glyphPositions: glyphAtlas.positions,
                iconMap,
                iconPositions: imageAtlas.iconPositions,
                patternMap,
                patternPositions: imageAtlas.patternPositions,
                dashPositions,
                showCollisionBoxes: this.showCollisionBoxes
            });
            finishNestedProfile(bucket.layers[0].type === 'symbol' ? 'symbolLayout' : 'bucket.addFeatures', addFeaturesStart, addFeaturesProfileStart, {layerId: key, layerType: bucket.layers[0].type});
        }

        const result = {
            buckets: Object.values(buckets).filter(b => !b.isEmpty()),
            featureIndex,
            collisionBoxArray: this.collisionBoxArray,
            glyphAtlasImage: glyphAtlas.image,
            imageAtlas,
            dashPositions,
            // Only used for benchmarking:
            glyphMap: this.returnDependencies ? glyphMap : null,
            iconMap: this.returnDependencies ? iconMap : null,
            glyphPositions: this.returnDependencies ? glyphAtlas.positions : null
        };
        const parseDuration = performance.now() - parseStart;
        const attributedDuration = profile?.records
            .slice(profileStartIndex)
            .filter((record) => record.kind !== 'aggregate')
            .reduce((total, record) => total + record.duration, 0) ?? 0;
        recordProfileDuration('parse.unattributed', Math.max(0, parseDuration - attributedDuration));
        recordProfileDuration('parse.total', parseDuration, {}, 'aggregate');
        return result;
    }
}

function recalculateLayers(layers: readonly StyleLayer[], zoom: number, availableImages: string[]) {
    // Layers are shared and may have been used by a WorkerTile with a different zoom.
    const parameters = new EvaluationParameters(zoom);
    for (const layer of layers) {
        layer.recalculate(parameters, availableImages);
    }
}
