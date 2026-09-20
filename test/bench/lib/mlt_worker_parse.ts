import {readFileSync} from 'fs';
import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {WorkerTile} from '../../../src/source/worker_tile.ts';
import {OverscaledTileID} from '../../../src/tile/tile_id.ts';
import {StyleLayerIndex} from '../../../src/style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../../../src/render/subdivision_granularity_settings.ts';
import {MessageType} from '../../../src/util/actor_messages.ts';
import {AlphaImage, RGBAImage} from '../../../src/util/image.ts';
import {getMltFeatureTable, MLTVectorTile, type MLTVectorTileOptions} from '../../../src/source/vector_tile_mlt.ts';
import {createMltDecodeOptions, VectorTileWorkerSource} from '../../../src/source/vector_tile_worker_source.ts';
import {deserialize, serialize} from '../../../src/util/web_worker_transfer.ts';
import {recordMltMaterialization} from '../../../src/util/mlt_materialization_stats.ts';
import {Tile} from '../../../src/tile/tile.ts';
import Point from '@mapbox/point-geometry';
import {MercatorTransform} from '../../../src/geo/projection/mercator_transform.ts';
import {CanonicalTileID} from '../../../src/tile/tile_id.ts';
import {forEachFeatureVertex} from '../../../src/data/bucket/columnar/geometry_traversal.ts';
import {FeatureIndex} from '../../../src/data/feature_index.ts';
import {flattenAndSortRenderedFeatures, queryRenderedFeatures as queryPublicRenderedFeatures, querySourceFeatures as queryPublicSourceFeatures, type QueryProfile} from '../../../src/source/query_features.ts';
import {
    BitVector,
    createConstGeometryVector,
    createStringDictionaryVector,
    createStringFlatVector,
    createStringFsstDictionaryVector,
    encodeFeatureTables,
    FeatureTable,
    GEOMETRY_TYPE,
    Int32ConstVector,
    Int32SequenceVector,
    Int64SequenceVector,
    IntFlatVector,
    scanTilePhysicalTechniques,
    TopologyVector,
    type Vector,
} from '@maplibre/mlt';
import {
    createSyntheticLegacyLineFeatures,
    createSyntheticLegacyPointFeatures,
    createSyntheticLegacyPolygonFeatures,
    createSyntheticLineFeatureTable,
    createSyntheticPointFeatureTable,
    createSyntheticPolygonFeatureTable,
    syntheticLineFeatures,
    syntheticLineLayer,
    syntheticPointFeatures,
    syntheticPointLayer,
    syntheticPolygonFeatures,
    syntheticPolygonLayer,
    type SyntheticLineFeature,
    type SyntheticPointFeature,
    type SyntheticPolygonFeature,
} from '../../unit/lib/mlt_synthetic.ts';

import {fromVectorTileJs, type VectorTileFeatureLike, type VectorTileLayerLike, type VectorTileLike} from '@maplibre/vt-pbf';
import type {ParseProfile, ParseProfileRecord} from '../../../src/data/bucket.ts';
import type {WorkerTileParameters} from '../../../src/source/worker_source.ts';
import type {StyleImage} from '../../../src/style/style_image.ts';
import type {IActor} from '../../../src/util/actor.ts';
import type {TileManager} from '../../../src/tile/tile_manager.ts';

type Encoding = 'mvt' | 'mlt';
type SyntheticLayer = 'all' | 'line' | 'fill' | 'circle' | 'fill-extrusion' | 'symbol' | 'symbol-line';
export type LineSymbolMatrixConfig = {
    name: string;
    featureCount: number;
    partsPerFeature: number;
    verticesPerPart: number;
    clippedFraction: number;
    mergeChainLength: number;
};

export const mltLineSymbolMatrixCases: readonly LineSymbolMatrixConfig[] = [
    {name: 'sparse', featureCount: 64, partsPerFeature: 1, verticesPerPart: 8, clippedFraction: 0, mergeChainLength: 1},
    {name: 'dense', featureCount: 1024, partsPerFeature: 1, verticesPerPart: 8, clippedFraction: 0, mergeChainLength: 1},
    {name: 'multipart', featureCount: 256, partsPerFeature: 4, verticesPerPart: 16, clippedFraction: 0, mergeChainLength: 1},
    {name: 'vertex-dense', featureCount: 256, partsPerFeature: 1, verticesPerPart: 64, clippedFraction: 0, mergeChainLength: 1},
    {name: 'clipped-half', featureCount: 256, partsPerFeature: 2, verticesPerPart: 16, clippedFraction: 0.5, mergeChainLength: 1},
    {name: 'merge-short', featureCount: 512, partsPerFeature: 1, verticesPerPart: 2, clippedFraction: 0, mergeChainLength: 8},
    {name: 'merge-long', featureCount: 2048, partsPerFeature: 1, verticesPerPart: 2, clippedFraction: 0, mergeChainLength: 2048},
];
type RenderedQueryCardinality = '0' | '1' | '10' | 'many';
type SourceQuerySelectivity = '1pct' | '10pct' | '100pct';
export type QueryResultAccess = 'none' | 'metadata' | 'property-one' | 'properties' | 'geometry' | 'json';
export type QueryTemperature = 'first' | 'warm';
export type QueryIdMode = 'int32' | 'signed-int64' | 'absent' | 'promote-id';
type QueryIntersectionMode = 'stub' | 'real';
type ColumnReadMode = 'few' | 'many';
type OmtCorpus = 'building' | 'roads-labels' | 'lowzoom-labels';
type TransferStrategy = 'raw-copy' | 'raw-shared' | 'query-snapshot' | 'feature-tables';
type ProfileSummaryRow = {
    phase: string;
    kind: 'exclusive' | 'aggregate';
    encoding?: string;
    layerType?: string;
    layerId?: string;
    detail?: string;
    total: number;
    mean: number;
    percent: number;
    calls: number;
    features?: number;
};

export type BenchmarkMemorySnapshot = {
    heapUsed: number;
    rss: number;
    external: number;
    arrayBuffers: number;
};

export type BenchmarkIterationMetrics = {
    transferredBytes?: number;
    retainedBytes?: number;
    phaseMemoryBytes?: Record<string, BenchmarkMemorySnapshot>;
    values?: Record<string, number>;
};

export type BenchmarkWorkload = {
    corpus: readonly string[];
    parameters: Record<string, string | number | boolean | null>;
    operation: string;
    operationsPerIteration: number;
};

type GcGlobal = typeof globalThis & {gc?: () => void};

function retainedMemorySnapshot(): BenchmarkMemorySnapshot {
    (globalThis as GcGlobal).gc?.();
    const {heapUsed, rss, external, arrayBuffers} = process.memoryUsage();
    return {heapUsed, rss, external, arrayBuffers};
}

export abstract class Benchmark {
    abstract setup(): Promise<void>;
    abstract bench(): void | Promise<void>;

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: [],
            parameters: {},
            operation: 'iteration',
            operationsPerIteration: 1,
        };
    }

    takeIterationMetrics(): BenchmarkIterationMetrics | undefined {
        return undefined;
    }
}

const featureCopies = 160;
const iconNames = ['marker', 'star', 'dot', 'stripe', 'grid', 'cross'];
const tileID = new OverscaledTileID(1, 0, 1, 1, 1);
const realTileNames = ['14-8802-5374', '14-8802-5375', '14-8803-5374', '14-8803-5375'];

function offsetParts(parts: SyntheticLineFeature['parts'], copyIndex: number): SyntheticLineFeature['parts'] {
    const offset = (copyIndex % 16) * 8;
    return parts.map(part => part.map(([x, y]) => [x, y + offset]));
}

function offsetRings(rings: SyntheticPolygonFeature['rings'], copyIndex: number): SyntheticPolygonFeature['rings'] {
    const offset = (copyIndex % 16) * 8;
    return rings.map(ring => ring.map(([x, y]) => [x + offset, y]));
}

function offsetPoint(point: SyntheticPointFeature['point'], copyIndex: number): SyntheticPointFeature['point'] {
    return [point[0] + (copyIndex % 16) * 8, point[1] + (Math.floor(copyIndex / 16) % 16) * 8];
}

function copyId(id: number | null | undefined, copyIndex: number): number | null | undefined {
    return id == null ? id : id + copyIndex * 1000;
}

function createLineFeatures(): SyntheticLineFeature[] {
    const base = syntheticLineFeatures();
    const features: SyntheticLineFeature[] = [];
    for (let copy = 0; copy < featureCopies; copy++) {
        for (const feature of base) {
            features.push({
                id: copyId(feature.id, copy),
                parts: offsetParts(feature.parts, copy),
                properties: {
                    ...feature.properties,
                    rank: feature.properties.rank + (copy % 4),
                    sort: copy * base.length + features.length % base.length,
                },
            });
        }
    }
    return features;
}

function createLineSymbolMatrixFeatures(config: LineSymbolMatrixConfig): SyntheticLineFeature[] {
    if (config.featureCount <= 0 || config.partsPerFeature <= 0 || config.verticesPerPart < 2) {
        throw new Error(`Invalid line-symbol matrix dimensions for ${config.name}`);
    }
    if (config.clippedFraction < 0 || config.clippedFraction > 1 || config.mergeChainLength <= 0) {
        throw new Error(`Invalid line-symbol matrix rates for ${config.name}`);
    }
    const features: SyntheticLineFeature[] = [];
    const clippedFeatureCount = Math.round(config.featureCount * config.clippedFraction);
    const chainLength = Math.max(1, Math.min(config.mergeChainLength, config.featureCount));
    for (let featureIndex = 0; featureIndex < config.featureCount; featureIndex++) {
        const chainIndex = Math.floor(featureIndex / chainLength);
        const segmentIndex = featureIndex % chainLength;
        const clipped = featureIndex < clippedFeatureCount;
        const chainStart = clipped ? -512 : 256;
        const chainEnd = clipped ? 4608 : 3840;
        const segmentStart = chainStart + (chainEnd - chainStart) * segmentIndex / chainLength;
        const segmentEnd = chainStart + (chainEnd - chainStart) * (segmentIndex + 1) / chainLength;
        const parts: SyntheticLineFeature['parts'] = [];
        for (let partIndex = 0; partIndex < config.partsPerFeature; partIndex++) {
            const y = 256 + (chainIndex % 28) * 128 + partIndex * 16;
            const part: Array<[number, number]> = [];
            for (let vertexIndex = 0; vertexIndex < config.verticesPerPart; vertexIndex++) {
                const t = vertexIndex / (config.verticesPerPart - 1);
                part.push([
                    Math.round(segmentStart + (segmentEnd - segmentStart) * t),
                    y + Math.round(Math.sin(t * Math.PI) * 12),
                ]);
            }
            parts.push(part);
        }
        features.push({
            id: featureIndex,
            parts,
            properties: {
                kind: `matrix-${chainIndex}`,
                rank: featureIndex % 8,
                sort: featureIndex,
                width: 4,
                opacity: 8,
                dash: 0,
                pattern: 'stripe',
                mapbox_clip_start: 0,
                mapbox_clip_end: 1,
            },
        });
    }
    return features;
}

function createPolygonFeatures(): SyntheticPolygonFeature[] {
    const base = syntheticPolygonFeatures();
    const features: SyntheticPolygonFeature[] = [];
    for (let copy = 0; copy < featureCopies; copy++) {
        for (const feature of base) {
            features.push({
                id: copyId(feature.id, copy),
                rings: offsetRings(feature.rings, copy),
                properties: {
                    ...feature.properties,
                    height: feature.properties.height + (copy % 5),
                    sort: copy * base.length + features.length % base.length,
                },
            });
        }
    }
    return features;
}

function createPointFeatures(copies = featureCopies): SyntheticPointFeature[] {
    const base = syntheticPointFeatures();
    const features: SyntheticPointFeature[] = [];
    for (let copy = 0; copy < copies; copy++) {
        for (const feature of base) {
            features.push({
                id: copyId(feature.id, copy),
                point: offsetPoint(feature.point, copy),
                properties: {
                    ...feature.properties,
                    radius: feature.properties.radius + (copy % 3),
                    sort: copy * base.length + features.length % base.length,
                    label: `${feature.properties.label}-${copy}`,
                },
            });
        }
    }
    return features;
}

function createSyntheticLegacyLayer(name: string, features: Array<{feature: VectorTileFeatureLike}>): VectorTileLayerLike {
    return {
        version: 2,
        name,
        extent: 4096,
        length: features.length,
        feature: (index: number) => features[index].feature,
    };
}

function createLegacyTile(lines: SyntheticLineFeature[], polygons: SyntheticPolygonFeature[], points: SyntheticPointFeature[]): VectorTileLike {
    return {
        layers: {
            [syntheticLineLayer]: createSyntheticLegacyLayer(syntheticLineLayer, createSyntheticLegacyLineFeatures(lines)),
            [syntheticPolygonLayer]: createSyntheticLegacyLayer(syntheticPolygonLayer, createSyntheticLegacyPolygonFeatures(polygons)),
            [syntheticPointLayer]: createSyntheticLegacyLayer(syntheticPointLayer, createSyntheticLegacyPointFeatures(points)),
        },
    };
}

function createDecodedSyntheticMvtTile(layerName: string, features: Array<{feature: VectorTileFeatureLike}>): VectorTile {
    const encoded = fromVectorTileJs({
        layers: {
            [layerName]: createSyntheticLegacyLayer(layerName, features),
        },
    });
    const tile = new VectorTile(new PbfReader(encoded));
    const layer = tile.layers[layerName];
    if (layer.length > 0 && layer.feature(0) === layer.feature(0)) {
        throw new Error('Synthetic MVT query layer must return an independent feature wrapper per access.');
    }
    return tile;
}

function createMltTile(lines: SyntheticLineFeature[], polygons: SyntheticPolygonFeature[], points: SyntheticPointFeature[]): MLTVectorTile {
    return MLTVectorTile.fromFeatureTables([
        createSyntheticLineFeatureTable(lines),
        createSyntheticPolygonFeatureTable(polygons),
        createSyntheticPointFeatureTable(points),
    ]);
}

function syntheticImages(): Record<string, StyleImage> {
    const images: Record<string, StyleImage> = {};
    for (const name of iconNames) {
        images[name] = {
            data: new RGBAImage({width: 16, height: 16}, new Uint8Array(16 * 16 * 4).fill(255)),
            pixelRatio: 1,
            sdf: false,
        };
    }
    return images;
}

function syntheticGlyphs() {
    const glyphMap: Record<number, unknown> = {};
    for (let id = 32; id < 128; id++) {
        glyphMap[id] = {
            id,
            bitmap: new AlphaImage({width: 1, height: 1}, new Uint8Array([255])),
            metrics: {width: 1, height: 1, left: 0, top: 0, advance: 1},
        };
    }
    return {Test: glyphMap};
}

function createSyntheticActor(): IActor {
    const images = syntheticImages();
    const glyphs = syntheticGlyphs();
    return {
        sendAsync({type: messageType, data}: any) {
            if (messageType === MessageType.getGlyphs) {
                return Promise.resolve(glyphs);
            }
            if (messageType === MessageType.getImages) {
                return Promise.resolve(Object.fromEntries(data.icons.map((icon: string) => [icon, images[icon]])));
            }
            if (messageType === MessageType.getDashes) {
                return Promise.resolve(Object.fromEntries(
                    Object.keys(data.dashes).map((dashId) => [dashId, {y: 0, height: 16, width: 256}])
                ));
            }
            return Promise.resolve({});
        }
    };
}

function createWorkerTile(encoding: Encoding): WorkerTile {
    return new WorkerTile({
        type: 'benchmark',
        uid: '0',
        zoom: tileID.overscaledZ,
        maxZoom: 20,
        tileSize: 512,
        pixelRatio: 1,
        showCollisionBoxes: false,
        collectResourceTiming: false,
        returnDependencies: false,
        promoteId: undefined,
        subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        source: 'source',
        tileID,
        encoding,
    } as any as WorkerTileParameters);
}

function summarizeProfile(records: ParseProfileRecord[], iterations: number): ProfileSummaryRow[] {
    const totalDuration = records
        .filter(record => record.phase === 'parse.total')
        .reduce((sum, record) => sum + record.duration, 0) || records.reduce((sum, record) => sum + record.duration, 0);
    const groups = new Map<string, ProfileSummaryRow>();

    for (const record of records) {
        const key = [
            record.phase,
            record.encoding ?? '',
            record.layerType ?? '',
            record.layerId ?? '',
            record.detail ?? '',
            record.kind ?? 'exclusive',
        ].join('|');
        let row = groups.get(key);
        if (!row) {
            row = {
                phase: record.phase,
                kind: record.kind ?? 'exclusive',
                encoding: record.encoding,
                layerType: record.layerType,
                layerId: record.layerId,
                detail: record.detail,
                total: 0,
                mean: 0,
                percent: 0,
                calls: 0,
                features: undefined,
            };
            groups.set(key, row);
        }
        row.total += record.duration;
        row.calls++;
        if (record.featureCount !== undefined) {
            row.features = (row.features ?? 0) + record.featureCount;
        }
    }

    return Array.from(groups.values())
        .map(row => ({
            ...row,
            mean: row.total / iterations,
            percent: totalDuration ? row.total / totalDuration * 100 : 0,
            features: row.features === undefined ? undefined : Math.round(row.features / row.calls),
        }))
        .sort((a, b) => b.mean - a.mean);
}

function createNativeLayerSpecs(layer: SyntheticLayer = 'all'): any[] {
    const specs = [
        {
            id: 'synthetic-line-native',
            source: 'source',
            'source-layer': syntheticLineLayer,
            type: 'line',
            filter: ['match', ['get', 'kind'], ['primary', 'secondary'], true, false],
            layout: {'line-sort-key': ['get', 'sort']},
            paint: {
                'line-width': ['get', 'width'],
                'line-opacity': ['/', ['get', 'opacity'], 10],
            },
        },
        {
            id: 'synthetic-fill-native',
            source: 'source',
            'source-layer': syntheticPolygonLayer,
            type: 'fill',
            filter: ['all', ['>=', ['get', 'height'], 10], ['!=', ['get', 'kind'], 'outside']],
            layout: {'fill-sort-key': ['get', 'sort']},
            paint: {'fill-opacity': ['/', ['get', 'opacity'], 10]},
        },
        {
            id: 'synthetic-circle-native',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'circle',
            filter: ['all', ['!=', ['get', 'category'], 'hidden'], ['coalesce', ['==', ['get', 'category'], 'poi'], false]],
            layout: {'circle-sort-key': ['get', 'sort']},
            paint: {'circle-radius': ['get', 'radius']},
        },
        {
            id: 'synthetic-fill-extrusion-native',
            source: 'source',
            'source-layer': syntheticPolygonLayer,
            type: 'fill-extrusion',
            filter: ['all', ['>=', ['get', 'height'], 6], ['>=', ['get', 'base'], 2]],
            paint: {
                'fill-extrusion-height': ['get', 'height'],
                'fill-extrusion-base': ['get', 'base'],
            },
        },
        {
            id: 'synthetic-symbol-native',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'symbol',
            filter: ['!=', ['get', 'category'], 'hidden'],
            layout: {
                'text-field': ['get', 'label'],
                'text-font': ['literal', ['Test']],
                'text-size': 12,
                'icon-image': ['get', 'icon'],
                'icon-allow-overlap': true,
                'text-allow-overlap': true,
                'symbol-sort-key': ['get', 'sort'],
            },
        },
    ];

    if (layer === 'symbol-line') {
        return [{
            id: 'synthetic-symbol-line-native',
            source: 'source',
            'source-layer': syntheticLineLayer,
            type: 'symbol',
            filter: ['!=', ['get', 'kind'], 'hidden'],
            layout: {
                'symbol-placement': 'line',
                'text-field': ['get', 'kind'],
                'text-font': ['literal', ['Test']],
                'text-size': 12,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'symbol-sort-key': ['get', 'sort'],
            },
        }];
    }

    return layer === 'all' ? specs : specs.filter(spec => spec.type === layer);
}

export default class MltWorkerParse extends Benchmark {
    encoding: Encoding;
    syntheticLayer: SyntheticLayer;
    data: VectorTileLike;
    layerIndex: StyleLayerIndex;
    actor: IActor;
    private lineFeatureCount = 0;

    constructor(
        encoding: Encoding,
        syntheticLayer: SyntheticLayer = 'all',
        private readonly parsesPerIteration = 1,
        private readonly lineSymbolMatrix?: LineSymbolMatrixConfig,
    ) {
        super();
        this.encoding = encoding;
        this.syntheticLayer = syntheticLayer;
    }

    async setup(): Promise<void> {
        const lines = this.lineSymbolMatrix ? createLineSymbolMatrixFeatures(this.lineSymbolMatrix) : createLineFeatures();
        this.lineFeatureCount = lines.length;
        const polygons = createPolygonFeatures();
        const points = createPointFeatures();
        this.data = this.encoding === 'mvt'
            ? createLegacyTile(lines, polygons, points)
            : createMltTile(lines, polygons, points);
        this.layerIndex = new StyleLayerIndex(createNativeLayerSpecs(this.syntheticLayer));
        this.actor = createSyntheticActor();
        await this.parse();
    }

    async bench(): Promise<void> {
        for (let parse = 0; parse < this.parsesPerIteration; parse++) await this.parse();
    }

    getWorkload(): BenchmarkWorkload {
        const featuresPerLayer = this.syntheticLayer === 'symbol-line'
            ? this.lineFeatureCount
            : featureCopies * syntheticPointFeatures().length;
        const matrix = this.lineSymbolMatrix;
        return {
            corpus: [matrix ? `synthetic/line-symbol-matrix/${matrix.name}` : 'synthetic/lines-polygons-points'],
            parameters: {
                encoding: this.encoding,
                layerFamily: this.syntheticLayer,
                featuresPerLayer,
                parsesPerIteration: this.parsesPerIteration,
                partsPerFeature: matrix?.partsPerFeature ?? null,
                verticesPerPart: matrix?.verticesPerPart ?? null,
                clippedFraction: matrix?.clippedFraction ?? null,
                mergeChainLength: matrix?.mergeChainLength ?? null,
            },
            operation: 'bucket feature',
            operationsPerIteration: (this.syntheticLayer === 'all' ? featuresPerLayer * 5 : featuresPerLayer) * this.parsesPerIteration,
        };
    }

    parse(profile?: ParseProfile): Promise<unknown> {
        return createWorkerTile(this.encoding).parse(
            this.data,
            this.layerIndex,
            iconNames,
            this.actor,
            SubdivisionGranularitySetting.noSubdivision,
            profile
        );
    }

    async profile(iterations = 50): Promise<ProfileSummaryRow[]> {
        const profile: ParseProfile = {records: []};
        for (let i = 0; i < iterations; i++) {
            await this.parse(profile);
        }
        return summarizeProfile(profile.records, iterations);
    }
}

function readTileBuffer(relativePath: string): ArrayBuffer {
    const buffer = readFileSync(new URL(relativePath, import.meta.url));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function fetchTileBuffers(encoding: Encoding): Promise<ArrayBuffer[]> {
    return Promise.resolve(realTileNames.map((tileName) => readTileBuffer(encoding === 'mvt'
        ? `../../integration/assets/tiles/${tileName}.mvt`
        : `../../integration/assets/tiles/mlt/gl-js/${tileName}.mlt`)));
}

function decodeMvtTile(buffer: ArrayBuffer): VectorTile {
    return new VectorTile(new PbfReader(new Uint8Array(buffer)));
}

function decodeMltTile(buffer: ArrayBuffer, options?: MLTVectorTileOptions | readonly string[]): MLTVectorTile {
    return new MLTVectorTile(buffer, options);
}

function decodeRealTile(encoding: Encoding, buffer: ArrayBuffer, options?: MLTVectorTileOptions | readonly string[]): VectorTile | MLTVectorTile {
    return encoding === 'mvt' ? decodeMvtTile(buffer) : decodeMltTile(buffer, options);
}

function createRealNativeLayerSpecs(): any[] {
    return [{
        id: 'real-road-native',
        source: 'source',
        'source-layer': 'road',
        type: 'line',
        filter: ['match', ['get', 'class'], ['path', 'driveway', 'service', 'street_limited', 'street', 'main'], true, false],
        paint: {
            'line-width': 10,
            'line-color': [
                'match',
                ['get', 'class'],
                'path', 'red',
                'driveway', 'orange',
                'service', 'yellow',
                'street_limited', 'green',
                'street', 'blue',
                'main', 'purple',
                'black'
            ]
        }
    }];
}

function createOmtLineSymbolLayerSpecs(): any[] {
    return [{
        id: 'omt-transportation-name-line-symbol',
        source: 'source',
        'source-layer': 'transportation_name',
        type: 'symbol',
        layout: {
            'symbol-placement': 'line',
            'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name'], 'road'],
            'text-font': ['literal', ['Test']],
            'text-size': 12,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
        },
    }];
}

function createBenchmarkMltDecodeOptions(layerIndex: StyleLayerIndex): MLTVectorTileOptions {
    return createMltDecodeOptions({
        source: 'source',
        promoteId: null,
    } as any as WorkerTileParameters, layerIndex);
}

export class MltRealTileScan extends Benchmark {
    encoding: Encoding;
    buffers: ArrayBuffer[];

    constructor(encoding: Encoding) {
        super();
        this.encoding = encoding;
    }

    async setup(): Promise<void> {
        this.buffers = await fetchTileBuffers(this.encoding);
    }

    bench(): void {
        for (const buffer of this.buffers) {
            const tile = decodeRealTile(this.encoding, buffer);
            Object.keys(tile.layers);
        }
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: realTileNames,
            parameters: {encoding: this.encoding, phase: 'scan'},
            operation: 'tile',
            operationsPerIteration: realTileNames.length,
        };
    }
}

export type DecodeAccess = 'layers' | 'metadata' | 'properties-one' | 'properties-enumerate' | 'geometry' | 'to-geojson' | 'full';
type DecodeProjection = 'all' | 'style';
export type DecodeTraversal = 'sequential' | 'reverse' | 'pseudo-random';

function sinkValue(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'bigint') return Number(value & 0xffffn);
    if (typeof value === 'string') return value.length;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value == null ? 0 : 1;
}

function sinkGeometry(geometry: Point[][]): number {
    let sink = geometry.length;
    for (const part of geometry) {
        sink += part.length;
        if (part.length > 0) {
            sink += part[0].x + part[0].y;
            const last = part[part.length - 1];
            sink += last.x + last.y;
        }
    }
    return sink;
}

function accessDecodedTile(
    tile: VectorTile | MLTVectorTile,
    access: DecodeAccess,
    firstPropertyNameByLayer: Map<string, string | null>,
    traversal: DecodeTraversal,
    randomOrderByLength: Map<number, Uint32Array>,
): number {
    let sink = 0;
    for (const layerName of Object.keys(tile.layers)) {
        const layer = tile.layers[layerName];
        sink += layer.length;
        if (access === 'layers') continue;

        let randomOrder: Uint32Array | undefined;
        if (traversal === 'pseudo-random') {
            randomOrder = randomOrderByLength.get(layer.length);
            if (!randomOrder) {
                randomOrder = Uint32Array.from({length: layer.length}, (_value, index) => index);
                let randomState = (0x5eed1234 ^ layer.length) >>> 0;
                for (let index = randomOrder.length - 1; index > 0; index--) {
                    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
                    const swapIndex = randomState % (index + 1);
                    const value = randomOrder[index];
                    randomOrder[index] = randomOrder[swapIndex];
                    randomOrder[swapIndex] = value;
                }
                randomOrderByLength.set(layer.length, randomOrder);
            }
        }

        for (let position = 0; position < layer.length; position++) {
            const featureIndex = traversal === 'sequential'
                ? position
                : traversal === 'reverse'
                    ? layer.length - position - 1
                    : randomOrder[position];
            const feature = layer.feature(featureIndex);
            if (access === 'metadata' || access === 'full') {
                sink += feature.type + feature.extent + sinkValue(feature.id);
            }
            if (access === 'properties-one' || access === 'properties-enumerate' || access === 'full') {
                if (access === 'properties-one') {
                    let propertyName = firstPropertyNameByLayer.get(layerName);
                    if (propertyName === undefined) {
                        const featureTable = getMltFeatureTable(layer);
                        propertyName = featureTable?.availablePropertyNames[0] ?? Object.keys(feature.properties)[0] ?? null;
                        firstPropertyNameByLayer.set(layerName, propertyName);
                    }
                    if (propertyName !== null) {
                        // This benchmark covers the public MVT-compatible adapter.
                        // Keep the property-name discovery out of the hot path, but
                        // always read the value through layer.feature().properties.
                        sink += sinkValue(feature.properties[propertyName]);
                    }
                } else {
                    for (const [name, value] of Object.entries(feature.properties)) {
                        sink += name.length + sinkValue(value);
                    }
                }
            }
            if (access === 'geometry' || access === 'full') {
                sink += sinkGeometry(feature.loadGeometry());
            }
            if (access === 'to-geojson') {
                const geojson = (feature as VectorTileFeatureLike & {toGeoJSON(x: number, y: number, z: number): GeoJSON.Feature}).toGeoJSON(0, 0, 14);
                sink += sinkValue(geojson.id) + sinkGeoJSONCoordinates(
                    (geojson.geometry as GeoJSON.Geometry & {coordinates: unknown}).coordinates,
                );
                for (const [name, value] of Object.entries(geojson.properties ?? {})) {
                    sink += name.length + sinkValue(value);
                }
            }
        }
    }
    return sink;
}

function countDecodedDictionaryStrings(tile: VectorTile | MLTVectorTile): number {
    let count = 0;
    for (const layer of Object.values(tile.layers)) {
        const featureTable = getMltFeatureTable(layer);
        if (!featureTable) continue;
        for (const vector of featureTable.propertyVectors ?? []) {
            const decodedStringCount = (vector as Vector & {readonly decodedStringCount?: number}).decodedStringCount;
            if (decodedStringCount !== undefined) count += decodedStringCount;
        }
    }
    return count;
}

/**
 * Measures the public adapter from raw tiles, including default eager property-column decode.
 * Main-thread map queries opt into deferred columns separately; geometry-only adapter timings
 * must not be interpreted as timings of that deferred query path.
 */
export class MltRealTileDecode extends Benchmark {
    encoding: Encoding;
    access: DecodeAccess;
    projection: DecodeProjection;
    options?: MLTVectorTileOptions | readonly string[];
    buffers: ArrayBuffer[];
    private sink = 0;
    private decodedStrings = 0;
    private readonly firstPropertyNameByLayer = new Map<string, string | null>();
    private readonly randomOrderByLength = new Map<number, Uint32Array>();

    constructor(
        encoding: Encoding,
        access: DecodeAccess = 'layers',
        projection: DecodeProjection = 'all',
        private readonly traversal: DecodeTraversal = 'sequential',
    ) {
        super();
        this.encoding = encoding;
        this.access = access;
        this.projection = projection;
    }

    async setup(): Promise<void> {
        this.buffers = await fetchTileBuffers(this.encoding);
        if (this.encoding === 'mlt' && this.projection === 'style') {
            this.options = createBenchmarkMltDecodeOptions(new StyleLayerIndex(createRealNativeLayerSpecs()));
        } else if (this.encoding === 'mlt' && this.access === 'layers') {
            this.options = {deferPropertyColumns: false};
        }
        for (const buffer of this.buffers) {
            this.sink += accessDecodedTile(
                decodeRealTile(this.encoding, buffer, this.options),
                this.access,
                this.firstPropertyNameByLayer,
                this.traversal,
                this.randomOrderByLength,
            );
        }
    }

    bench(): void {
        this.sink = 0;
        this.decodedStrings = 0;
        for (const buffer of this.buffers) {
            const tile = decodeRealTile(this.encoding, buffer, this.options);
            this.sink += accessDecodedTile(
                tile,
                this.access,
                this.firstPropertyNameByLayer,
                this.traversal,
                this.randomOrderByLength,
            );
            this.decodedStrings += countDecodedDictionaryStrings(tile);
        }
    }

    takeIterationMetrics(): BenchmarkIterationMetrics {
        return {values: {decodedStrings: this.decodedStrings}};
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: realTileNames,
            parameters: {
                encoding: this.encoding,
                phase: 'decode',
                access: this.access,
                projection: this.projection,
                traversal: this.traversal,
            },
            operation: 'tile',
            operationsPerIteration: realTileNames.length,
        };
    }
}

const omtCorpusDefinitions: Record<OmtCorpus, {
    tile: string;
    layers: readonly string[];
    properties: Readonly<Record<string, readonly string[]>>;
}> = {
    building: {
        tile: '14/8299/5635',
        layers: ['building'],
        properties: {building: ['render_height', 'render_min_height', 'colour', 'hide_3d']},
    },
    'roads-labels': {
        tile: '14/8299/5635',
        layers: ['transportation', 'transportation_name', 'poi'],
        properties: {
            transportation: ['class', 'subclass', 'surface', 'service', 'oneway'],
            transportation_name: ['class', 'subclass', 'name', 'name:latin', 'name_en'],
            poi: ['class', 'subclass', 'name', 'name:latin', 'rank'],
        },
    },
    'lowzoom-labels': {
        tile: '3/4/2',
        layers: ['boundary', 'place', 'water_name'],
        properties: {
            boundary: ['admin_level', 'disputed', 'maritime'],
            place: ['class', 'name', 'name:latin', 'name_en', 'rank'],
            water_name: ['class', 'name', 'name:latin', 'name_en'],
        },
    },
};

export class MltOmtCorpusDecode extends Benchmark {
    private buffer: ArrayBuffer;
    private sink = 0;
    private readonly decodesPerIteration = 3;

    constructor(private readonly encoding: Encoding, private readonly corpus: OmtCorpus) {
        super();
    }

    async setup(): Promise<void> {
        const definition = omtCorpusDefinitions[this.corpus];
        this.buffer = readTileBuffer(this.encoding === 'mvt'
            ? `../../integration/assets/tiles/omt/${definition.tile}.mvt`
            : `../../integration/assets/tiles/mlt/omt/${definition.tile}.mlt`);
        this.decodeAndAccess();
    }

    bench(): void {
        for (let decode = 0; decode < this.decodesPerIteration; decode++) this.decodeAndAccess();
    }

    getWorkload(): BenchmarkWorkload {
        const definition = omtCorpusDefinitions[this.corpus];
        return {
            corpus: [`omt/${definition.tile}`],
            parameters: {
                encoding: this.encoding,
                corpus: this.corpus,
                layers: definition.layers.join(','),
                propertyColumns: Object.values(definition.properties).reduce((sum, names) => sum + names.length, 0),
                decodesPerIteration: this.decodesPerIteration,
            },
            operation: 'tile',
            operationsPerIteration: this.decodesPerIteration,
        };
    }

    private decodeAndAccess(): void {
        const definition = omtCorpusDefinitions[this.corpus];
        if (this.encoding === 'mvt') {
            const tile = decodeMvtTile(this.buffer);
            for (const layerName of definition.layers) {
                const layer = tile.layers[layerName];
                if (!layer) continue;
                for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
                    const feature = layer.feature(featureIndex);
                    this.sink += feature.loadGeometry().length + Object.keys(feature.properties).length;
                }
            }
            return;
        }

        const propertyColumnNamesByLayer = new Map(Object.entries(definition.properties).map(
            ([layerName, names]) => [layerName, new Set(names)],
        ));
        const tile = new MLTVectorTile(this.buffer, {
            layerNames: definition.layers,
            propertyColumnNamesByLayer,
        });
        for (const layerName of definition.layers) {
            const layer = tile.layers[layerName];
            if (!layer) continue;
            const featureTable = getMltFeatureTable(layer);
            if (!featureTable) continue;
            for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
                forEachFeatureVertex(featureTable, featureIndex, () => this.sink++);
                for (const propertyName of definition.properties[layerName] ?? []) {
                    if (featureTable.getPropertyVector(propertyName)?.getValue(featureIndex) !== null) this.sink++;
                }
            }
        }
    }
}

export class MltOmtLineSymbols extends Benchmark {
    private tile: VectorTile | MLTVectorTile;
    private layerIndex: StyleLayerIndex;
    private actor: IActor;
    private featureCount = 0;

    constructor(private readonly encoding: Encoding) {
        super();
    }

    async setup(): Promise<void> {
        const buffer = readTileBuffer(this.encoding === 'mvt'
            ? '../../integration/assets/tiles/omt/14/8299/5635.mvt'
            : '../../integration/assets/tiles/mlt/omt/14/8299/5635.mlt');
        this.layerIndex = new StyleLayerIndex(createOmtLineSymbolLayerSpecs());
        const options = this.encoding === 'mlt' ? createBenchmarkMltDecodeOptions(this.layerIndex) : undefined;
        this.tile = decodeRealTile(this.encoding, buffer, options);
        this.featureCount = this.tile.layers.transportation_name?.length ?? 0;
        if (this.featureCount === 0) throw new Error('OMT line-symbol corpus has no transportation_name features.');
        this.actor = createSyntheticActor();
        await this.parse();
    }

    async bench(): Promise<void> {
        await this.parse();
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: ['omt/14/8299/5635'],
            parameters: {
                encoding: this.encoding,
                layerFamily: 'symbol-line',
                sourceLayer: 'transportation_name',
                features: this.featureCount,
            },
            operation: 'real line-label feature',
            operationsPerIteration: this.featureCount,
        };
    }

    private async parse(): Promise<void> {
        await createWorkerTile(this.encoding).parse(
            this.tile as any,
            this.layerIndex,
            [],
            this.actor,
            SubdivisionGranularitySetting.noSubdivision,
        );
    }
}

const bingTile = '4-12-6';
const fastPforTile = 'props_u32_fpf_256';

function assertFastPfor(buffer: ArrayBuffer, expected: boolean, corpus: string): string {
    const streams = scanTilePhysicalTechniques(new Uint8Array(buffer));
    const hasFastPfor = streams.some((stream) => stream.technique === 'FAST_PFOR');
    if (hasFastPfor !== expected) {
        throw new Error(`${corpus} ${expected ? 'must contain' : 'must not contain'} FAST_PFOR streams`);
    }
    return Array.from(new Set(streams.map((stream) => stream.technique))).sort().join(',');
}

/**
 * Exercises the standard Bing MVT/MLT fixture pair. The MLT fixture is checked
 * from its stream metadata so the corpus cannot accidentally be presented as
 * FastPFOR. All geometry and property columns are accessed.
 */
export class MltBingDecode extends Benchmark {
    private buffer: ArrayBuffer;
    private sink = 0;
    // protobufjs switches between optimization tiers on this corpus. Thirty
    // decodes per sample amortize those transitions; the standard ten warmups
    // also cover enough calls to keep them out of the measured MVT/MLT p95.
    private readonly decodesPerIteration = 30;
    private physicalTechniques = 'protobuf';

    constructor(private readonly encoding: Encoding) {
        super();
    }

    async setup(): Promise<void> {
        this.buffer = readTileBuffer(this.encoding === 'mvt'
            ? `../../integration/assets/tiles/bing/${bingTile}.mvt`
            : `../../integration/assets/tiles/mlt/bing/${bingTile}.mlt`);
        if (this.encoding === 'mlt') {
            this.physicalTechniques = assertFastPfor(this.buffer, false, `Bing fixture ${bingTile}`);
        }
        this.decodeAndAccess();
    }

    bench(): void {
        for (let decode = 0; decode < this.decodesPerIteration; decode++) this.decodeAndAccess();
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: [`bing/${bingTile}`],
            parameters: {
                encoding: this.encoding,
                physicalTechniques: this.physicalTechniques,
                access: 'all-geometries-and-properties',
                decodesPerIteration: this.decodesPerIteration,
            },
            operation: 'tile',
            operationsPerIteration: this.decodesPerIteration,
        };
    }

    private decodeAndAccess(): void {
        if (this.encoding === 'mvt') {
            const tile = decodeMvtTile(this.buffer);
            for (const layer of Object.values(tile.layers)) {
                for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
                    const feature = layer.feature(featureIndex);
                    this.sink += feature.loadGeometry().length + Object.keys(feature.properties).length;
                }
            }
            return;
        }

        const tile = new MLTVectorTile(this.buffer);
        for (const layer of Object.values(tile.layers)) {
            const featureTable = getMltFeatureTable(layer);
            if (!featureTable) continue;
            const propertyVectors = featureTable.materializePropertyVectors();
            for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
                forEachFeatureVertex(featureTable, featureIndex, () => this.sink++);
                for (const propertyVector of propertyVectors) {
                    if (propertyVector && propertyVector.getValue(featureIndex) !== null) this.sink++;
                }
            }
        }
    }
}

/**
 * Exercises a synthetic tile generated explicitly with cfg().fastPFOR(). The
 * setup assertion reads stream metadata, independently of the fixture name.
 */
export class MltFastPforDecode extends Benchmark {
    private buffer: ArrayBuffer;
    private sink = 0;
    private readonly decodesPerIteration = 100;
    private physicalTechniques = '';

    async setup(): Promise<void> {
        this.buffer = readTileBuffer(`../../integration/assets/tiles/mlt/synthetic/${fastPforTile}.mlt`);
        this.physicalTechniques = assertFastPfor(this.buffer, true, `Synthetic fixture ${fastPforTile}`);
        this.decodeAndAccess();
    }

    bench(): void {
        for (let decode = 0; decode < this.decodesPerIteration; decode++) this.decodeAndAccess();
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: [`synthetic/${fastPforTile}`],
            parameters: {
                encoding: 'mlt',
                expectedPhysicalTechnique: 'FAST_PFOR',
                physicalTechniques: this.physicalTechniques,
                access: 'all-geometries-and-properties',
                decodesPerIteration: this.decodesPerIteration,
            },
            operation: 'tile',
            operationsPerIteration: this.decodesPerIteration,
        };
    }

    private decodeAndAccess(): void {
        const tile = new MLTVectorTile(this.buffer);
        for (const layer of Object.values(tile.layers)) {
            const featureTable = getMltFeatureTable(layer);
            if (!featureTable) continue;
            const propertyVectors = featureTable.materializePropertyVectors();
            for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
                forEachFeatureVertex(featureTable, featureIndex, () => this.sink++);
                for (const propertyVector of propertyVectors) {
                    if (propertyVector && propertyVector.getValue(featureIndex) !== null) this.sink++;
                }
            }
        }
    }
}

const matrixLayerName = 'benchmark_property_matrix';
const matrixFeatureCount = 640;

function nullableIntVector(name: string, columnIndex: number): IntFlatVector {
    const values = new Int32Array(matrixFeatureCount);
    const present = new BitVector(new Uint8Array(Math.ceil(matrixFeatureCount / 8)), matrixFeatureCount);
    for (let featureIndex = 0; featureIndex < matrixFeatureCount; featureIndex++) {
        values[featureIndex] = featureIndex + columnIndex;
        if ((featureIndex + columnIndex) % 11 !== 0) present.set(featureIndex, true);
    }
    return new IntFlatVector(name, values, present);
}

function createMatrixPropertyVector(columnIndex: number): Vector {
    const name = `column_${columnIndex}`;
    switch (columnIndex % 5) {
        case 0:
            return new Int32ConstVector(name, columnIndex + 1, matrixFeatureCount, true);
        case 1:
            return nullableIntVector(name, columnIndex);
        case 2:
            return new Int32SequenceVector(name, 1, 1, matrixFeatureCount, true);
        case 3:
            return createStringDictionaryVector(Array.from({length: matrixFeatureCount}, (_, index) => index % 13 === 0 ? null : `class-${index % 7}`), name);
        default:
            return createStringFsstDictionaryVector(Array.from({length: matrixFeatureCount}, (_, index) => index % 17 === 0 ? null : `long-shared-prefix-${index % 9}`), name);
    }
}

function createColumnMatrixBuffer(totalColumns: number): ArrayBuffer {
    const points = createPointFeatures();
    const baseTable = createSyntheticPointFeatureTable(points);
    const repeatedGeometryTable = createSyntheticPointFeatureTable(Array.from(
        {length: matrixFeatureCount},
        (_, index) => points[index % points.length],
    ));
    return encodeFeatureTables([new FeatureTable(
        matrixLayerName,
        repeatedGeometryTable.geometryVector,
        repeatedGeometryTable.idVector,
        Array.from({length: totalColumns}, (_, columnIndex) => createMatrixPropertyVector(columnIndex)),
        baseTable.extent,
    )]);
}

export class MltColumnProjectionMatrix extends Benchmark {
    private buffer: ArrayBuffer;
    private readonly propertyNames: string[];
    private sink = 0;

    constructor(private readonly totalColumns: 5 | 50 | 200, private readonly readMode: ColumnReadMode) {
        super();
        const readColumns = readMode === 'few' ? Math.min(2, totalColumns) : totalColumns;
        this.propertyNames = Array.from({length: readColumns}, (_, index) => `column_${index}`);
    }

    async setup(): Promise<void> {
        this.buffer = createColumnMatrixBuffer(this.totalColumns);
        this.decodeAndRead();
    }

    bench(): void {
        this.decodeAndRead();
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: ['synthetic/property-matrix'],
            parameters: {
                totalColumns: this.totalColumns,
                readColumns: this.propertyNames.length,
                features: matrixFeatureCount,
                readMode: this.readMode,
                nullableColumns: true,
                vectorKinds: 'const,flat,sequence,dictionary,fsst',
            },
            operation: 'feature-column value',
            operationsPerIteration: matrixFeatureCount * this.propertyNames.length,
        };
    }

    private decodeAndRead(): void {
        const tile = new MLTVectorTile(this.buffer, {
            layerNames: [matrixLayerName],
            deferPropertyColumns: true,
        });
        const featureTable = getMltFeatureTable(tile.layers[matrixLayerName]);
        if (!featureTable) throw new Error('Property matrix did not decode as an MLT FeatureTable.');
        for (const propertyName of this.propertyNames) {
            const vector = featureTable.getPropertyVector(propertyName);
            if (!vector) throw new Error(`Property matrix is missing ${propertyName}.`);
            for (let featureIndex = 0; featureIndex < matrixFeatureCount; featureIndex++) {
                if (vector.getValue(featureIndex) !== null) this.sink++;
            }
        }
    }
}

export class MltRealTileEndToEnd extends Benchmark {
    encoding: Encoding;
    buffers: ArrayBuffer[];
    layerIndex: StyleLayerIndex;
    actor: IActor;
    options?: MLTVectorTileOptions;
    private lastTransferredBytes = 0;

    constructor(encoding: Encoding) {
        super();
        this.encoding = encoding;
    }

    async setup(): Promise<void> {
        if (typeof globalThis.ImageData === 'undefined') {
            (globalThis as any).ImageData = class ImageData {};
        }
        this.buffers = await fetchTileBuffers(this.encoding);
        this.layerIndex = new StyleLayerIndex(createRealNativeLayerSpecs());
        this.actor = createSyntheticActor();
        if (this.encoding === 'mlt') {
            this.options = createBenchmarkMltDecodeOptions(this.layerIndex);
        }
    }

    async bench(): Promise<void> {
        this.lastTransferredBytes = 0;
        for (const buffer of this.buffers) {
            const tile = decodeRealTile(this.encoding, buffer, this.options);
            const result = await createWorkerTile(this.encoding).parse(
                tile as any,
                this.layerIndex,
                [],
                this.actor,
                SubdivisionGranularitySetting.noSubdivision
            );
            const rawTileData = buffer.slice(0);
            if (this.encoding === 'mlt') {
                recordMltMaterialization('rawTileBytesCopied', rawTileData.byteLength, {detail: 'benchmark worker to main thread'});
            }
            const transferables: Transferable[] = [];
            const serialized = serialize({result, rawTileData, encoding: this.encoding}, transferables);
            this.lastTransferredBytes += uniqueArrayBufferBytes(transferables);
            structuredClone(serialized, {transfer: Array.from(uniqueArrayBuffers(transferables))});
        }
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: realTileNames,
            parameters: {encoding: this.encoding, phase: 'end-to-end'},
            operation: 'tile',
            operationsPerIteration: realTileNames.length,
        };
    }

    takeIterationMetrics(): BenchmarkIterationMetrics {
        return {transferredBytes: this.lastTransferredBytes};
    }
}

function uniqueArrayBufferBytes(transferables: readonly Transferable[]): number {
    let bytes = 0;
    for (const buffer of uniqueArrayBuffers(transferables)) bytes += buffer.byteLength;
    return bytes;
}

function uniqueArrayBuffers(transferables: readonly Transferable[]): Set<ArrayBuffer> {
    const buffers = new Set<ArrayBuffer>();
    for (const transferable of transferables) {
        if (transferable instanceof ArrayBuffer) buffers.add(transferable);
    }
    return buffers;
}

export class MltRealTileWorkerParse extends Benchmark {
    encoding: Encoding;
    tiles: Array<VectorTile | MLTVectorTile>;
    layerIndex: StyleLayerIndex;
    actor: IActor;

    constructor(encoding: Encoding) {
        super();
        this.encoding = encoding;
    }

    async setup(): Promise<void> {
        const buffers = await fetchTileBuffers(this.encoding);
        this.layerIndex = new StyleLayerIndex(createRealNativeLayerSpecs());
        const mltDecodeOptions = createBenchmarkMltDecodeOptions(this.layerIndex);
        this.tiles = buffers.map(buffer => decodeRealTile(this.encoding, buffer, mltDecodeOptions));
        this.actor = createSyntheticActor();
        await this.parse();
    }

    async bench(): Promise<void> {
        await this.parse();
    }

    async parse(profile?: ParseProfile): Promise<void> {
        for (const tile of this.tiles) {
            await createWorkerTile(this.encoding).parse(
                tile as any,
                this.layerIndex,
                [],
                this.actor,
                SubdivisionGranularitySetting.noSubdivision,
                profile
            );
        }
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: realTileNames,
            parameters: {encoding: this.encoding, phase: 'parse-only', sourceLayer: 'road'},
            operation: 'tile',
            operationsPerIteration: realTileNames.length,
        };
    }

    async profile(iterations = 50): Promise<ProfileSummaryRow[]> {
        const profile: ParseProfile = {records: []};
        for (let i = 0; i < iterations; i++) {
            await this.parse(profile);
        }
        return summarizeProfile(profile.records, iterations);
    }
}

export class MltWorkerParseProfile extends Benchmark {
    benchmark: MltWorkerParse | MltRealTileWorkerParse;
    iterations: number;
    lastProfileSummary: ProfileSummaryRow[];

    constructor(target: 'synthetic-all' | 'synthetic-line' | 'synthetic-symbol' | 'real-road', encoding: Encoding, iterations = 50) {
        super();
        this.benchmark = target === 'real-road'
            ? new MltRealTileWorkerParse(encoding)
            : new MltWorkerParse(encoding, target === 'synthetic-symbol' ? 'symbol' : target === 'synthetic-line' ? 'line' : 'all');
        this.iterations = iterations;
    }

    async setup(): Promise<void> {
        await this.benchmark.setup();
    }

    async bench(): Promise<void> {
        this.lastProfileSummary = await this.benchmark.profile(this.iterations);
        console.table(this.lastProfileSummary.map(row => ({
            phase: row.phase,
            kind: row.kind,
            encoding: row.encoding,
            layerType: row.layerType,
            detail: row.detail,
            mean: row.mean.toFixed(3),
            percent: row.percent.toFixed(1),
            calls: row.calls,
            features: row.features,
        })));
    }

    async profile(iterations: number = this.iterations): Promise<ProfileSummaryRow[]> {
        if (!this.lastProfileSummary) {
            await this.setup();
            this.lastProfileSummary = await this.benchmark.profile(iterations);
        }
        return this.lastProfileSummary;
    }
}

type SyntheticQueryContext = {
    data: VectorTileLike;
    featureIndex: any;
    layer: any;
    layerSpec: any;
};

function copiesForSyntheticPointCount(featureCount: number): number {
    const baseFeatureCount = syntheticPointFeatures().length;
    if (!Number.isInteger(featureCount) || featureCount <= 0 || featureCount % baseFeatureCount !== 0) {
        throw new Error(`Synthetic query feature count ${featureCount} must be a positive multiple of ${baseFeatureCount}.`);
    }
    return featureCount / baseFeatureCount;
}

function createQueryLayerSpec(): any {
    return {
        id: 'synthetic-circle-query',
        source: 'source',
        'source-layer': syntheticPointLayer,
        type: 'circle',
        paint: {'circle-radius': 4},
    };
}

async function createSyntheticQueryContext(
    encoding: Encoding,
    featureCount = featureCopies * syntheticPointFeatures().length,
    intersectionMode: QueryIntersectionMode = 'stub',
    idMode: QueryIdMode = 'int32',
): Promise<SyntheticQueryContext> {
    let points = createPointFeatures(copiesForSyntheticPointCount(featureCount));
    if (idMode === 'absent') {
        points = points.map((feature) => ({...feature, id: null}));
    } else if (idMode === 'signed-int64' && encoding === 'mvt') {
        points = points.map((feature, index) => ({
            ...feature,
            id: Number(BigInt.asUintN(64, -4294967297n - BigInt(index))),
        }));
    }
    let mltFeatureTable: FeatureTable | undefined;
    if (encoding === 'mlt') {
        const baseTable = createSyntheticPointFeatureTable(points);
        const idVector = idMode === 'absent'
            ? undefined
            : idMode === 'signed-int64'
                ? new Int64SequenceVector('id', -4294967297n, -1n, points.length, true)
                : baseTable.idVector;
        mltFeatureTable = new FeatureTable(
            baseTable.name,
            baseTable.geometryVector,
            idVector,
            baseTable.propertyVectors,
            baseTable.extent,
        );
    }
    const data: VectorTileLike = encoding === 'mvt'
        // Query benchmarks must exercise the public contract of the real MVT
        // decoder: every feature(i) call constructs a fresh mutable wrapper.
        // The worker-parse benchmarks intentionally keep their historical
        // synthetic layer above so their baseline remains comparable.
        ? createDecodedSyntheticMvtTile(syntheticPointLayer, createSyntheticLegacyPointFeatures(points))
        : MLTVectorTile.fromFeatureTables([mltFeatureTable]);
    const layerSpec = createQueryLayerSpec();
    const layerIndex = new StyleLayerIndex([layerSpec]);
    const parsed = await createWorkerTile(encoding).parse(
        data,
        layerIndex,
        [],
        createSyntheticActor(),
        SubdivisionGranularitySetting.noSubdivision
    );
    const featureIndex = parsed.featureIndex as any;
    if (idMode === 'promote-id') featureIndex.promoteId = 'label';
    featureIndex.encoding = encoding;
    featureIndex.rawTileData = new ArrayBuffer(0);
    featureIndex.vtLayers = data.layers;
    const layer = layerIndex.familiesBySource.source[syntheticPointLayer][0][0] as any;
    if (intersectionMode === 'stub') layer.queryIntersectsFeature = () => true;

    return {data, featureIndex, layer, layerSpec};
}

function renderedQueryFilter(cardinality: RenderedQueryCardinality): any {
    switch (cardinality) {
        case '0': return ['==', ['get', 'sort'], -1];
        case '1': return ['==', ['get', 'sort'], 0];
        case '10': return ['<', ['get', 'sort'], 10];
        case 'many': return undefined;
    }
}

function renderedQueryExpectedResults(cardinality: RenderedQueryCardinality, featureCount: number): number {
    return cardinality === 'many' ? featureCount : Number(cardinality);
}

function sourceQueryFilter(selectivity: SourceQuerySelectivity, featureCount: number): any {
    switch (selectivity) {
        case '1pct': return ['<', ['get', 'sort'], Math.floor(featureCount * 0.01)];
        case '10pct': return ['<', ['get', 'sort'], Math.floor(featureCount * 0.1)];
        case '100pct': return undefined;
    }
}

function sourceQueryExpectedResults(selectivity: SourceQuerySelectivity, featureCount: number): number {
    switch (selectivity) {
        case '1pct': return Math.floor(featureCount * 0.01);
        case '10pct': return Math.floor(featureCount * 0.1);
        case '100pct': return featureCount;
    }
}

function countRenderedResults(result: Record<string, unknown[]>): number {
    return Object.values(result).reduce((count, features) => count + features.length, 0);
}

function sinkGeoJSONCoordinates(value: unknown): number {
    if (typeof value === 'number') return value;
    if (!Array.isArray(value)) return 0;
    let sink = value.length;
    for (const item of value) sink += sinkGeoJSONCoordinates(item);
    return sink;
}

function consumeQueryFeature(feature: any, access: QueryResultAccess): number {
    switch (access) {
        case 'none':
            return 1;
        case 'metadata':
            return sinkValue(feature.id) + sinkValue(feature.type);
        case 'property-one':
            return sinkValue(feature.properties?.sort);
        case 'properties': {
            let sink = 0;
            for (const [name, value] of Object.entries(feature.properties ?? {})) {
                sink += name.length + sinkValue(value);
            }
            return sink;
        }
        case 'geometry':
            return sinkValue(feature.geometry?.type) + sinkGeoJSONCoordinates(feature.geometry?.coordinates);
        case 'json':
            return JSON.stringify(typeof feature.toJSON === 'function' ? feature.toJSON() : feature).length;
    }
}

function consumeRenderedResults(result: Record<string, any[]>, access: QueryResultAccess): number {
    let sink = 0;
    for (const features of Object.values(result)) {
        for (const featureWrapper of features) sink += consumeQueryFeature(featureWrapper.feature, access);
    }
    return sink;
}

function consumeSourceResults(result: any[], access: QueryResultAccess): number {
    let sink = 0;
    for (const feature of result) sink += consumeQueryFeature(feature, access);
    return sink;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeSyntheticQueryTile(context: SyntheticQueryContext, encoding: Encoding, featureCount: number): ArrayBuffer {
    if (encoding === 'mvt') return copyArrayBuffer(fromVectorTileJs(context.data));
    return encodeFeatureTables([
        createSyntheticPointFeatureTable(createPointFeatures(copiesForSyntheticPointCount(featureCount))),
    ]);
}

export class MltQueryTemperature extends Benchmark {
    private context: SyntheticQueryContext;
    private tile: Tile;
    private rawTileData: ArrayBuffer;
    private readonly transform = new MercatorTransform();
    private readonly queryGeometry = [
        new Point(0, 0),
        new Point(8192, 0),
        new Point(8192, 8192),
        new Point(0, 8192),
        new Point(0, 0),
    ];
    private sink = 0;
    private readonly queriesPerIteration: number;

    constructor(
        private readonly encoding: Encoding,
        private readonly queryKind: 'rendered' | 'source',
        private readonly temperature: QueryTemperature,
        private readonly resultAccess: QueryResultAccess = 'none',
        private readonly featureCount: number = featureCopies * syntheticPointFeatures().length,
    ) {
        super();
        this.queriesPerIteration = temperature === 'first' ? 1 : 20;
        this.transform.resize(512, 512);
    }

    async setup(): Promise<void> {
        this.context = await createSyntheticQueryContext(this.encoding, this.featureCount);
        this.rawTileData = encodeSyntheticQueryTile(this.context, this.encoding, this.featureCount);
        this.tile = new Tile(tileID, 512);
        this.tile.latestFeatureIndex = this.context.featureIndex;
        this.prepareFirstQuery();
        const count = this.runQuery().count;
        if (count !== this.featureCount) {
            throw new Error(`${this.queryKind} ${this.temperature} query expected ${this.featureCount} results, received ${count}.`);
        }
        if (this.temperature === 'first') this.prepareFirstQuery();
    }

    bench(): void {
        this.sink = 0;
        for (let query = 0; query < this.queriesPerIteration; query++) {
            if (this.temperature === 'first') this.prepareFirstQuery();
            const result = this.runQuery();
            this.sink += result.sink;
        }
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: [`synthetic/${this.featureCount}-points`],
            parameters: {
                encoding: this.encoding,
                query: this.queryKind,
                temperature: this.temperature,
                expectedResults: this.featureCount,
                resultAccess: this.resultAccess,
                queriesPerIteration: this.queriesPerIteration,
            },
            operation: `${this.temperature} ${this.queryKind} query`,
            operationsPerIteration: this.queriesPerIteration,
        };
    }

    private prepareFirstQuery(): void {
        const featureIndex = this.context.featureIndex;
        featureIndex.rawTileData = this.rawTileData;
        featureIndex.encoding = this.encoding;
        featureIndex.vtLayers = undefined;
    }

    private runQuery(): {count: number; sink: number} {
        if (this.queryKind === 'source') {
            const result: any[] = [];
            this.tile.querySourceFeatures(result, {sourceLayer: syntheticPointLayer});
            return {count: result.length, sink: consumeSourceResults(result, this.resultAccess)};
        }

        const {featureIndex, layer, layerSpec} = this.context;
        const result = featureIndex.query({
            queryPadding: 0,
            tileSize: 512,
            scale: 1,
            queryGeometry: this.queryGeometry,
            cameraQueryGeometry: this.queryGeometry,
            params: {},
            transform: this.transform,
        }, {[layer.id]: layer}, {[layer.id]: layerSpec}, undefined);
        return {count: countRenderedResults(result), sink: consumeRenderedResults(result, this.resultAccess)};
    }
}

export class MltRenderedQuery extends Benchmark {
    private context: SyntheticQueryContext;
    private readonly filter: any;
    private readonly expectedResults: number;
    private readonly transform = new MercatorTransform();
    private readonly queryGeometry = [
        new Point(0, 0),
        new Point(8192, 0),
        new Point(8192, 8192),
        new Point(0, 8192),
        new Point(0, 0),
    ];
    private sink = 0;
    private readonly queriesPerIteration: number;

    constructor(
        private readonly encoding: Encoding,
        private readonly cardinality: RenderedQueryCardinality,
        private readonly resultAccess: QueryResultAccess = 'none',
        private readonly featureCount: number = featureCopies * syntheticPointFeatures().length,
        private readonly intersectionMode: QueryIntersectionMode = 'stub',
    ) {
        super();
        this.filter = renderedQueryFilter(cardinality);
        this.expectedResults = renderedQueryExpectedResults(cardinality, featureCount);
        this.queriesPerIteration = featureCount >= 10_000 ? 2 : 20;
        this.transform.resize(512, 512);
    }

    async setup(): Promise<void> {
        this.context = await createSyntheticQueryContext(this.encoding, this.featureCount, this.intersectionMode);
        const resultCount = countRenderedResults(this.query());
        if (resultCount !== this.expectedResults) {
            throw new Error(`Rendered query expected ${this.expectedResults} results, received ${resultCount}.`);
        }
    }

    bench(): void {
        this.sink = 0;
        for (let query = 0; query < this.queriesPerIteration; query++) {
            this.sink += consumeRenderedResults(this.query(), this.resultAccess);
        }
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: [`synthetic/${this.featureCount}-points`],
            parameters: {
                encoding: this.encoding,
                query: 'rendered',
                cardinality: this.cardinality,
                expectedResults: this.expectedResults,
                queriesPerIteration: this.queriesPerIteration,
                resultAccess: this.resultAccess,
                intersection: this.intersectionMode,
            },
            operation: 'query',
            operationsPerIteration: this.queriesPerIteration,
        };
    }

    private query(): Record<string, any[]> {
        const {featureIndex, layer, layerSpec} = this.context;
        return featureIndex.query({
            queryPadding: 0,
            tileSize: 512,
            scale: 1,
            queryGeometry: this.queryGeometry,
            cameraQueryGeometry: this.queryGeometry,
            params: {filter: this.filter},
            transform: this.transform
        }, {
            [layer.id]: layer,
        }, {
            [layer.id]: layerSpec,
        }, undefined);
    }
}

export class MltSourceQuery extends Benchmark {
    private tile: Tile;
    private readonly filter: any;
    private readonly expectedResults: number;
    private sink = 0;
    private readonly queriesPerIteration: number;

    constructor(
        private readonly encoding: Encoding,
        private readonly selectivity: SourceQuerySelectivity,
        private readonly resultAccess: QueryResultAccess = 'none',
        private readonly featureCount: number = featureCopies * syntheticPointFeatures().length,
        private readonly idMode: QueryIdMode = 'int32',
    ) {
        super();
        this.filter = sourceQueryFilter(selectivity, featureCount);
        this.expectedResults = sourceQueryExpectedResults(selectivity, featureCount);
        this.queriesPerIteration = featureCount >= 10_000 ? 2 : 20;
    }

    async setup(): Promise<void> {
        const {featureIndex} = await createSyntheticQueryContext(this.encoding, this.featureCount, 'stub', this.idMode);
        this.tile = new Tile(tileID, 512);
        this.tile.latestFeatureIndex = featureIndex;
        const resultCount = this.query().length;
        if (resultCount !== this.expectedResults) {
            throw new Error(`Source query expected ${this.expectedResults} results, received ${resultCount}.`);
        }
    }

    bench(): void {
        this.sink = 0;
        for (let query = 0; query < this.queriesPerIteration; query++) {
            this.sink += consumeSourceResults(this.query(), this.resultAccess);
        }
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: [`synthetic/${this.featureCount}-points`],
            parameters: {
                encoding: this.encoding,
                query: 'source',
                selectivity: this.selectivity,
                expectedResults: this.expectedResults,
                queriesPerIteration: this.queriesPerIteration,
                resultAccess: this.resultAccess,
                idMode: this.idMode,
            },
            operation: 'query',
            operationsPerIteration: this.queriesPerIteration,
        };
    }

    private query(): any[] {
        const result = [];
        this.tile.querySourceFeatures(result, {
            sourceLayer: syntheticPointLayer,
            filter: this.filter,
        });
        return result;
    }
}

export class MltPublicQueryAggregation extends Benchmark {
    private readonly transform = new MercatorTransform();
    private tileManager: TileManager;
    private sink = 0;
    private expectedResults = 0;
    private readonly queriesPerIteration = 20;
    private profileValues: Record<string, number> | undefined;

    constructor(
        private readonly queryKind: 'rendered' | 'source',
        private readonly featureCount = 10_000,
        private readonly tileCount = 4,
        private readonly withFeatureState = false,
    ) {
        super();
        this.transform.resize(512, 512);
    }

    async setup(): Promise<void> {
        this.tileManager = this.queryKind === 'rendered'
            ? this.createRenderedTileManager()
            : this.createSourceTileManager();
        const result = this.query();
        if (result.length !== this.expectedResults) {
            throw new Error(`Public ${this.queryKind} aggregation expected ${this.expectedResults} results, received ${result.length}.`);
        }
    }

    bench(): void {
        this.sink = 0;
        const profile: QueryProfile = {records: []};
        for (let query = 0; query < this.queriesPerIteration; query++) {
            const result = this.query(profile);
            this.sink += result.length;
            for (const entry of result) {
                this.sink += sinkValue(entry.id) + sinkValue(entry.source) + sinkValue(entry.sourceLayer);
            }
        }
        const durations = new Map<string, number>();
        const outputCounts = new Map<string, number>();
        for (const record of profile.records) {
            durations.set(record.phase, (durations.get(record.phase) ?? 0) + record.duration);
            outputCounts.set(record.phase, (outputCounts.get(record.phase) ?? 0) + (record.outputCount ?? 0));
        }
        this.profileValues = {};
        for (const [phase, duration] of durations) {
            this.profileValues[`${phase}.durationMs`] = duration;
            this.profileValues[`${phase}.outputCount`] = outputCounts.get(phase) ?? 0;
        }
    }

    takeIterationMetrics(): BenchmarkIterationMetrics | undefined {
        if (!this.profileValues) return undefined;
        const values = this.profileValues;
        this.profileValues = undefined;
        return {values};
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: [`synthetic/public-${this.queryKind}-${this.featureCount}`],
            parameters: {
                query: this.queryKind,
                tileCount: this.tileCount,
                inputFeatures: this.featureCount,
                outputFeatures: this.expectedResults,
                wrappedOrCanonicalDuplicate: true,
                featureState: this.withFeatureState,
            },
            operation: `public multi-tile ${this.queryKind} query`,
            operationsPerIteration: this.queriesPerIteration,
        };
    }

    private query(profile?: QueryProfile): any[] {
        if (this.queryKind === 'source') {
            return queryPublicSourceFeatures(this.tileManager, {}, profile);
        }
        const result = queryPublicRenderedFeatures(
            this.tileManager,
            {},
            {},
            this.queryGeometry(),
            undefined,
            this.transform,
            undefined,
            profile,
        );
        const styleLayer = result['public-query-layer']?.[0]?.feature.layer ?? {
            id: 'public-query-layer',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'circle',
            paint: {},
            layout: {},
        };
        return flattenAndSortRenderedFeatures(
            [result],
            {'public-query-layer': styleLayer as any},
            ['public-query-layer'],
            profile,
        );
    }

    private createRenderedTileManager(): TileManager {
        const perTile = Math.ceil(this.featureCount / this.tileCount);
        const tileEntries = [];
        let nextFeatureId = 0;
        const uniqueWrappedKeys = new Set<string>();
        let outputCount = 0;
        for (let tileIndex = 0; tileIndex < this.tileCount; tileIndex++) {
            const canonicalX = tileIndex === 1 ? 0 : tileIndex;
            const tileID = new OverscaledTileID(4, 0, 4, canonicalX, 0);
            const wrappedKey = tileID.wrapped().key;
            const features = [];
            const count = Math.min(perTile, this.featureCount - nextFeatureId);
            for (let featureIndex = 0; featureIndex < count; featureIndex++) {
                const id = nextFeatureId++;
                features.push({
                    featureIndex,
                    feature: {
                        type: 'Feature',
                        id,
                        properties: {},
                        layer: {
                            id: 'public-query-layer',
                            source: 'source',
                            'source-layer': syntheticPointLayer,
                            type: 'circle',
                            paint: {},
                            layout: {},
                        },
                    },
                });
            }
            if (!uniqueWrappedKeys.has(wrappedKey)) {
                uniqueWrappedKeys.add(wrappedKey);
                outputCount += features.length;
            }
            tileEntries.push({
                tileID,
                tile: {queryRenderedFeatures: () => ({'public-query-layer': features})},
                queryGeometry: this.queryGeometry(),
                cameraQueryGeometry: this.queryGeometry(),
                scale: 1,
            });
        }
        this.expectedResults = outputCount;
        const featureState = this.withFeatureState
            ? {state: {[syntheticPointLayer]: {'0': {selected: true}}}, stateChanges: {}, deletedStates: {}}
            : {state: {}, stateChanges: {}, deletedStates: {}};
        return {
            id: 'source',
            tilesIn: () => tileEntries,
            getState: () => featureState,
            getFeatureState: (_sourceLayer: string, id: string | number) => id === 0 ? {selected: true} : {},
        } as any as TileManager;
    }

    private createSourceTileManager(): TileManager {
        const perTile = Math.ceil(this.featureCount / this.tileCount);
        const tiles: Record<string, any> = {};
        const ids: string[] = [];
        const canonicalKeys = new Set<string>();
        let nextFeatureId = 0;
        let outputCount = 0;
        for (let tileIndex = 0; tileIndex < this.tileCount; tileIndex++) {
            const canonicalX = tileIndex === 1 ? 0 : tileIndex;
            const tileID = new OverscaledTileID(4, tileIndex === 1 ? 1 : 0, 4, canonicalX, 0);
            const count = Math.min(perTile, this.featureCount - nextFeatureId);
            const features = Array.from({length: count}, () => ({id: nextFeatureId++}));
            const key = `tile-${tileIndex}`;
            ids.push(key);
            tiles[key] = {
                tileID,
                querySourceFeatures: (result: any[]) => result.push(...features),
            };
            if (!canonicalKeys.has(tileID.canonical.key)) {
                canonicalKeys.add(tileID.canonical.key);
                outputCount += features.length;
            }
        }
        this.expectedResults = outputCount;
        return {
            getRenderableIds: () => ids,
            getTileByID: (id: string) => tiles[id],
        } as any as TileManager;
    }

    private queryGeometry(): Point[] {
        return [
            new Point(0, 0),
            new Point(8192, 0),
            new Point(8192, 8192),
            new Point(0, 8192),
            new Point(0, 0),
        ];
    }
}

export class MltRepeatedFeatureState extends Benchmark {
    private tile: Tile;
    private painter: any;
    private revision = 0;
    private stateDataBytes = 0;
    private readonly updatesPerIteration = 100;

    async setup(): Promise<void> {
        if (typeof globalThis.ImageData === 'undefined') {
            (globalThis as any).ImageData = class ImageData {};
        }
        const layerSpec = {
            id: 'synthetic-circle-feature-state',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'circle',
            paint: {
                'circle-radius': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'radius'], 1],
            },
        } as any;
        const layerIndex = new StyleLayerIndex([layerSpec]);
        const data = createMltTile(createLineFeatures(), createPolygonFeatures(), createPointFeatures());
        const parsed = await createWorkerTile('mlt').parse(
            data,
            layerIndex,
            [],
            createSyntheticActor(),
            SubdivisionGranularitySetting.noSubdivision,
        ) as any;
        const transferred = deserialize(serialize({
            buckets: parsed.buckets,
            collisionBoxArray: parsed.collisionBoxArray,
            featureIndex: parsed.featureIndex,
        })) as any;
        const layer = layerIndex.familiesBySource.source[syntheticPointLayer][0][0] as any;
        this.painter = {
            style: {
                hasLayer: (id: string) => id === layer.id,
                getLayer: (id: string) => id === layer.id ? layer : undefined,
            },
        };
        this.tile = new Tile(tileID, 512);
        this.tile.loadVectorData({
            buckets: transferred.buckets,
            collisionBoxArray: transferred.collisionBoxArray,
            featureIndex: transferred.featureIndex,
            encoding: 'mlt',
            rawTileData: new ArrayBuffer(1),
        } as any, this.painter);
        const bucket = this.tile.buckets[layer.id] as any;
        this.stateDataBytes = bucket.programConfigurations.columnarFeatureStateData?.byteLength ?? 0;
        if (this.stateDataBytes === 0) {
            throw new Error('Repeated feature-state benchmark has no transferred columnar state data.');
        }
        this.updateFeatureState();
    }

    bench(): void {
        this.updateFeatureState();
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: ['synthetic/640-points'],
            parameters: {
                encoding: 'mlt',
                updatesPerIteration: this.updatesPerIteration,
                stateDependentColumns: 1,
            },
            operation: 'feature-state update',
            operationsPerIteration: this.updatesPerIteration,
        };
    }

    takeIterationMetrics(): BenchmarkIterationMetrics {
        return {retainedBytes: this.stateDataBytes};
    }

    private updateFeatureState(): void {
        for (let update = 0; update < this.updatesPerIteration; update++) {
            this.revision++;
            this.tile.setFeatureState({
                [syntheticPointLayer]: [{id: '31', state: {active: (this.revision & 1) === 0}}],
            }, this.painter, this.revision);
        }
    }
}

export class MltOverzoom extends Benchmark {
    private readonly sourceLayerIds = ['building', 'transportation'];
    private rawBuffer: ArrayBuffer;
    private maxZoomTile: MLTVectorTile;
    private params: WorkerTileParameters;
    private lastRawBytes = 0;
    private lastFeatures = 0;

    constructor(private readonly zoomDelta: 1 | 2 | 4) {
        super();
    }

    async setup(): Promise<void> {
        const layerIndex = this.createLayerIndex();
        const buffer = readTileBuffer('../../integration/assets/tiles/mlt/omt/14/8299/5635.mlt');
        this.rawBuffer = buffer;
        this.maxZoomTile = new MLTVectorTile(buffer, createMltDecodeOptions({
            source: 'source',
            promoteId: null,
        } as any as WorkerTileParameters, layerIndex));
        const factor = 2 ** this.zoomDelta;
        const childOffset = Math.floor(factor / 2);
        this.params = {
            encoding: 'mlt',
            source: 'source',
            request: {url: `benchmark://overzoom-z-plus-${this.zoomDelta}`},
            tileID: new OverscaledTileID(
                14 + this.zoomDelta,
                0,
                14 + this.zoomDelta,
                8299 * factor + childOffset,
                5635 * factor + childOffset,
            ),
            overzoomParameters: {
                maxZoomTileID: new CanonicalTileID(14, 8299, 5635),
                overzoomRequest: {url: 'benchmark://omt-parent'},
            },
        } as any as WorkerTileParameters;
        this.overzoom();
    }

    bench(): void {
        this.overzoom();
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: ['omt/14/8299/5635'],
            parameters: {
                encoding: 'mlt',
                zoomDelta: this.zoomDelta,
                sourceLayers: this.sourceLayerIds.join(','),
                retainedBytesDefinition: 'parent raw query buffer only; not clipped geometry or total heap',
            },
            operation: 'overzoomed tile',
            operationsPerIteration: 1,
        };
    }

    takeIterationMetrics(): BenchmarkIterationMetrics {
        return {
            retainedBytes: this.lastRawBytes,
            values: {outputFeatures: this.lastFeatures},
        };
    }

    private createLayerIndex(): StyleLayerIndex {
        return new StyleLayerIndex([
            {id: 'omt-building', source: 'source', 'source-layer': 'building', type: 'fill'},
            {id: 'omt-transportation', source: 'source', 'source-layer': 'transportation', type: 'line'},
        ] as any[]);
    }

    private overzoom(): void {
        const source = new VectorTileWorkerSource(createSyntheticActor(), this.createLayerIndex(), []);
        const result = (source as any)._getOverzoomTile(this.params, this.maxZoomTile, this.rawBuffer);
        this.lastRawBytes = result.rawData.byteLength;
        this.lastFeatures = Object.values(result.vectorTile.layers as Record<string, {length: number}>).reduce(
            (sum, layer) => sum + layer.length,
            0,
        );
        if (this.lastFeatures === 0) {
            throw new Error(`Overzoom z+${this.zoomDelta} selected an empty child tile.`);
        }
    }
}

export class MltMemoryLifecycle extends Benchmark {
    private rawBuffer: ArrayBuffer;
    private initialLayerIndex: StyleLayerIndex;
    private reloadLayerIndex: StyleLayerIndex;
    private lastMetrics: BenchmarkIterationMetrics;
    private revision = 0;

    async setup(): Promise<void> {
        if (typeof globalThis.ImageData === 'undefined') {
            (globalThis as any).ImageData = class ImageData {};
        }
        this.rawBuffer = encodeFeatureTables([
            createSyntheticLineFeatureTable(createLineFeatures()),
            createSyntheticPolygonFeatureTable(createPolygonFeatures()),
            createSyntheticPointFeatureTable(createPointFeatures()),
        ]);
        this.initialLayerIndex = new StyleLayerIndex([this.initialLayerSpec()]);
        this.reloadLayerIndex = new StyleLayerIndex([this.reloadLayerSpec()]);
        await this.runLifecycle();
    }

    async bench(): Promise<void> {
        await this.runLifecycle();
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: ['synthetic/640-lines-640-polygons-640-points'],
            parameters: {
                encoding: 'mlt',
                phases: 'load,query,feature-state,overzoom,reload',
                querySelectivity: '10pct',
                reloadAddsProperty: 'category',
                retainedBytesDefinition: 'unique source and overzoom raw buffers; cache budget reported separately',
            },
            operation: 'lifecycle',
            operationsPerIteration: 1,
        };
    }

    takeIterationMetrics(): BenchmarkIterationMetrics {
        return this.lastMetrics;
    }

    private initialLayerSpec(): any {
        return {
            id: 'memory-circle',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'circle',
            paint: {
                'circle-radius': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'radius'], 1],
            },
        };
    }

    private reloadLayerSpec(): any {
        return {
            id: 'memory-circle',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'circle',
            filter: ['!=', ['get', 'category'], 'hidden'],
            paint: {
                'circle-radius': ['case', ['==', ['get', 'category'], 'poi'], ['get', 'radius'], 1],
            },
        };
    }

    private async runLifecycle(): Promise<void> {
        const phaseMemoryBytes: Record<string, BenchmarkMemorySnapshot> = {};
        const decodeOptions = createMltDecodeOptions({
            source: 'source',
            promoteId: null,
        } as any as WorkerTileParameters, this.initialLayerIndex);
        const decodedTile = new MLTVectorTile(this.rawBuffer, decodeOptions);
        const parsed = await createWorkerTile('mlt').parse(
            decodedTile,
            this.initialLayerIndex,
            [],
            createSyntheticActor(),
            SubdivisionGranularitySetting.noSubdivision,
        ) as any;
        const rawTileData = this.rawBuffer.slice(0);
        recordMltMaterialization('rawTileBytesCopied', rawTileData.byteLength, {detail: 'lifecycle worker to main thread'});
        const transferables: Transferable[] = [];
        const serialized = serialize({...parsed, rawTileData, encoding: 'mlt'}, transferables);
        const transferredBytes = uniqueArrayBufferBytes(transferables);
        const transferred = deserialize(structuredClone(serialized, {
            transfer: Array.from(uniqueArrayBuffers(transferables)),
        })) as any;
        const initialLayer = this.initialLayerIndex.familiesBySource.source[syntheticPointLayer][0][0] as any;
        const painter = {
            style: {
                hasLayer: (id: string) => id === initialLayer.id,
                getLayer: (id: string) => id === initialLayer.id ? initialLayer : undefined,
            },
        } as any;
        const mainTile = new Tile(tileID, 512);
        mainTile.loadVectorData(transferred, painter);
        phaseMemoryBytes.load = retainedMemorySnapshot();

        const queryResults: any[] = [];
        mainTile.querySourceFeatures(queryResults, {
            sourceLayer: syntheticPointLayer,
            filter: ['<', ['get', 'sort'], 64],
        });
        for (const result of queryResults) {
            void result.properties;
        }
        const queryResultCount = queryResults.length;
        phaseMemoryBytes.query = retainedMemorySnapshot();
        queryResults.length = 0;

        this.revision++;
        mainTile.setFeatureState({
            [syntheticPointLayer]: [{id: '31', state: {active: true}}],
        }, painter, this.revision);
        phaseMemoryBytes['feature-state'] = retainedMemorySnapshot();

        const overzoomLayerIndex = new StyleLayerIndex([this.initialLayerSpec()]);
        const workerSource = new VectorTileWorkerSource(createSyntheticActor(), overzoomLayerIndex, []);
        const overzoomParams = {
            encoding: 'mlt',
            source: 'source',
            request: {url: 'benchmark://memory-overzoom'},
            tileID: new OverscaledTileID(1, 0, 1, 1, 1),
            overzoomParameters: {
                maxZoomTileID: new CanonicalTileID(0, 0, 0),
                overzoomRequest: {url: 'benchmark://memory-parent'},
            },
        } as any as WorkerTileParameters;
        const overzoomed = (workerSource as any)._getOverzoomTile(overzoomParams, decodedTile, this.rawBuffer);
        const overzoomBytes = overzoomed.rawData.byteLength as number;
        phaseMemoryBytes.overzoom = retainedMemorySnapshot();

        const reloadResult = await createWorkerTile('mlt').parse(
            decodedTile,
            this.reloadLayerIndex,
            [],
            createSyntheticActor(),
            SubdivisionGranularitySetting.noSubdivision,
        );
        const reloadTransferables: Transferable[] = [];
        const reloadSerialized = serialize(reloadResult, reloadTransferables);
        const reloadTransferredBytes = uniqueArrayBufferBytes(reloadTransferables);
        structuredClone(reloadSerialized, {transfer: Array.from(uniqueArrayBuffers(reloadTransferables))});
        phaseMemoryBytes.reload = retainedMemorySnapshot();

        this.lastMetrics = {
            transferredBytes: transferredBytes + reloadTransferredBytes,
            retainedBytes: uniqueArrayBufferBytes([this.rawBuffer, overzoomed.rawData]),
            phaseMemoryBytes,
            values: {
                queryResults: queryResultCount,
                overzoomBytes,
                overzoomCacheBudgetBytes: workerSource.overzoomedTileResultCache.stats.bytes,
            },
        };
    }
}

type PointSnapshotColumn = {
    name: string;
    values: Int32Array | string[];
};

type PointFeatureTableSnapshot = {
    extent: number;
    vertices: Int32Array;
    ids: Int32Array;
    idPresent: Uint8Array;
    columns: PointSnapshotColumn[];
    availablePropertyNames: string[];
};

const pointSnapshotPropertyNames = ['category', 'radius', 'sort', 'label', 'icon'];

function createPointSnapshot(points: SyntheticPointFeature[], fullProperties: boolean): PointFeatureTableSnapshot {
    const idPresent = new Uint8Array(Math.ceil(points.length / 8));
    const ids = new Int32Array(points.length);
    for (let index = 0; index < points.length; index++) {
        const id = points[index].id;
        if (id === undefined || id === null) continue;
        ids[index] = id;
        idPresent[index >> 3] |= 1 << (index & 7);
    }
    const columns: PointSnapshotColumn[] = [{
        name: 'sort',
        values: Int32Array.from(points, (point) => point.properties.sort),
    }];
    if (fullProperties) {
        columns.unshift(
            {name: 'category', values: points.map((point) => point.properties.category)},
            {name: 'radius', values: Int32Array.from(points, (point) => point.properties.radius)},
        );
        columns.push(
            {name: 'label', values: points.map((point) => point.properties.label)},
            {name: 'icon', values: points.map((point) => point.properties.icon)},
        );
    }
    return {
        extent: 4096,
        vertices: Int32Array.from(points.flatMap((point) => point.point)),
        ids,
        idPresent,
        columns,
        availablePropertyNames: pointSnapshotPropertyNames,
    };
}

function pointSnapshotTransferables(snapshot: PointFeatureTableSnapshot): ArrayBuffer[] {
    const buffers = [
        snapshot.vertices.buffer as ArrayBuffer,
        snapshot.ids.buffer as ArrayBuffer,
        snapshot.idPresent.buffer as ArrayBuffer,
    ];
    for (const column of snapshot.columns) {
        if (column.values instanceof Int32Array) buffers.push(column.values.buffer as ArrayBuffer);
    }
    return Array.from(new Set(buffers));
}

function estimatePointSnapshotBytes(snapshot: PointFeatureTableSnapshot): number {
    let bytes = pointSnapshotTransferables(snapshot).reduce((sum, buffer) => sum + buffer.byteLength, 0);
    for (const name of snapshot.availablePropertyNames) bytes += name.length * 2;
    for (const column of snapshot.columns) {
        bytes += column.name.length * 2;
        if (Array.isArray(column.values)) {
            for (const value of column.values) bytes += value.length * 2;
        }
    }
    return bytes;
}

function pointSnapshotToFeatureTable(
    snapshot: PointFeatureTableSnapshot,
    propertyResolver?: (propertyName: string) => Vector | Vector[] | undefined,
): FeatureTable {
    const idVector = new IntFlatVector(
        'id',
        snapshot.ids,
        new BitVector(snapshot.idPresent, snapshot.ids.length),
    );
    const propertyVectors = snapshot.columns.map((column) => Array.isArray(column.values)
        ? createStringFlatVector(column.values, column.name)
        : new IntFlatVector(column.name, column.values, column.values.length));
    return new FeatureTable(
        syntheticPointLayer,
        createConstGeometryVector(
            snapshot.ids.length,
            GEOMETRY_TYPE.POINT,
            new TopologyVector(null, null, null),
            null,
            snapshot.vertices,
        ),
        idVector,
        propertyVectors,
        snapshot.extent,
        propertyResolver,
        snapshot.availablePropertyNames,
    );
}

export class MltTransferStrategy extends Benchmark {
    private readonly points = createPointFeatures();
    private rawBuffer: ArrayBuffer;
    private lastMetrics: BenchmarkIterationMetrics;

    constructor(private readonly strategy: TransferStrategy) {
        super();
    }

    async setup(): Promise<void> {
        this.rawBuffer = encodeFeatureTables([createSyntheticPointFeatureTable(this.points)]);
        this.runStrategy();
    }

    bench(): void {
        this.runStrategy();
    }

    getWorkload(): BenchmarkWorkload {
        return {
            corpus: ['synthetic/640-points'],
            parameters: {
                encoding: 'mlt',
                transferStrategy: this.strategy,
                querySelectivity: '10pct',
                outputPropertiesRead: true,
                outputGeometryRead: true,
            },
            operation: 'transfer and first query',
            operationsPerIteration: 1,
        };
    }

    takeIterationMetrics(): BenchmarkIterationMetrics {
        return this.lastMetrics;
    }

    private runStrategy(): void {
        const transferStart = performance.now();
        const featureIndex = new FeatureIndex(tileID);
        featureIndex.encoding = 'mlt';
        let transferredBytes = 0;
        let retainedBytes = 0;
        let sharedBytes = 0;

        if (this.strategy === 'raw-copy' || this.strategy === 'raw-shared') {
            let mainRawData: ArrayBuffer;
            if (this.strategy === 'raw-shared') {
                if (typeof SharedArrayBuffer === 'undefined') {
                    throw new Error('SharedArrayBuffer is unavailable for the shared MLT transfer benchmark.');
                }
                const shared = new SharedArrayBuffer(this.rawBuffer.byteLength);
                new Uint8Array(shared).set(new Uint8Array(this.rawBuffer));
                mainRawData = shared as unknown as ArrayBuffer;
            } else {
                mainRawData = this.rawBuffer.slice(0);
                recordMltMaterialization('rawTileBytesCopied', mainRawData.byteLength, {detail: 'transfer strategy raw copy'});
            }
            transferredBytes = this.strategy === 'raw-shared' ? 0 : mainRawData.byteLength;
            sharedBytes = this.strategy === 'raw-shared' ? mainRawData.byteLength : 0;
            retainedBytes = mainRawData.byteLength;
            featureIndex.rawTileData = mainRawData;
        } else {
            const fullProperties = this.strategy === 'feature-tables';
            const workerSnapshot = createPointSnapshot(this.points, fullProperties);
            const snapshotBytes = estimatePointSnapshotBytes(workerSnapshot);
            const transferredSnapshot = structuredClone(workerSnapshot, {
                transfer: pointSnapshotTransferables(workerSnapshot),
            });
            let rawFallback: ArrayBuffer | undefined;
            if (this.strategy === 'query-snapshot') {
                rawFallback = this.rawBuffer.slice(0);
                recordMltMaterialization('rawTileBytesCopied', rawFallback.byteLength, {detail: 'query snapshot raw fallback'});
            }
            const propertyResolver = rawFallback
                ? (propertyName: string) => {
                    const tile = new MLTVectorTile(rawFallback, {
                        layerNames: [syntheticPointLayer],
                        propertyColumnNamesByLayer: {[syntheticPointLayer]: [propertyName]},
                    });
                    return getMltFeatureTable(tile.layers[syntheticPointLayer])?.getPropertyVector(propertyName);
                }
                : undefined;
            const featureTable = pointSnapshotToFeatureTable(transferredSnapshot, propertyResolver);
            featureIndex.vtLayers = MLTVectorTile.fromFeatureTables([featureTable]).layers;
            featureIndex.rawTileData = rawFallback ?? new ArrayBuffer(1);
            transferredBytes = snapshotBytes + (rawFallback?.byteLength ?? 1);
            retainedBytes = transferredBytes;
        }
        const transferDurationMs = performance.now() - transferStart;

        const tile = new Tile(tileID, 512);
        tile.latestFeatureIndex = featureIndex;
        const queryStart = performance.now();
        const results: any[] = [];
        tile.querySourceFeatures(results, {
            sourceLayer: syntheticPointLayer,
            filter: ['<', ['get', 'sort'], 64],
        });
        for (const result of results) {
            void result.properties.label;
            void result.geometry.coordinates;
        }
        const firstQueryDurationMs = performance.now() - queryStart;
        if (results.length !== 64) {
            throw new Error(`${this.strategy} transfer query expected 64 results, received ${results.length}.`);
        }
        if (results[0].properties.label === undefined) {
            throw new Error(`${this.strategy} transfer query did not preserve public properties.`);
        }

        this.lastMetrics = {
            transferredBytes,
            retainedBytes,
            values: {
                transferDurationMs,
                firstQueryDurationMs,
                queryResults: results.length,
                sharedBytes,
            },
        };
    }
}
