import {FillExtrusionLayoutArray, PosArray} from '../../array_types.g';
import {members as layoutAttributes, centroidAttributes} from '../fill_extrusion_attributes';
import {type Segment, SegmentVector} from '../../segment';
import {ProgramConfigurationSet, type ColumnarPaintColumnProvider} from '../../program_configuration';
import {TriangleIndexArray} from '../../array_types.g';
import {EXTENT} from '../../extent';
import {register} from '../../../util/web_worker_transfer';
import {addPatternDependencies, hasPattern} from '../pattern_bucket_features';
import {createSelectionVector, type FeatureTable, type SelectionVector} from '@maplibre/mlt';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {subdivideFlattenedPolygon, subdivideFlattenedVertexLine} from '../../../render/subdivision';
import {fillLargeMeshArrays} from '../../../render/fill_large_mesh_arrays';
import {VectorTileFeature} from '@mapbox/vector-tile';
import {normalizeMltFeatureId} from '../../../util/mlt_feature_id';
import {forEachFeaturePolygonGeometry, forEachPolygonRing, forEachVertexInRange} from './polygon_traversal';
import {getColumnarPropertyColumns, normalizeColumnarValue, type ColumnarPropertyColumn} from './feature_properties';

import type {FillExtrusionStyleLayer} from '../../../style/style_layer/fill_extrusion_style_layer';
import type {
    Bucket,
    BucketFeature,
    BucketParameters,
    PopulateParameters
} from '../../bucket';
import type {Context} from '../../../webgl/context.ts';
import type {IndexBuffer} from '../../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../../webgl/vertex_buffer.ts';
import type {FeatureStates} from '../../../source/source_state';
import type {ImagePosition} from '../../../render/image_atlas';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';
import type {DashEntry} from '../../../render/line_atlas';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {FeatureIndexBBox} from '../../feature_index';
import type {BucketDependencyParameters} from '../../bucket.ts';

const FACTOR = Math.pow(2, 13);

type FlattenedPolygon = {
    flattened: number[];
    holeIndices: number[];
    ringRanges: Array<{start: number; end: number}>;
    centroidX: number;
    centroidY: number;
    centroidSampleCount: number;
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

function addVertex(vertexArray, x, y, nx, ny, nz, t, e): void {
    vertexArray.emplaceBack(
        x,
        y,
        Math.floor(nx * FACTOR) * 2 + t,
        ny * FACTOR * 2,
        nz * FACTOR * 2,
        Math.round(e)
    );
}

export class ColumnarFillExtrusionBucket implements Bucket<FeatureTable> {
    readonly isColumnar = true;

    index: number;
    zoom: number;
    overscaling: number;
    layers: FillExtrusionStyleLayer[];
    layerIds: string[];
    stateDependentLayers: FillExtrusionStyleLayer[];
    stateDependentLayerIds: string[];

    layoutVertexArray: FillExtrusionLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    centroidVertexArray: PosArray;
    centroidVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    hasDependencies: boolean;
    programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;
    segments: SegmentVector;
    uploaded: boolean;
    pendingFeatureTable?: FeatureTable;
    pendingSelectionVector?: SelectionVector;
    pendingCanonical?: CanonicalTileID;
    private _propertyColumnByName: Map<string, ColumnarPropertyColumn>;
    private getPaintPropertyColumn: ColumnarPaintColumnProvider;
    featureIndexSelectionVector?: SelectionVector;
    featureIndexBBoxes?: Array<FeatureIndexBBox[] | FeatureIndexBBox>;

    constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map((layer) => layer.id);
        this.index = options.index;
        this.hasDependencies = false;

        this.layoutVertexArray = new FillExtrusionLayoutArray();
        this.centroidVertexArray = new PosArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
        this._propertyColumnByName = new Map();
        this.getPaintPropertyColumn = (propertyName: string) => this._propertyColumnByName.get(propertyName);
    }

    populate(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        this.hasDependencies = hasPattern('fill-extrusion', this.layers, options);
        const filterSpecification = this.layers[0].filter as any;
        const selectionVector = filterSpecification ? filter(featureTable, filterSpecification, this.layers[0].getGlobalState(), canonical, new EvaluationParameters(this.zoom)) : createSelectionVector(featureTable.numFeatures);

        if (selectionVector.limit === 0) {
            this.featureIndexSelectionVector = selectionVector;
            this.prepareFeatureStateData(featureTable, options);
            return;
        }
        this.featureIndexSelectionVector = selectionVector;
        this.featureIndexBBoxes = [];
        this._propertyColumnByName.clear();
        for (const propertyColumn of getColumnarPropertyColumns(featureTable, this.hasDependencies ? null : this.programConfigurations.getFeaturePropertyDependencies())) {
            this._propertyColumnByName.set(propertyColumn.name, propertyColumn);
        }

        const serializedPaint = this.layers[0].serialize().paint ?? {};
        if (this.hasDependencies && serializedPaint['fill-extrusion-pattern'] !== undefined) {
            this.collectPatternDependencies(featureTable, selectionVector, options);
            this.pendingFeatureTable = featureTable;
            this.pendingSelectionVector = selectionVector;
            this.pendingCanonical = canonical;
            return;
        }

        this.populateSelectedFeatures(featureTable, selectionVector, options, canonical, {});
        this.prepareFeatureStateData(featureTable, options);
    }

    addFeatures({options, canonical, patternPositions: imagePositions}: BucketDependencyParameters): void {
        if (!this.pendingFeatureTable || !this.pendingSelectionVector) {
            return;
        }

        this.populateSelectedFeatures(this.pendingFeatureTable, this.pendingSelectionVector, options, this.pendingCanonical ?? canonical, imagePositions);
        this.prepareFeatureStateData(this.pendingFeatureTable, options);
        this.pendingFeatureTable = undefined;
        this.pendingSelectionVector = undefined;
        this.pendingCanonical = undefined;
    }

    private collectPatternDependencies(featureTable: FeatureTable, selectionVector: SelectionVector, options: PopulateParameters): void {
        for (let i = 0; i < selectionVector.limit; i++) {
            const featureIndex = Number(selectionVector.getIndex(i));
            addPatternDependencies('fill-extrusion', this.layers, this.createFeature(featureTable, featureIndex, false), {zoom: this.zoom}, options);
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike | undefined, imagePositions: {[_: string]: ImagePosition}, _dashPositions?: Record<string, DashEntry>): void {
        if (!this.stateDependentLayers.length) return;
        const featureTable = (vtLayer as any)?.featureTable as FeatureTable | undefined;
        const featureProvider = featureTable
            ? (index: number) => this.createFeature(featureTable, index, false)
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
        return this.layoutVertexArray.length === 0 && this.centroidVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context): void {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.centroidVertexBuffer = context.createVertexBuffer(this.centroidVertexArray, centroidAttributes.members, true);
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
        this.centroidVertexBuffer.destroy();
    }

    private populateSelectedFeatures(
        featureTable: FeatureTable,
        selectionVector: SelectionVector,
        options: PopulateParameters,
        canonical: CanonicalTileID,
        imagePositions: {[_: string]: ImagePosition}
    ) {
        const needGeometry = this.layers[0]._featureFilter.needGeometry;
        const columnarPaintArrays = !this.hasDependencies &&
            this.programConfigurations.canPopulateColumnarPaintArrays(this.getPaintPropertyColumn);

        for (let i = 0; i < selectionVector.limit; i++) {
            const featureIndex = Number(selectionVector.getIndex(i));
            const featureBBoxes: FeatureIndexBBox[] = [];
            const feature = columnarPaintArrays
                ? this.createMinimalFeature(featureTable, featureIndex)
                : this.createFeature(featureTable, featureIndex, needGeometry, options);

            this.forEachPolygon(featureTable, featureIndex, (polygon) => {
                const oldVertexCount = this.layoutVertexArray.length;
                this.processPolygon(canonical, feature.type, polygon, options);

                const addedVertices = this.layoutVertexArray.length - oldVertexCount;
                if (addedVertices === 0 || polygon.centroidSampleCount === 0) {
                    return;
                }
                const bbox = bboxFromFlattened(polygon.flattened);
                if (bbox) {
                    featureBBoxes.push(bbox);
                }

                const centroidX = Math.floor(polygon.centroidX / polygon.centroidSampleCount);
                const centroidY = Math.floor(polygon.centroidY / polygon.centroidSampleCount);

                for (let vertex = 0; vertex < addedVertices; vertex++) {
                    this.centroidVertexArray.emplaceBack(centroidX, centroidY);
                }
            });

            if (featureBBoxes.length === 1) {
                this.featureIndexBBoxes[featureIndex] = featureBBoxes[0];
            } else if (featureBBoxes.length > 1) {
                this.featureIndexBBoxes[featureIndex] = featureBBoxes;
            }

            if (columnarPaintArrays) {
                this.programConfigurations.populateColumnarPaintArrays(this.layoutVertexArray.length, featureIndex, feature.id, this.getPaintPropertyColumn);
            } else {
                this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, featureIndex, {imagePositions, canonical});
            }
        }
    }

    private createFeature(featureTable: FeatureTable, featureIndex: number, includeGeometry: boolean, options?: PopulateParameters): BucketFeature {
        const properties: Record<string, unknown> = {};
        for (const propertyColumn of featureTable.propertyVectors ?? []) {
            if (!propertyColumn) continue;
            const value = propertyColumn.getValue(featureIndex);
            if (value != null) {
                properties[propertyColumn.name] = normalizeColumnarValue(value);
            }
        }

        const feature: BucketFeature = {
            id: this.featureId(featureTable, featureIndex),
            sourceLayerIndex: 0,
            index: featureIndex,
            geometry: includeGeometry ? [] : [],
            properties,
            type: 3,
            patterns: {}
        };

        if (this.hasDependencies && options) {
            addPatternDependencies('fill-extrusion', this.layers, feature, {zoom: this.zoom}, options);
        }

        return feature;
    }

    private createMinimalFeature(featureTable: FeatureTable, featureIndex: number): BucketFeature {
        return {
            id: this.featureId(featureTable, featureIndex),
            sourceLayerIndex: 0,
            index: featureIndex,
            geometry: [],
            properties: {},
            type: 3,
            patterns: {}
        };
    }

    private featureId(featureTable: FeatureTable, featureIndex: number): number | string {
        return featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(featureIndex), featureIndex) : featureIndex;
    }

    private forEachPolygon(featureTable: FeatureTable, featureIndex: number, callback: (polygon: FlattenedPolygon) => void) {
        const scale = EXTENT / featureTable.extent;

        forEachFeaturePolygonGeometry(featureTable, featureIndex, (_selectedFeatureIndex, _polygonIndex, firstPartOffset, secondPartOffset, topologyVector) => {
            const polygon: FlattenedPolygon = {
                flattened: [],
                holeIndices: [],
                ringRanges: [],
                centroidX: 0,
                centroidY: 0,
                centroidSampleCount: 0,
            };

            forEachPolygonRing(featureTable, topologyVector, firstPartOffset, secondPartOffset, (ringIndex, firstRingOffset, secondRingOffset) => {
                if (firstRingOffset === undefined || secondRingOffset === undefined || firstRingOffset >= secondRingOffset) {
                    return;
                }

                const ringStart = polygon.flattened.length;
                forEachVertexInRange(featureTable, firstRingOffset, secondRingOffset, (x, y) => {
                    const scaledX = x * scale;
                    const scaledY = y * scale;
                    polygon.flattened.push(scaledX, scaledY);
                });

                if (polygon.flattened.length - ringStart < 4) {
                    polygon.flattened.length = ringStart;
                    return;
                }

                const firstX = polygon.flattened[ringStart];
                const firstY = polygon.flattened[ringStart + 1];
                let ringEnd = polygon.flattened.length;
                const lastOffset = ringEnd - 2;
                if (polygon.flattened[lastOffset] !== firstX || polygon.flattened[lastOffset + 1] !== firstY) {
                    polygon.flattened.push(firstX, firstY);
                    ringEnd = polygon.flattened.length;
                }

                if (ringIndex > firstPartOffset) {
                    polygon.holeIndices.push(ringStart / 2);
                }

                for (let offset = ringStart; offset < ringEnd; offset += 2) {
                    const x = polygon.flattened[offset];
                    const y = polygon.flattened[offset + 1];
                    if (offset === ringEnd - 2 && x === firstX && y === firstY) {
                        continue;
                    }

                    polygon.centroidX += x;
                    polygon.centroidY += y;
                    polygon.centroidSampleCount++;
                }

                polygon.ringRanges.push({start: ringStart, end: ringEnd});
            });

            if (polygon.ringRanges.length > 0) {
                callback(polygon);
            }
        });
    }

    private processPolygon(
        canonical: CanonicalTileID,
        featureType: number,
        polygon: FlattenedPolygon,
        options: PopulateParameters
    ): void {
        if (polygon.ringRanges.length < 1 || isEntirelyOutside(polygon.flattened, polygon.ringRanges[0].start, polygon.ringRanges[0].end)) {
            return;
        }

        const segmentReference = {
            segment: this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray)
        };
        const granularity = options.subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z);
        const isPolygon = VectorTileFeature.types[featureType] === 'Polygon';

        for (const ringRange of polygon.ringRanges) {
            if (isEntirelyOutside(polygon.flattened, ringRange.start, ringRange.end)) {
                continue;
            }

            if (granularity < 2 && isPolygon) {
                this.generateSideFacesFromRange(polygon.flattened, ringRange.start, ringRange.end, segmentReference);
            } else {
                const subdividedRing = subdivideFlattenedVertexLine(
                    polygon.flattened.slice(ringRange.start, ringRange.end),
                    granularity,
                    isPolygon,
                );
                this.generateSideFaces(subdividedRing, segmentReference);
            }
        }

        if (!isPolygon) {
            return;
        }

        const subdividedPolygon = subdivideFlattenedPolygon(
            polygon.flattened,
            polygon.holeIndices,
            [],
            canonical,
            granularity,
        );
        const vertexArray = this.layoutVertexArray;

        fillLargeMeshArrays(
            (x, y) => {
                addVertex(vertexArray, x, y, 0, 0, 1, 1, 0);
            },
            this.segments,
            this.layoutVertexArray,
            this.indexArray,
            subdividedPolygon.verticesFlattened,
            subdividedPolygon.indicesTriangles
        );
    }

    private generateSideFaces(geometry: number[], segmentReference: {segment: Segment}) {
        let edgeDistance = 0;

        for (let offset = 2; offset < geometry.length; offset += 2) {
            const p1x = geometry[offset];
            const p1y = geometry[offset + 1];
            const p2x = geometry[offset - 2];
            const p2y = geometry[offset - 1];

            if (isBoundaryEdge(p1x, p1y, p2x, p2y)) {
                continue;
            }

            if (segmentReference.segment.vertexLength + 4 > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
                segmentReference.segment = this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray);
            }

            const dx = p1x - p2x;
            const dy = p1y - p2y;
            const dist = Math.hypot(dx, dy);
            if (dist === 0) {
                continue;
            }

            const perpX = -dy / dist;
            const perpY = dx / dist;
            const encodedNormalX = Math.floor(perpX * FACTOR) * 2;
            const encodedNormalY = perpY * FACTOR * 2;
            if (edgeDistance + dist > 32768) edgeDistance = 0;

            const roundedStartDistance = Math.round(edgeDistance);
            this.layoutVertexArray.emplaceBack(p1x, p1y, encodedNormalX, encodedNormalY, 0, roundedStartDistance);
            this.layoutVertexArray.emplaceBack(p1x, p1y, encodedNormalX + 1, encodedNormalY, 0, roundedStartDistance);

            edgeDistance += dist;

            const roundedEndDistance = Math.round(edgeDistance);
            this.layoutVertexArray.emplaceBack(p2x, p2y, encodedNormalX, encodedNormalY, 0, roundedEndDistance);
            this.layoutVertexArray.emplaceBack(p2x, p2y, encodedNormalX + 1, encodedNormalY, 0, roundedEndDistance);

            const bottomRight = segmentReference.segment.vertexLength;
            this.indexArray.emplaceBack(bottomRight, bottomRight + 2, bottomRight + 1);
            this.indexArray.emplaceBack(bottomRight + 1, bottomRight + 2, bottomRight + 3);

            segmentReference.segment.vertexLength += 4;
            segmentReference.segment.primitiveLength += 2;
        }
    }

    private generateSideFacesFromRange(geometry: number[], start: number, end: number, segmentReference: {segment: Segment}) {
        let edgeDistance = 0;

        for (let offset = start + 2; offset < end; offset += 2) {
            const p1x = geometry[offset];
            const p1y = geometry[offset + 1];
            const p2x = geometry[offset - 2];
            const p2y = geometry[offset - 1];

            if (isBoundaryEdge(p1x, p1y, p2x, p2y)) {
                continue;
            }

            if (segmentReference.segment.vertexLength + 4 > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
                segmentReference.segment = this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray);
            }

            const dx = p1x - p2x;
            const dy = p1y - p2y;
            const dist = Math.hypot(dx, dy);
            if (dist === 0) {
                continue;
            }

            const perpX = -dy / dist;
            const perpY = dx / dist;
            const encodedNormalX = Math.floor(perpX * FACTOR) * 2;
            const encodedNormalY = perpY * FACTOR * 2;
            if (edgeDistance + dist > 32768) edgeDistance = 0;

            const roundedStartDistance = Math.round(edgeDistance);
            this.layoutVertexArray.emplaceBack(p1x, p1y, encodedNormalX, encodedNormalY, 0, roundedStartDistance);
            this.layoutVertexArray.emplaceBack(p1x, p1y, encodedNormalX + 1, encodedNormalY, 0, roundedStartDistance);

            edgeDistance += dist;
            const roundedEndDistance = Math.round(edgeDistance);

            this.layoutVertexArray.emplaceBack(p2x, p2y, encodedNormalX, encodedNormalY, 0, roundedEndDistance);
            this.layoutVertexArray.emplaceBack(p2x, p2y, encodedNormalX + 1, encodedNormalY, 0, roundedEndDistance);

            const bottomRight = segmentReference.segment.vertexLength;
            this.indexArray.emplaceBack(bottomRight, bottomRight + 2, bottomRight + 1);
            this.indexArray.emplaceBack(bottomRight + 1, bottomRight + 2, bottomRight + 3);

            segmentReference.segment.vertexLength += 4;
            segmentReference.segment.primitiveLength += 2;
        }
    }
}

function isBoundaryEdge(p1x: number, p1y: number, p2x: number, p2y: number): boolean {
    return (p1x === p2x && (p1x < 0 || p1x > EXTENT)) ||
        (p1y === p2y && (p1y < 0 || p1y > EXTENT));
}

function isEntirelyOutside(ring: number[], start: number = 0, end: number = ring.length): boolean {
    let allLeft = true;
    let allRight = true;
    let allAbove = true;
    let allBelow = true;

    for (let offset = start; offset < end; offset += 2) {
        const x = ring[offset];
        const y = ring[offset + 1];
        allLeft &&= x < 0;
        allRight &&= x > EXTENT;
        allAbove &&= y < 0;
        allBelow &&= y > EXTENT;
    }

    return allLeft || allRight || allAbove || allBelow;
}

register('ColumnarFillExtrusionBucket', ColumnarFillExtrusionBucket, {omit: [
    'layers',
    'pendingFeatureTable',
    'pendingSelectionVector',
    'pendingCanonical',
    '_propertyColumnByName',
    'getPaintPropertyColumn',
    'featureIndexSelectionVector',
    'featureIndexBBoxes'
]} as any);
