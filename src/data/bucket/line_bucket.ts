import {LineLayoutArray, LineExtLayoutArray} from '../array_types.g.ts';
import {members as layoutAttributes} from './line_attributes.ts';
import {members as layoutAttributesExt} from './line_attributes_ext.ts';
import {SegmentVector} from '../segment.ts';
import {ProgramConfigurationSet} from '../program_configuration.ts';
import {TriangleIndexArray} from '../array_types.g.ts';
import {VectorTileFeature} from '@mapbox/vector-tile';
import {register} from '../../util/web_worker_transfer.ts';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features.ts';
import {loadGeometry} from '../load_geometry.ts';
import {toEvaluationFeature} from '../evaluation_feature.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {LineGeometryBase} from './line_geometry_base.ts';
import {lineClipPropertyNames} from './line_clip_properties.ts';
import {
    EXTRUDE_SCALE,
    LINE_DISTANCE_SCALE,
    MAX_LINE_DISTANCE,
} from './line_geometry_constants.ts';
import {subdivideVertexLine} from '../../render/subdivision.ts';

import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    BucketDependencyParameters,
    IndexedFeature,
    PopulateParameters
} from '../bucket.ts';
import type {LineStyleLayer} from '../../style/style_layer/line_style_layer.ts';
import type Point from '@mapbox/point-geometry';
import type {Segment} from '../segment.ts';
import type {RGBAImage} from '../../util/image.ts';
import type {Context} from '../../webgl/context.ts';
import type {Texture} from '../../webgl/texture.ts';
import type {IndexBuffer} from '../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../webgl/vertex_buffer.ts';
import type {FeatureStates} from '../../source/source_state.ts';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import type {DashEntry} from '../../render/line_atlas.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

type LineClips = {
    start: number;
    end: number;
};

type GradientTexture = {
    texture?: Texture;
    gradient?: RGBAImage;
    version?: number;
};

/**
 * @internal
 * Line bucket class
 */
export class LineBucket extends LineGeometryBase implements Bucket<IndexedFeature[]> {
    maxLineLength: number;
    lineClips?: LineClips;

    index: number;
    zoom: number;
    overscaling: number;
    layers: LineStyleLayer[];
    layerIds: string[];
    gradients: {[x: string]: GradientTexture};
    stateDependentLayers: any[];
    stateDependentLayerIds: string[];
    patternFeatures: BucketFeature[];
    lineClipsArray: LineClips[];

    layoutVertexArray: LineLayoutArray;
    layoutVertexBuffer: VertexBuffer;
    layoutVertexArray2: LineExtLayoutArray;
    layoutVertexBuffer2: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    hasDependencies: boolean;
    programConfigurations: ProgramConfigurationSet<LineStyleLayer>;
    segments: SegmentVector;
    uploaded: boolean;

    constructor(options: BucketParameters<LineStyleLayer>) {
        super();
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasDependencies = false;
        this.patternFeatures = [];
        this.lineClipsArray = [];
        this.gradients = {};
        for (const layer of this.layers) {
            this.gradients[layer.id] = {};
        }

        this.layoutVertexArray = new LineLayoutArray();
        this.layoutVertexArray2 = new LineExtLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.maxLineLength = 0;

        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
        this.hasDependencies = hasPattern('line', this.layers, options) || this.hasLineDasharray(this.layers);
        const lineSortKey = this.layers[0].layout.get('line-sort-key');
        const sortFeaturesByKey = !lineSortKey.isConstant();
        const bucketFeatures: BucketFeature[] = [];

        const globalProperties = new EvaluationParameters(this.zoom);
        const needGeometry = this.layers[0]._featureFilter.needGeometry;
        for (const {feature, id, index, sourceLayerIndex} of features) {
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            if (!this.layers[0]._featureFilter.filter(globalProperties, evaluationFeature, canonical)) continue;

            const sortKey = sortFeaturesByKey ?
                lineSortKey.evaluate(evaluationFeature, {}, canonical) :
                undefined;

            const bucketFeature: BucketFeature = {
                id,
                properties: feature.properties,
                type: feature.type,
                sourceLayerIndex,
                index,
                geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature),
                patterns: {},
                dashes: {},
                sortKey
            };

            bucketFeatures.push(bucketFeature);
        }

        if (sortFeaturesByKey) {
            bucketFeatures.sort((a, b) => {
                return (a.sortKey) - (b.sortKey);
            });
        }

        for (const bucketFeature of bucketFeatures) {
            const {geometry, index, sourceLayerIndex} = bucketFeature;

            if (this.hasDependencies) {
                if (hasPattern('line', this.layers, options)) {
                    addPatternDependencies('line', this.layers, bucketFeature, {zoom: this.zoom}, options);
                } else if (this.hasLineDasharray(this.layers)) {
                    this.addLineDashDependencies(this.layers, bucketFeature, this.zoom, options);
                }

                // pattern features are added only once the pattern is loaded into the image atlas
                // so are stored during populate until later updated with positions by tile worker in addFeatures
                this.patternFeatures.push(bucketFeature);
            } else {
                this.addFeature(bucketFeature, geometry, index, canonical, {}, {}, options.subdivisionGranularity);
            }

            const feature = features[index].feature;
            options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike, imagePositions: {[_: string]: ImagePosition}, dashPositions?: Record<string, DashEntry>): void {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {
            imagePositions,
            dashPositions
        });
    }

    addFeatures({options, canonical, patternPositions, dashPositions}: BucketDependencyParameters): void {
        for (const feature of this.patternFeatures) {
            this.addFeature(feature, feature.geometry, feature.index, canonical, patternPositions, dashPositions, options.subdivisionGranularity);
        }
    }

    isEmpty(): boolean {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context): void {
        if (!this.uploaded) {
            if (this.layoutVertexArray2.length !== 0) {
                this.layoutVertexBuffer2 = context.createVertexBuffer(this.layoutVertexArray2, layoutAttributesExt);
            }
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy(): void {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
    }

    lineFeatureClips(feature: BucketFeature): LineClips | undefined {
        if (!feature.properties) return;
        for (const [startKey, endKey] of lineClipPropertyNames) {
            if (Object.hasOwn(feature.properties, startKey) && Object.hasOwn(feature.properties, endKey)) {
                return {start: +feature.properties[startKey], end: +feature.properties[endKey]};
            }
        }
    }

    addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, imagePositions: {[_: string]: ImagePosition}, dashPositions: Record<string, DashEntry>, subdivisionGranularity: SubdivisionGranularitySetting): void {
        const layout = this.layers[0].layout;
        const join = layout.get('line-join').evaluate(feature, {});
        const cap = layout.get('line-cap').evaluate(feature, {});
        const miterLimit = layout.get('line-miter-limit').evaluate(feature, {});
        const roundLimit = layout.get('line-round-limit').evaluate(feature, {});
        this.lineClips = this.lineFeatureClips(feature);

        for (const line of geometry) {
            this.addLine(line, feature, join, cap, miterLimit, roundLimit, canonical, subdivisionGranularity);
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions, dashPositions, canonical});
    }

    addLine(vertices: Point[], feature: BucketFeature, join: string, cap: string, miterLimit: number, roundLimit: number, canonical: CanonicalTileID | undefined, subdivisionGranularity: SubdivisionGranularitySetting): void {
        this.distance = 0;
        this.scaledDistance = 0;
        this.totalDistance = 0;

        // First, subdivide the line if needed (mostly for globe rendering)
        const granularity = canonical ? subdivisionGranularity.line.getGranularityForZoomLevel(canonical.z) : 1;
        vertices = subdivideVertexLine(vertices, granularity);

        if (this.lineClips) {
            this.lineClipsArray.push(this.lineClips);
            // Calculate the total distance, in tile units, of this tiled line feature
            for (let i = 0; i < vertices.length - 1; i++) {
                this.totalDistance += vertices[i].dist(vertices[i + 1]);
            }
            this.updateScaledDistance();
            this.maxLineLength = Math.max(this.maxLineLength, this.totalDistance);
        }

        const isPolygon = VectorTileFeature.types[feature.type] === 'Polygon';

        // If the line has duplicate vertices at the ends, adjust start/length to remove them.
        let len = vertices.length;
        while (len >= 2 && vertices[len - 1].equals(vertices[len - 2])) {
            len--;
        }
        let first = 0;
        while (first < len - 1 && vertices[first].equals(vertices[first + 1])) {
            first++;
        }

        // Ignore invalid geometry.
        if (len - first < (isPolygon ? 3 : 2)) return;

        // Point satisfies LineVertex (has .x and .y), so the slice can be passed directly.
        this.addLineGeometry(vertices.slice(first, len), isPolygon, join, cap, miterLimit, roundLimit);
    }

    updateScaledDistance(): void {
        // Knowing the ratio of the full linestring covered by this tiled feature, as well
        // as the total distance (in tile units) of this tiled feature, and the distance
        // (in tile units) of the current vertex, we can determine the relative distance
        // of this vertex along the full linestring feature and scale it to [0, 2^15)
        this.scaledDistance = this.lineClips ?
            this.lineClips.start + (this.lineClips.end - this.lineClips.start) * this.distance / this.totalDistance :
            this.distance;
    }

    protected writeHalfVertex(
        x: number, y: number,
        extrudeX: number, extrudeY: number,
        round: boolean, up: boolean, dir: number,
        _segment: Segment
    ): void {
        const totalDistance = this.lineClips ? this.scaledDistance * (MAX_LINE_DISTANCE - 1) : this.scaledDistance;
        // scale down so that we can store longer distances while sacrificing precision.
        const linesofarScaled = totalDistance * LINE_DISTANCE_SCALE;

        this.layoutVertexArray.emplaceBack(
            // a_pos_normal
            // Encode round/up the least significant bits
            (x << 1) + (round ? 1 : 0),
            (y << 1) + (up ? 1 : 0),
            // a_data
            // add 128 to store a byte in an unsigned byte
            Math.round(EXTRUDE_SCALE * extrudeX) + 128,
            Math.round(EXTRUDE_SCALE * extrudeY) + 128,
            // Encode the -1/0/1 direction value into the first two bits of .z of a_data.
            // Combine it with the lower 6 bits of `linesofarScaled` (shifted by 2 bits to make
            // room for the direction value). The upper 8 bits of `linesofarScaled` are placed in
            // the `w` component.
            ((dir === 0 ? 0 : (dir < 0 ? -1 : 1)) + 1) | ((linesofarScaled & 0x3F) << 2),
            linesofarScaled >> 6);

        // Constructs a second vertex buffer with higher precision line progress
        if (this.lineClips) {
            const progressRealigned = this.scaledDistance - this.lineClips.start;
            const endClipRealigned = this.lineClips.end - this.lineClips.start;
            const uvX = progressRealigned / endClipRealigned;
            this.layoutVertexArray2.emplaceBack(uvX, this.lineClipsArray.length);
        }
    }

    private hasLineDasharray(layers: LineStyleLayer[]): boolean {
        for (const layer of layers) {
            const dasharrayProperty = layer.paint.get('line-dasharray');
            if (dasharrayProperty && !dasharrayProperty.isConstant()) {
                return true;
            }
        }
        return false;
    }

    private addLineDashDependencies(layers: LineStyleLayer[], bucketFeature: BucketFeature, zoom: number, options: PopulateParameters) {
        for (const layer of layers) {
            const dasharrayProperty = layer.paint.get('line-dasharray');

            if (!dasharrayProperty || dasharrayProperty.value.kind === 'constant') {
                continue;
            }

            const round = layer.layout.get('line-cap').evaluate(bucketFeature, {}) === 'round';

            const min = {
                dasharray: dasharrayProperty.value.evaluate({zoom: zoom - 1}, bucketFeature, {}),
                round
            };
            const mid = {
                dasharray: dasharrayProperty.value.evaluate({zoom}, bucketFeature, {}),
                round
            };
            const max = {
                dasharray: dasharrayProperty.value.evaluate({zoom: zoom + 1}, bucketFeature, {}),
                round
            };

            const minKey = `${min.dasharray.join(',')},${min.round}`;
            const midKey = `${mid.dasharray.join(',')},${mid.round}`;
            const maxKey = `${max.dasharray.join(',')},${max.round}`;

            options.dashDependencies[minKey] = min;
            options.dashDependencies[midKey] = mid;
            options.dashDependencies[maxKey] = max;

            bucketFeature.dashes[layer.id] = {min: minKey, mid: midKey, max: maxKey};
        }
    }
}

register('LineBucket', LineBucket, {omit: ['layers', 'patternFeatures']});
