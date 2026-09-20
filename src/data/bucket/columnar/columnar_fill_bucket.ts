import {FillLayoutArray} from '../../array_types.g';
import {EXTENT} from '../../extent';
import {members as layoutAttributes} from '../fill_attributes';
import {SegmentVector} from '../../segment';
import {ProgramConfigurationSet, type ColumnarPaintColumnProvider} from '../../program_configuration';
import {LineIndexArray, TriangleIndexArray} from '../../array_types.g';
import {register} from '../../../util/web_worker_transfer';
import {addPatternDependencies, hasPattern} from '../pattern_bucket_features';
import {createSelectionVector, GpuVector, type FeatureTable, type SelectionVector} from '@maplibre/mlt';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {fillLargeMeshArrays} from '../../../render/fill_large_mesh_arrays';
import {subdivideFlattenedPolygonWithRings} from '../../../render/subdivision';
import {clamp, warnOnce} from '../../../util/util';
import {forEachFeaturePolygonGeometry, forEachPolygonRing, forEachVertexInRange} from './polygon_traversal';
import {getColumnarPropertyColumns, type ColumnarPropertyColumn} from './feature_properties';
import {getColumnarEvaluationFeature} from './evaluation_feature';
import {normalizeMltFeatureId} from '../../../util/mlt_feature_id';
import {sortSelectionVectorByKey} from './selection_sort';
import {appendPretriangulatedFill} from './pretriangulated_fill';

import type {FeatureIndexBBox} from '../../feature_index';
import type {VectorTileLayer} from '@mapbox/vector-tile';
import type {Feature} from '@maplibre/maplibre-gl-style-spec';
import type {DashEntry} from '../../../render/line_atlas';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {ImagePosition} from '../../../render/image_atlas';
import type {FeatureStates} from '../../../source/source_state';
import type {VertexBuffer} from '../../../webgl/vertex_buffer.ts';
import type {IndexBuffer} from '../../../webgl/index_buffer.ts';
import type {Context} from '../../../webgl/context.ts';
import type {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    PopulateParameters
} from '../../bucket';
import type {BucketDependencyParameters} from '../../bucket.ts';
import type {StyleImage} from '../../../style/style_image.ts';
import type {GetImagesResponse} from '../../../util/actor_messages.ts';

const MAX_COORDINATE = Math.pow(2, 14) - 1;
const MIN_COORDINATE = -MAX_COORDINATE - 1;

type RingRange = {
    startVertexIndex: number;
    vertexCount: number;
};

function bboxFromFlattened(flattened: number[]): FeatureIndexBBox | undefined {
    if (flattened.length < 2) return undefined;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let offset = 0; offset < flattened.length; offset += 2) {
        const x = flattened[offset];
        const y = flattened[offset + 1];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }

    return [minX, minY, maxX, maxY];
}

export class ColumnarFillBucket implements Bucket<FeatureTable> {
    // Temporary MLT bridge: remove isColumnar once MLT has its own worker pipeline separate from MVT.
    // Used by worker_tile to route FeatureTable to columnar buckets while the two pipelines are shared.
    readonly isColumnar = true;

    index: number;
    zoom: number;
    overscaling: number;
    layers: FillStyleLayer[];
    layerIds: string[];
    stateDependentLayers: FillStyleLayer[];
    stateDependentLayerIds: string[];
    patternFeatures: BucketFeature[];
    sdfPatterns: Record<string, boolean> = {};

    layoutVertexArray: FillLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    indexArray2: LineIndexArray;
    indexBuffer2: IndexBuffer;

    hasDependencies: boolean;
    hasDataDrivenProperties: boolean;
    programConfigurations: ProgramConfigurationSet<FillStyleLayer>;
    segments: SegmentVector;
    segments2: SegmentVector;
    uploaded: boolean;
    pendingFeatureTable?: FeatureTable;
    pendingSelectionVector?: SelectionVector;
    pendingCanonical?: CanonicalTileID;
    private _neededProperties: Set<string> | null;
    private _propertyColumnByName: Map<string, ColumnarPropertyColumn>;
    private getPaintPropertyColumn: ColumnarPaintColumnProvider;
    featureIndexSelectionVector?: SelectionVector;
    featureIndexBBoxes?: Array<FeatureIndexBBox[] | FeatureIndexBBox>;

    constructor(options: BucketParameters<FillStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasDependencies = false;
        this.patternFeatures = [];

        this.layoutVertexArray = new FillLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.indexArray2 = new LineIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.hasDataDrivenProperties = this.layers.length > 0 && this.layers[0].hasDataDrivenPaintProperties();
        this.segments = new SegmentVector();
        this.segments2 = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
        this._neededProperties = null;
        this._propertyColumnByName = new Map();
        this.getPaintPropertyColumn = (propertyName: string) => this._propertyColumnByName.get(propertyName);
    }

    populate(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        this.populatePolygon(featureTable, options, canonical);
    }

    update(states: FeatureStates, vtLayer: VectorTileLayer | undefined, imagePositions: Record<string, ImagePosition>, _dashPositions?: Record<string, DashEntry>): void {
        this.updateColumnar(states, vtLayer, imagePositions);
    }

    populatePolygon(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        const serializedPaint = this.layers[0].serialize().paint ?? {};
        this.hasDependencies = hasPattern('fill', this.layers, options);

        const fillSortKey = this.layers[0].layout.get('fill-sort-key');
        const shouldSort = !fillSortKey.isConstant() || fillSortKey.constantOr(null) !== null;
        const sortKeyPropertyName = this.getSortKeyPropertyName(this.layers[0].serialize().layout?.['fill-sort-key']);

        const filterSpecification = this.layers[0].filter as any;
        let selectionVector: SelectionVector;

        if (!filterSpecification) {
            selectionVector = createSelectionVector(featureTable.numFeatures);
        } else {
            selectionVector = filter(featureTable, filterSpecification, this.layers[0].getGlobalState(), canonical, new EvaluationParameters(this.zoom));
        }

        if (selectionVector.limit === 0) {
            this.featureIndexSelectionVector = selectionVector;
            this.prepareFeatureStateData(featureTable, options);
            return;
        }

        if (shouldSort && sortKeyPropertyName) {
            this.sortSelectionVector(selectionVector, featureTable, sortKeyPropertyName);
        }
        this.featureIndexSelectionVector = selectionVector;
        this.featureIndexBBoxes = [];

        this._neededProperties = this.hasDependencies
            ? null
            : this.programConfigurations.getFeaturePropertyDependencies();
        this._propertyColumnByName.clear();
        for (const propertyColumn of getColumnarPropertyColumns(featureTable, this._neededProperties)) {
            this._propertyColumnByName.set(propertyColumn.name, propertyColumn);
        }

        if (this.hasDependencies && serializedPaint['fill-pattern'] !== undefined) {
            this.collectPatternDependencies(featureTable, selectionVector, options);
            this.pendingFeatureTable = featureTable;
            this.pendingSelectionVector = selectionVector;
            this.pendingCanonical = canonical;
            return;
        }

        this.addGeometryPolygons(selectionVector, featureTable, canonical, {}, options);
        this.prepareFeatureStateData(featureTable, options);
    }

    addFeatures({options, canonical, patternPositions: imagePositions, patternMap}: BucketDependencyParameters): void {
        if (!this.pendingFeatureTable || !this.pendingSelectionVector) {
            return;
        }

        this.detectSdfPatterns(patternMap);
        this.addGeometryPolygons(this.pendingSelectionVector, this.pendingFeatureTable, this.pendingCanonical ?? canonical, imagePositions, options);
        this.prepareFeatureStateData(this.pendingFeatureTable, options);

        this.patternFeatures = [];
        this.pendingFeatureTable = undefined;
        this.pendingSelectionVector = undefined;
        this.pendingCanonical = undefined;
    }

    private detectSdfPatterns(imageMap: GetImagesResponse): void {
        for (const feature of this.patternFeatures) {
            for (const layerId in feature.patterns) {
                const pattern = feature.patterns[layerId];
                this.recordSdfPattern(layerId, imageMap[pattern.min]);
                this.recordSdfPattern(layerId, imageMap[pattern.mid]);
                this.recordSdfPattern(layerId, imageMap[pattern.max]);
            }
        }

        for (const layer of this.layers) {
            const pattern = layer.paint.get('fill-pattern').constantOr(null);
            if (pattern) {
                this.recordSdfPattern(layer.id, imageMap[pattern.from.toString()]);
                this.recordSdfPattern(layer.id, imageMap[pattern.to.toString()]);
            }
        }
    }

    private recordSdfPattern(layerId: string, image: StyleImage | undefined): void {
        if (!image) return;

        const isSdf = image.sdf === true;
        const existing = this.sdfPatterns[layerId];
        if (existing === undefined) {
            this.sdfPatterns[layerId] = isSdf;
        } else if (existing !== isSdf) {
            warnOnce(`Style sheet warning: Cannot mix SDF and non-SDF fill patterns in layer "${layerId}"`);
        }
    }

    private collectPatternDependencies(featureTable: FeatureTable, selectionVector: SelectionVector, options: PopulateParameters): void {
        for (let i = 0; i < selectionVector.limit; i++) {
            const featureIndex = Number(selectionVector.getIndex(i));
            const feature = this.createPatternFeature(featureTable, featureIndex);
            addPatternDependencies('fill', this.layers, feature, {zoom: this.zoom}, options);
            this.patternFeatures.push(feature);
        }
    }

    updateColumnar(states: FeatureStates, vtLayer: VectorTileLayer | undefined, imagePositions: {
        [_: string]: ImagePosition;
    }): void {
        if (!this.stateDependentLayers.length) return;
        const featureTable = (vtLayer as any)?.featureTable as FeatureTable | undefined;
        const featureProvider = featureTable
            ? (index: number) => this.createFeature(featureTable, index)
            : undefined;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {imagePositions}, featureProvider);
    }

    canUpdateFeatureStateWithoutVtLayer(): boolean {
        return this.programConfigurations.canUpdatePaintArraysWithoutVtLayer();
    }

    private prepareFeatureStateData(featureTable: FeatureTable, options: PopulateParameters): void {
        this.programConfigurations.prepareColumnarFeatureStateData(
            featureTable,
            (featureIndex) => options.featureIndex.getMltId(featureTable, featureIndex, featureTable.name),
        );
    }

    isEmpty(): boolean {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context): void {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
            this.indexBuffer2 = context.createIndexBuffer(this.indexArray2);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy(): void {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.indexBuffer2.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.segments2.destroy();
    }

    addGeometryPolygons(selectionVector: SelectionVector, featureTable: FeatureTable, canonical: CanonicalTileID, imagePositions: {
        [_: string]: ImagePosition;
    }, options?: PopulateParameters): void {
        const paintOptions = {
            imagePositions, canonical
        };
        const scaleFactor = EXTENT / featureTable.extent;
        const granularity = options?.subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z) ?? 1;
        const usePretriangulation = featureTable.geometryVector instanceof GpuVector && this.overscaling === 1 &&
            options?.subdivisionGranularity.fill.getGranularityForZoomLevel(0) === 1 &&
            canonical.y > 0 && canonical.y < (1 << canonical.z) - 1;
        const columnarPaintArrays = this.hasDataDrivenProperties &&
            !this.hasDependencies &&
            this.programConfigurations.canPopulateColumnarPaintArrays(this.getPaintPropertyColumn);

        for (let i = 0; i < selectionVector.limit; i++) {
            const featureOffset = Number(selectionVector.getIndex(i));
            let featureAddedGeometry = false;
            const meshBBoxes = usePretriangulation ? appendPretriangulatedFill(featureTable, featureOffset,
                this.layoutVertexArray, this.indexArray, this.indexArray2, this.segments, this.segments2) : undefined;
            const featureBBoxes: FeatureIndexBBox[] = meshBBoxes ?? [];
            featureAddedGeometry = featureBBoxes.length > 0;

            if (!meshBBoxes) forEachFeaturePolygonGeometry(featureTable, featureOffset, (_selectedFeatureIndex, _polygonIndex, firstPartOffset, secondPartOffset, topologyVector) => {
                const flattened: number[] = [];
                const holeIndices: number[] = [];
                const ringRanges: RingRange[] = [];

                forEachPolygonRing(featureTable, topologyVector, firstPartOffset, secondPartOffset, (ringIndex, firstRingOffset, secondRingOffset) => {
                    if (firstRingOffset === undefined || secondRingOffset === undefined || firstRingOffset >= secondRingOffset) {
                        return;
                    }

                    const ringStartIndex = flattened.length / 2;
                    forEachVertexInRange(featureTable, firstRingOffset, secondRingOffset, (x, y) => {
                        const rawScaledX = x * scaleFactor;
                        const rawScaledY = y * scaleFactor;

                        const scaledX = clamp(Math.round(rawScaledX), MIN_COORDINATE, MAX_COORDINATE);
                        const scaledY = clamp(Math.round(rawScaledY), MIN_COORDINATE, MAX_COORDINATE);
                        if (isNaN(scaledX) || isNaN(scaledY)) {
                            return;
                        }

                        flattened.push(scaledX, scaledY);
                    });

                    let ringVertexCount = flattened.length / 2 - ringStartIndex;
                    if (ringVertexCount <= 0) {
                        return;
                    }

                    const ringOffset = ringStartIndex * 2;
                    const firstX = flattened[ringOffset];
                    const firstY = flattened[ringOffset + 1];
                    const lastX = flattened[flattened.length - 2];
                    const lastY = flattened[flattened.length - 1];

                    if (lastX !== firstX || lastY !== firstY) {
                        flattened.push(firstX, firstY);
                        ringVertexCount++;
                    }

                    if (ringIndex > firstPartOffset) {
                        holeIndices.push(ringStartIndex);
                    }

                    ringRanges.push({startVertexIndex: ringStartIndex, vertexCount: ringVertexCount});
                });

                if (flattened.length < 6) {
                    return;
                }

                const subdivided = subdivideFlattenedPolygonWithRings(
                    flattened,
                    holeIndices,
                    ringRanges,
                    canonical,
                    granularity,
                );

                if (subdivided.indicesTriangles.length === 0) {
                    return;
                }
                const bbox = bboxFromFlattened(flattened);

                fillLargeMeshArrays(
                    (x, y) => {
                        this.layoutVertexArray.emplaceBack(x, y);
                    },
                    this.segments,
                    this.layoutVertexArray,
                    this.indexArray,
                    subdivided.verticesFlattened,
                    subdivided.indicesTriangles,
                    this.segments2,
                    this.indexArray2,
                    subdivided.indicesLineList,
                );

                featureAddedGeometry = true;
                if (bbox) {
                    featureBBoxes.push(bbox);
                }
            });

            if (featureBBoxes.length === 1) {
                this.featureIndexBBoxes[featureOffset] = featureBBoxes[0];
            } else if (featureBBoxes.length > 1) {
                this.featureIndexBBoxes[featureOffset] = featureBBoxes;
            }

            if (featureAddedGeometry && this.hasDataDrivenProperties) {
                if (columnarPaintArrays) {
                    this.programConfigurations.populateColumnarPaintArrays(this.layoutVertexArray.length, featureOffset, this.featureId(featureTable, featureOffset), this.getPaintPropertyColumn);
                } else {
                    this.populateFeaturePaintArrays(featureTable, featureOffset, paintOptions, options);
                }
            }
        }
    }

    private getSortKeyPropertyName(sortKeySpec: unknown): string | null {
        if (!Array.isArray(sortKeySpec)) {
            return typeof sortKeySpec === 'string' ? sortKeySpec : null;
        }

        return sortKeySpec[0] === 'get' && typeof sortKeySpec[1] === 'string'
            ? sortKeySpec[1]
            : null;
    }

    private sortSelectionVector(selectionVector: SelectionVector, featureTable: FeatureTable, sortKeyName: string): void {
        if (selectionVector.limit <= 1) {
            return;
        }

        const propertyVector = featureTable.getPropertyVector(sortKeyName);

        if (!propertyVector) {
            return;
        }

        sortSelectionVectorByKey(selectionVector, (featureIndex) => propertyVector.getValue(featureIndex));
    }

    addPolygonOutlines(featureTable: FeatureTable, selectionVector: SelectionVector, canonical: CanonicalTileID): void {
        const topologyVector = featureTable.geometryVector.topologyVector;
        const ringOffsets = topologyVector.ringOffsets;
        const partOffsets = topologyVector.partOffsets;
        const scaleFactor = EXTENT / featureTable.extent;

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            let ringOffset = partOffsets[index];
            const numRings = partOffsets[index + 1] - ringOffset;

            for (let j = 0; j < numRings; j++) {
                const ringOffsetStart = ringOffsets[ringOffset++];
                const ringOffsetEnd = ringOffsets[ringOffset];
                const numVertices = ringOffsetEnd - ringOffsetStart;

                // FIXED: Use shared layoutVertexArray
                const lineSegment = this.segments2.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray2);
                const lineIndex = lineSegment.vertexLength;

                // ADD THE ACTUAL VERTICES
                for (let k = ringOffsetStart; k < ringOffsetEnd; k++) {
                    forEachVertexInRange(featureTable, k, k + 1, (x, y) => {
                        this.layoutVertexArray.emplaceBack(x * scaleFactor, y * scaleFactor);
                    });
                }

                this.indexArray2.emplaceBack(lineIndex + numVertices - 1, lineIndex);
                for (let k = 1; k < numVertices; k++) {
                    this.indexArray2.emplaceBack(lineIndex + k - 1, lineIndex + k);
                }

                lineSegment.vertexLength += numVertices;
                lineSegment.primitiveLength += numVertices;
            }

            const featureIndex = Number(selectionVector.getIndex(i));
            const feature = this.hasDataDrivenProperties ? this.createFeature(featureTable, featureIndex) : {id: featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(featureIndex), featureIndex) : featureIndex} as any;
            const paintOptions = {
                imagePositions: null, canonical
            };

            this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, featureIndex, paintOptions);
        }
    }

    addMultiPolygonOutlines(featureTable: FeatureTable, selectionVector: SelectionVector, canonical: CanonicalTileID): void {
        const topologyVector = featureTable.geometryVector.topologyVector;
        const geometryOffsets = topologyVector.geometryOffsets;
        const ringOffsets = topologyVector.ringOffsets;
        const partOffsets = topologyVector.partOffsets;
        const scaleFactor = EXTENT / featureTable.extent;

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            let partOffset = geometryOffsets[index];
            const numPolygons = geometryOffsets[index + 1] - partOffset;

            for (let l = 0; l < numPolygons; l++) {
                let ringOffset = partOffsets[partOffset++];
                const numRings = partOffsets[partOffset] - ringOffset;

                for (let j = 0; j < numRings; j++) {
                    const ringOffsetStart = ringOffsets[ringOffset++];
                    const ringOffsetEnd = ringOffsets[ringOffset];
                    const numVertices = ringOffsetEnd - ringOffsetStart;

                    // FIXED: Use shared layoutVertexArray
                    const lineSegment = this.segments2.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray2);
                    const lineIndex = lineSegment.vertexLength;

                    // ADD THE ACTUAL VERTICES
                    for (let k = ringOffsetStart; k < ringOffsetEnd; k++) {
                        forEachVertexInRange(featureTable, k, k + 1, (x, y) => {
                            this.layoutVertexArray.emplaceBack(x * scaleFactor, y * scaleFactor);
                        });
                    }

                    this.indexArray2.emplaceBack(lineIndex + numVertices - 1, lineIndex);
                    for (let k = 1; k < numVertices; k++) {
                        this.indexArray2.emplaceBack(lineIndex + k - 1, lineIndex + k);
                    }

                    lineSegment.vertexLength += numVertices;
                    lineSegment.primitiveLength += numVertices;
                }
            }

            const featureIndex = Number(selectionVector.getIndex(i));
            const feature = this.hasDataDrivenProperties ? this.createFeature(featureTable, featureIndex) : {id: featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(featureIndex), featureIndex) : featureIndex} as any;
            const paintOptions = {
                imagePositions: null, canonical
            };

            this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, featureIndex, paintOptions);
        }
    }

    /** Pattern and state expressions share a columnar property view instead of copying each row. */
    private createFeature(featureTable: FeatureTable, featureIndex: number): Feature {
        const properties = getColumnarEvaluationFeature(featureTable, featureIndex).properties;
        const id = this.featureId(featureTable, featureIndex);
        return {
            type: 'Polygon', id, properties, geometry: []
        };
    }

    private featureId(featureTable: FeatureTable, featureIndex: number): number | string {
        return featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(featureIndex), featureIndex) : featureIndex;
    }

    private createPatternFeature(featureTable: FeatureTable, featureIndex: number): Feature & BucketFeature {
        const feature = this.createFeature(featureTable, featureIndex) as Feature & BucketFeature;
        (feature as any).index = featureIndex;
        (feature as any).sourceLayerIndex = 0;
        (feature as any).patterns = {};
        return feature;
    }

    private populateFeaturePaintArrays(
        featureTable: FeatureTable,
        featureIndex: number,
        paintOptions: {imagePositions: {[_: string]: ImagePosition}; canonical: CanonicalTileID},
        options?: PopulateParameters
    ): void {
        const feature = this.hasDependencies && options
            ? this.createPatternFeature(featureTable, featureIndex)
            : this.createFeature(featureTable, featureIndex);

        if (this.hasDependencies && options) {
            addPatternDependencies('fill', this.layers, feature as any, {zoom: this.zoom}, options);
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, featureIndex, paintOptions);
    }

}

register('ColumnarFillBucket', ColumnarFillBucket, {omit: [
    'layers',
    'patternFeatures',
    'pendingFeatureTable',
    'pendingSelectionVector',
    'pendingCanonical',
    '_neededProperties',
    '_propertyColumnByName',
    'getPaintPropertyColumn',
    'featureIndexSelectionVector',
    'featureIndexBBoxes'
]} as any);
