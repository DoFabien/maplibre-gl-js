import {CircleLayoutArray} from '../../array_types.g';
import {members as layoutAttributes} from '../circle_attributes';
import {SegmentVector} from '../../segment';
import {ProgramConfigurationSet, type ColumnarPaintColumnProvider} from '../../program_configuration';
import {TriangleIndexArray} from '../../array_types.g.ts';
import {EXTENT} from '../../extent';
import {register} from '../../../util/web_worker_transfer';
import {clamp, warnOnce} from '../../../util/util';
import {createSelectionVector, type FeatureTable, type SelectionVector} from '@maplibre/mlt';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {forEachFeatureVertex} from './geometry_traversal';
import {getColumnarPropertyColumns, getSimpleGetPropertyName, normalizeColumnarValue, type ColumnarPropertyColumn} from './feature_properties';
import {ColumnarEvaluationFeature, getColumnarEvaluationFeature} from './evaluation_feature';
import {normalizeMltFeatureId} from '../../../util/mlt_feature_id';
import {sortSelectionVectorByKey} from './selection_sort';

import type {CircleGranularity} from '../../../render/subdivision_granularity_settings';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    PopulateParameters
} from '../../bucket';
import type {CircleStyleLayer} from '../../../style/style_layer/circle_style_layer';
import type {HeatmapStyleLayer} from '../../../style/style_layer/heatmap_style_layer.ts';
import type {Context} from '../../../webgl/context.ts';
import type {IndexBuffer} from '../../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../../webgl/vertex_buffer.ts';
import type {FeatureStates} from '../../../source/source_state';
import type {ImagePosition} from '../../../render/image_atlas';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';
import type {DashEntry} from '../../../render/line_atlas';
import type Point from '@mapbox/point-geometry';
import type {FeatureIndexBBox} from '../../feature_index';
import type {BucketDependencyParameters} from '../../bucket.ts';

const VERTEX_MIN_VALUE = -32768;
const BITS = 15;
const MAX = Math.pow(2, BITS - 1) - 1;
const MIN = -MAX - 1;
const EXTRUDES_BY_GRANULARITY = {
    1: [0, 7],
    3: [0, 2, 5, 7],
    5: [0, 1, 3, 4, 6, 7],
    7: [0, 1, 2, 3, 4, 5, 6, 7],
} as const;

function addCircleVertex(layoutVertexArray, x, y, extrudeX, extrudeY): void {
    layoutVertexArray.emplaceBack(
        VERTEX_MIN_VALUE + (x * 8) + extrudeX,
        VERTEX_MIN_VALUE + (y * 8) + extrudeY
    );
}

/** Shared columnar point mesh for circles and heatmaps, including globe subdivision. */
export class ColumnarCircleBucket<Layer extends CircleStyleLayer | HeatmapStyleLayer = CircleStyleLayer> implements Bucket<FeatureTable> {
    readonly isColumnar = true;

    index: number;
    zoom: number;
    overscaling: number;
    layerIds: string[];
    layers: Layer[];
    stateDependentLayers: Layer[];
    stateDependentLayerIds: string[];

    layoutVertexArray: CircleLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    hasDependencies: boolean;
    programConfigurations: ProgramConfigurationSet<Layer>;
    segments: SegmentVector;
    uploaded: boolean;
    private _neededProperties: Set<string> | null;
    private _propertyColumnByName: Map<string, ColumnarPropertyColumn>;
    private getPaintPropertyColumn: ColumnarPaintColumnProvider;
    private _evaluationFeature?: ColumnarEvaluationFeature;
    featureIndexSelectionVector?: SelectionVector;
    featureIndexBBoxes?: Array<FeatureIndexBBox[] | FeatureIndexBBox>;

    constructor(options: BucketParameters<Layer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map((layer) => layer.id);
        this.index = options.index;
        this.hasDependencies = false;

        this.layoutVertexArray = new CircleLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.segments = new SegmentVector();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
        this._neededProperties = null;
        this._propertyColumnByName = new Map();
        this.getPaintPropertyColumn = (propertyName: string) => this._propertyColumnByName.get(propertyName);
    }

    populate(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        const styleLayer = this.layers[0];
        const filterSpecification = styleLayer.filter as any;
        const selectionVector = filterSpecification ? filter(featureTable, filterSpecification, styleLayer.getGlobalState(), canonical, new EvaluationParameters(this.zoom)) : createSelectionVector(featureTable.numFeatures);
        const featureIndexBBoxes = this.featureIndexBBoxes = [];
        if (selectionVector.limit === 0) {
            this.featureIndexSelectionVector = selectionVector;
            this.prepareFeatureStateData(featureTable, options);
            return;
        }

        const circleStyle = styleLayer.type === 'circle' ? styleLayer as CircleStyleLayer : undefined;
        const circleSortKey = circleStyle?.layout.get('circle-sort-key');
        const sortFeaturesByKey = !!circleSortKey && !circleSortKey.isConstant();
        const sortKeyPropertyName = sortFeaturesByKey
            ? getSimpleGetPropertyName(styleLayer.serialize().layout?.['circle-sort-key'])
            : null;
        const sortKeyPropertyVector = sortKeyPropertyName ? featureTable.getPropertyVector(sortKeyPropertyName) : null;
        if (sortFeaturesByKey) {
            if (sortKeyPropertyName) {
                this.sortSelectionVector(selectionVector, featureTable, sortKeyPropertyName);
            }
        }
        this.featureIndexSelectionVector = selectionVector;

        const subdivide = styleLayer.type === 'heatmap' || circleStyle?.paint.get('circle-pitch-alignment') === 'map';
        const granularity = subdivide ? options.subdivisionGranularity.circle : 1;
        const extrudes = EXTRUDES_BY_GRANULARITY[granularity];
        if (!extrudes) {
            throw new Error(`Invalid circle bucket granularity: ${granularity}; valid values are 1, 3, 5, 7.`);
        }
        const scale = EXTENT / featureTable.extent;
        this._neededProperties = this.programConfigurations.getFeaturePropertyDependencies();
        this._propertyColumnByName.clear();
        for (const propertyColumn of getColumnarPropertyColumns(featureTable, this._neededProperties)) {
            this._propertyColumnByName.set(propertyColumn.name, propertyColumn);
        }
        const columnarPaintArrays = this.programConfigurations.canPopulateColumnarPaintArrays(this.getPaintPropertyColumn);
        this._evaluationFeature = new ColumnarEvaluationFeature(featureTable, this._neededProperties);

        for (let i = 0; i < selectionVector.limit; i++) {
            const featureIndex = Number(selectionVector.getIndex(i));
            const hasDirectSortKey = !!sortKeyPropertyVector;
            const directSortKey = sortKeyPropertyVector
                ? normalizeColumnarValue(sortKeyPropertyVector.getValue(featureIndex))
                : undefined;
            const feature = columnarPaintArrays && (!sortFeaturesByKey || sortKeyPropertyVector)
                ? {sortKey: hasDirectSortKey ? directSortKey : undefined} as BucketFeature
                : this.createFeature(featureTable, featureIndex, sortFeaturesByKey && !sortKeyPropertyVector ? circleSortKey : null, canonical, directSortKey, hasDirectSortKey);
            let hasGeometry = false;
            let featureBBox: FeatureIndexBBox | undefined;
            let featureBBoxes: FeatureIndexBBox[] | undefined;
            forEachFeatureVertex(featureTable, featureIndex, (x, y) => {
                hasGeometry = true;
                const scaledX = x * scale;
                const scaledY = y * scale;
                const bbox: FeatureIndexBBox = [scaledX, scaledY, scaledX, scaledY];
                if (featureBBox) {
                    (featureBBoxes ??= [featureBBox]).push(bbox);
                } else {
                    featureBBox = bbox;
                }
                this.addPoint(feature, x, y, extrudes, scale);
            });

            if (hasGeometry) {
                featureIndexBBoxes[featureIndex] = featureBBoxes ?? featureBBox;
                if (columnarPaintArrays) {
                    this.programConfigurations.populateColumnarPaintArrays(this.layoutVertexArray.length, featureIndex, this.featureId(featureTable, featureIndex), this.getPaintPropertyColumn);
                } else {
                    this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, featureIndex, {imagePositions: {}, canonical});
                }
            }
        }
        this.prepareFeatureStateData(featureTable, options);
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike | undefined, imagePositions: {[_: string]: ImagePosition}, _dashPositions?: Record<string, DashEntry>): void {
        if (!this.stateDependentLayers.length) return;
        const featureTable = (vtLayer as any)?.featureTable as FeatureTable | undefined;
        const featureProvider = featureTable
            ? (index: number) => getColumnarEvaluationFeature(featureTable, index)
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

    addFeatures(_parameters: BucketDependencyParameters): void {}

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

    addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, granularity: CircleGranularity = 1, scale = 1): void {
        const extrudes = EXTRUDES_BY_GRANULARITY[granularity];
        if (!extrudes) {
            throw new Error(`Invalid circle bucket granularity: ${granularity}; valid values are 1, 3, 5, 7.`);
        }
        for (const ring of geometry) {
            for (const point of ring) {
                this.addPoint(feature, point.x, point.y, extrudes, scale);
            }
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions: {}, canonical});
    }

    private addPoint(feature: BucketFeature, pointX: number, pointY: number, extrudes: readonly number[], scale: number): void {
        const verticesPerAxis = extrudes.length;

        const x = Math.round(pointX * scale);
        const y = Math.round(pointY * scale);
        const vx = clamp(x, MIN, MAX);
        const vy = clamp(y, MIN, MAX);

        if (x < vx || x > vx + 1 || y < vy || y > vy + 1) {
            warnOnce('Geometry exceeds allowed extent, reduce your vector tile buffer size');
        }

        if (vx < 0 || vx >= EXTENT || vy < 0 || vy >= EXTENT) {
            return;
        }

        const segment = this.segments.prepareSegment(verticesPerAxis * verticesPerAxis, this.layoutVertexArray, this.indexArray, feature.sortKey);
        const segmentIndex = segment.vertexLength;

        for (let y = 0; y < verticesPerAxis; y++) {
            for (let x = 0; x < verticesPerAxis; x++) {
                addCircleVertex(this.layoutVertexArray, vx, vy, extrudes[x], extrudes[y]);
            }
        }

        for (let y = 0; y < verticesPerAxis - 1; y++) {
            for (let x = 0; x < verticesPerAxis - 1; x++) {
                const lowerIndex = segmentIndex + y * verticesPerAxis + x;
                const upperIndex = segmentIndex + (y + 1) * verticesPerAxis + x;
                this.indexArray.emplaceBack(lowerIndex, upperIndex + 1, lowerIndex + 1);
                this.indexArray.emplaceBack(lowerIndex, upperIndex, upperIndex + 1);
            }
        }

        segment.vertexLength += verticesPerAxis * verticesPerAxis;
        segment.primitiveLength += (verticesPerAxis - 1) * (verticesPerAxis - 1) * 2;
    }

    private createFeature(featureTable: FeatureTable, featureIndex: number, circleSortKey: any, canonical: CanonicalTileID, directSortKey?: unknown, hasDirectSortKey = false): BucketFeature {
        const feature = this._evaluationFeature.setIndex(featureIndex) as unknown as BucketFeature;
        feature.sortKey = hasDirectSortKey ? directSortKey : (circleSortKey ? circleSortKey.evaluate(feature as any, {}, canonical) : undefined);
        return feature;
    }

    private featureId(featureTable: FeatureTable, featureIndex: number): number | string {
        return featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(featureIndex), featureIndex) : featureIndex;
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
}

register('ColumnarCircleBucket', ColumnarCircleBucket, {omit: [
    'layers',
    '_neededProperties',
    '_propertyColumnByName',
    'getPaintPropertyColumn',
    '_evaluationFeature',
    'featureIndexSelectionVector',
    'featureIndexBBoxes'
]} as any);
