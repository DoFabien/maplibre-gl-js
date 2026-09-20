import {LineLayoutArray, LineExtLayoutArray} from '../../array_types.g';
import {members as layoutAttributes} from '../line_attributes';
import {members as layoutAttributesExt} from '../line_attributes_ext';
import {SegmentVector} from '../../segment';
import {ProgramConfigurationSet, type ColumnarPaintColumnProvider} from '../../program_configuration';
import {TriangleIndexArray} from '../../array_types.g';
import {EXTENT} from '../../extent';
import {register} from '../../../util/web_worker_transfer';
import {addPatternDependencies, hasPattern} from '../pattern_bucket_features';
import {recordParseProfile} from '../../bucket';
import {clamp} from '../../../util/util';
import {createSelectionVector, GEOMETRY_TYPE, type FeatureTable, type IGeometryVector, type IGpuVector, type SelectionVector} from '@maplibre/mlt';
import VectorUtils from './vectorUtils';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {LineGeometryBase} from '../line_geometry_base';
import {lineClipPropertyNames} from '../line_clip_properties';
import {normalizeMltFeatureId} from '../../../util/mlt_feature_id';
import {sortSelectionVectorByKey} from './selection_sort';
import {
    EXTRUDE_SCALE,
    LINE_DISTANCE_SCALE,
    MAX_LINE_DISTANCE,
} from '../line_geometry_constants';
import {getColumnarPropertyColumns, getSimpleGetPropertyName, normalizeColumnarValue, type ColumnarPropertyColumn} from './feature_properties';
import {getColumnarEvaluationFeature} from './evaluation_feature';
import {forEachFeatureGeometryPart} from './geometry_traversal';
import {subdivideFlattenedVertexLine} from '../../../render/subdivision';

import type {ImagePosition} from '../../../render/image_atlas';
import type {FeatureIndexBBox} from '../../feature_index';
import type {DashEntry} from '../../../render/line_atlas';
import type {VectorTileLayer} from '@mapbox/vector-tile';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {FeatureStates} from '../../../source/source_state';
import type {VertexBuffer} from '../../../webgl/vertex_buffer.ts';
import type {IndexBuffer} from '../../../webgl/index_buffer.ts';
import type {Texture} from '../../../webgl/texture.ts';
import type {RGBAImage} from '../../../util/image';
import type {Context} from '../../../webgl/context.ts';
import type {Segment} from '../../segment';
import type {LineStyleLayer} from '../../../style/style_layer/line_style_layer';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    PopulateParameters
} from '../../bucket';
import type {BucketDependencyParameters} from '../../bucket.ts';

const BITS = 15;
const MAX_COORD = Math.pow(2, BITS - 1) - 1;
const MIN_COORD = -MAX_COORD - 1;

type GradientTexture = {
    texture?: Texture;
    gradient?: RGBAImage;
    version?: number;
};

type LineClips = {
    start: number;
    end: number;
};

type LinePopulateProfileAccumulator = {
    featureSetupDuration: number;
    featureBuildDuration: number;
    layoutEvalDuration: number;
    clipDuration: number;
    geometryDuration: number;
    coordinateDuration: number;
    tessellateDuration: number;
    paintArraysDuration: number;
};

/**
 * @internal
 * Line bucket class
 */
export class ColumnarLineBucket extends LineGeometryBase implements Bucket<FeatureTable> {
    // Temporary MLT bridge: remove isColumnar once MLT has its own worker pipeline separate from MVT.
    // Used by worker_tile to route FeatureTable to columnar buckets while the two pipelines are shared.
    readonly isColumnar = true;

    index: number;
    zoom: number;
    overscaling: number;
    layers: LineStyleLayer[];
    layerIds: string[];
    gradients: {[x: string]: GradientTexture};
    lineClips?: LineClips;
    lineClipsArray: LineClips[];
    maxLineLength: number;
    stateDependentLayers: any[];
    stateDependentLayerIds: string[];
    patternFeatures: BucketFeature[];

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

    /** Feature property names referenced by data-driven paint expressions for the current populate call. null = extract all. */
    private _neededProperties: Set<string> | null = null;
    private _propertyColumns: ColumnarPropertyColumn[] = [];
    private _propertyColumnByName: Map<string, ColumnarPropertyColumn>;
    private hasDasharrayDependencies = false;
    private pendingFeatureTable?: FeatureTable;
    private pendingSelectionVector?: SelectionVector;
    private pendingCanonical?: CanonicalTileID;
    private _lineCoordinateScratch: number[];
    /** Canonical tile subdivision also applies to geometry deferred for patterns or dashes. */
    private lineSubdivisionGranularity = 1;
    private _linePopulateProfileAccumulator?: LinePopulateProfileAccumulator;
    private _paintFeatureScratch: {type: string; id: number; properties: Record<string, unknown>};
    private getPaintPropertyColumn: ColumnarPaintColumnProvider;
    featureIndexSelectionVector?: SelectionVector;
    featureIndexBBoxes?: Array<FeatureIndexBBox[] | FeatureIndexBBox>;

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
        this.maxLineLength = 0;
        this.gradients = {};
        for (const layer of this.layers) {
            this.gradients[layer.id] = {};
        }

        this.layoutVertexArray = new LineLayoutArray();
        this.layoutVertexArray2 = new LineExtLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this._lineCoordinateScratch = [];
        this._paintFeatureScratch = {type: 'LineString', id: 0, properties: {}};
        this._propertyColumnByName = new Map();
        this.getPaintPropertyColumn = (propertyName: string) => this._propertyColumnByName.get(propertyName);

        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    populate(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        this.populateLine(featureTable, options, canonical);
    }

    update(states: FeatureStates, vtLayer: VectorTileLayer | undefined, imagePositions: {[_: string]: ImagePosition}, dashPositions?: Record<string, DashEntry>): void {
        this.updateColumnar(states, vtLayer, imagePositions, dashPositions);
    }

    /** Layout, dependency and state expressions read the current row through a shared columnar view. */
    private buildReusablePaintFeature(featureTable: FeatureTable, featureIndex: number): {type: string; id: number; properties: Record<string, unknown>} {
        this._paintFeatureScratch.id = featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(featureIndex), featureIndex) : featureIndex;
        this._paintFeatureScratch.properties = getColumnarEvaluationFeature(featureTable, featureIndex).properties;
        return this._paintFeatureScratch;
    }

    private buildDependencyFeature(featureTable: FeatureTable, featureIndex: number): {type: string; id: number; properties: Record<string, unknown>; patterns: Record<string, {min: string; mid: string; max: string}>; dashes: Record<string, {min: string; mid: string; max: string}>; geometry: []; index: number; sourceLayerIndex: number} {
        return {
            ...this.buildReusablePaintFeature(featureTable, featureIndex),
            patterns: {},
            dashes: {},
            geometry: [],
            index: featureIndex,
            sourceLayerIndex: 0
        };
    }

    private lineFeatureClips(featureTable: FeatureTable, featureIndex: number): LineClips | undefined {
        const {startVector, endVector} = this.lineClipVectors(featureTable);
        return this.lineFeatureClipsFromVectors(startVector, endVector, featureIndex);
    }

    /** Resolves a complete pair so metrics from different naming conventions are never mixed. */
    private lineClipVectors(featureTable: FeatureTable): {startVector?: ColumnarPropertyColumn; endVector?: ColumnarPropertyColumn} {
        for (const [startKey, endKey] of lineClipPropertyNames) {
            const startVector = featureTable.getPropertyVector(startKey);
            const endVector = featureTable.getPropertyVector(endKey);
            if (startVector && endVector) return {startVector, endVector};
        }
        return {};
    }

    private lineFeatureClipsFromVectors(startVector: {getValue: (index: number) => unknown} | undefined, endVector: {getValue: (index: number) => unknown} | undefined, featureIndex: number): LineClips | undefined {
        if (!startVector || !endVector) {
            return undefined;
        }

        const start = startVector.getValue(featureIndex);
        const end = endVector.getValue(featureIndex);

        if (start == null || end == null) {
            return undefined;
        }

        return {start: Number(start), end: Number(end)};
    }

    private paintIsDataDriven(): boolean {
        // Data-driven binders (SourceExpressionBinder, CompositeExpressionBinder, CrossFadedBinder)
        // all carry an `expression` field; ConstantBinder does not.
        return Object.values(this.programConfigurations.programConfigurations)
            .some(cfg => Object.values(cfg.binders).some(b => 'expression' in b));
    }

    populateLine(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        this.lineSubdivisionGranularity = canonical ? options.subdivisionGranularity.line.getGranularityForZoomLevel(canonical.z) : 1;
        const serializedPaint = this.layers[0].serialize().paint ?? {};
        this.hasDasharrayDependencies = this.hasLineDasharray(this.layers);
        this.hasDependencies = hasPattern('line', this.layers, options) || this.hasDasharrayDependencies;
        const filterSpecification = this.layers[0].filter as any;
        const layer = this.layers[0];
        const profile = options.profile;
        const recordProfile = profile ? (phase: string, start: number, featureCount = featureTable.numFeatures, detail?: string, kind: 'exclusive' | 'aggregate' = 'exclusive') => {
            recordParseProfile(options.profile, {
                phase,
                duration: performance.now() - start,
                kind,
                encoding: 'mlt',
                layerId: layer.id,
                layerType: layer.type,
                featureCount,
                detail
            });
        } : undefined;
        let selectionVector: SelectionVector;
        const filterStart = profile ? performance.now() : 0;
        if (!filterSpecification) {
            selectionVector = createSelectionVector(featureTable.numFeatures);
        } else {
            selectionVector = filter(featureTable, filterSpecification, layer.getGlobalState(), canonical, new EvaluationParameters(this.zoom));
        }
        recordProfile?.('line.filter', filterStart, selectionVector.limit);

        if (selectionVector.limit === 0) {
            this.featureIndexSelectionVector = selectionVector;
            this.prepareFeatureStateData(featureTable, options);
            return;
        }

        const lineSortKey = this.layers[0].layout.get('line-sort-key');
        const shouldSort = !lineSortKey.isConstant();

        if (shouldSort) {
            const sortStart = profile ? performance.now() : 0;
            this.sortSelectionVector(selectionVector, featureTable, lineSortKey, canonical, this.layers[0].serialize().layout?.['line-sort-key']);
            recordProfile?.('line.sort', sortStart, selectionVector.limit);
        }
        this.featureIndexSelectionVector = selectionVector;

        const layout = this.layers[0].layout;
        const lineJoin = layout.get('line-join');
        const cap = layout.get('line-cap');
        const miterLimit = layout.get('line-miter-limit');
        const roundLimit = layout.get('line-round-limit');

        const paintDataDriven = this.paintIsDataDriven();
        const layoutDataDriven = !lineJoin.isConstant() || !cap.isConstant() || !miterLimit.isConstant() || !roundLimit.isConstant();
        this._neededProperties = paintDataDriven && !layoutDataDriven
            ? this.programConfigurations.getFeaturePropertyDependencies()
            : null;
        const propertyColumnsStart = profile ? performance.now() : 0;
        this._propertyColumns = getColumnarPropertyColumns(featureTable, this._neededProperties);
        this._propertyColumnByName.clear();
        for (const propertyColumn of this._propertyColumns) {
            this._propertyColumnByName.set(propertyColumn.name, propertyColumn);
        }
        recordProfile?.('line.propertyColumns', propertyColumnsStart, this._propertyColumns.length);

        if (this.hasDependencies && (serializedPaint['line-pattern'] !== undefined || this.hasDasharrayDependencies)) {
            const dependencyStart = profile ? performance.now() : 0;
            this.collectDeferredDependencies(featureTable, selectionVector, options);
            recordProfile?.('line.deferredDependencies', dependencyStart, selectionVector.limit);
            this.pendingFeatureTable = featureTable;
            this.pendingSelectionVector = selectionVector;
            this.pendingCanonical = canonical;
            return;
        }

        const geometryStart = profile ? performance.now() : 0;
        this.populateSelectedLineFeatures(featureTable, selectionVector, canonical, paintDataDriven, options.profile ? options : undefined, null, undefined);
        recordProfile?.('line.geometryAndPaint.total', geometryStart, selectionVector.limit, undefined, 'aggregate');
        this.prepareFeatureStateData(featureTable, options);
    }

    addFeatures({options, canonical, patternPositions: imagePositions, dashPositions}: BucketDependencyParameters): void {
        if (!this.pendingFeatureTable || !this.pendingSelectionVector) {
            return;
        }

        const addFeaturesStart = options.profile ? performance.now() : 0;
        const pendingSelectionVector = this.pendingSelectionVector;
        this.populateSelectedLineFeatures(this.pendingFeatureTable, pendingSelectionVector, this.pendingCanonical ?? canonical, this.paintIsDataDriven(), options, imagePositions, dashPositions);
        this.prepareFeatureStateData(this.pendingFeatureTable, options);
        if (options.profile) {
            recordParseProfile(options.profile, {
                phase: 'line.addFeaturesGeometryAndPaint',
                duration: performance.now() - addFeaturesStart,
                kind: 'aggregate',
                encoding: 'mlt',
                layerId: this.layers[0].id,
                layerType: this.layers[0].type,
                featureCount: pendingSelectionVector.limit
            });
        }
        this.pendingFeatureTable = undefined;
        this.pendingSelectionVector = undefined;
        this.pendingCanonical = undefined;
    }

    private populateSelectedLineFeatures(
        featureTable: FeatureTable,
        selectionVector: SelectionVector,
        canonical: CanonicalTileID,
        paintDataDriven: boolean,
        options?: PopulateParameters,
        imagePositions: {[_: string]: ImagePosition} | null = null,
        dashPositions?: {[_: string]: DashEntry}
    ) {
        const profile = options?.profile;
        const profileAccumulator: LinePopulateProfileAccumulator | undefined = profile ? {
            featureSetupDuration: 0,
            featureBuildDuration: 0,
            layoutEvalDuration: 0,
            clipDuration: 0,
            geometryDuration: 0,
            coordinateDuration: 0,
            tessellateDuration: 0,
            paintArraysDuration: 0
        } : undefined;
        const recordLineSubphase = (phase: string, duration: number, kind: 'exclusive' | 'aggregate' = 'exclusive') => {
            recordParseProfile(profile, {
                phase,
                duration,
                kind,
                encoding: 'mlt',
                layerId: this.layers[0].id,
                layerType: this.layers[0].type,
                featureCount: selectionVector.limit
            });
        };
        const geometryVector = featureTable.geometryVector as any;
        const layout = this.layers[0].layout;
        const lineJoin = layout.get('line-join');
        const cap = layout.get('line-cap');
        const miterLimit = layout.get('line-miter-limit');
        const roundLimit = layout.get('line-round-limit');
        const layoutDataDriven = !lineJoin.isConstant() || !cap.isConstant() || !miterLimit.isConstant() || !roundLimit.isConstant();
        const columnarPaintArrays = paintDataDriven &&
            !layoutDataDriven &&
            !this.hasDependencies &&
            this.programConfigurations.canPopulateColumnarPaintArrays(this.getPaintPropertyColumn);
        const args = [featureTable, selectionVector, lineJoin, cap, miterLimit, roundLimit, canonical, paintDataDriven, options, imagePositions, dashPositions, columnarPaintArrays] as const;
        this.featureIndexBBoxes = [];
        this._linePopulateProfileAccumulator = profileAccumulator;

        try {
            if (typeof geometryVector.geometryType === 'function' && geometryVector.topologyVector?.geometryOffsets && typeof geometryVector.containsSingleGeometryType === 'function' && geometryVector.containsSingleGeometryType()) {
                switch (geometryVector.geometryType(0)) {
                    case GEOMETRY_TYPE.LINESTRING:
                        if (profileAccumulator) {
                            this.addLineStrings(...args, profileAccumulator);
                        } else if (columnarPaintArrays) {
                            this.addLineStrings(...args);
                        } else {
                            this.addLineStrings(featureTable, selectionVector, lineJoin, cap, miterLimit, roundLimit, canonical, paintDataDriven, options, imagePositions, dashPositions);
                        }
                        break;
                    case GEOMETRY_TYPE.MULTILINESTRING:
                        if (profileAccumulator) {
                            this.addMultiLineStrings(...args, profileAccumulator);
                        } else if (columnarPaintArrays) {
                            this.addMultiLineStrings(...args);
                        } else {
                            this.addMultiLineStrings(featureTable, selectionVector, lineJoin, cap, miterLimit, roundLimit, canonical, paintDataDriven, options, imagePositions, dashPositions);
                        }
                        break;
                    default:
                        if (profileAccumulator) {
                            this.addGeometryParts(featureTable, selectionVector, canonical, paintDataDriven, options, imagePositions, dashPositions, profileAccumulator, columnarPaintArrays);
                        } else if (columnarPaintArrays) {
                            this.addGeometryParts(featureTable, selectionVector, canonical, paintDataDriven, options, imagePositions, dashPositions, undefined, columnarPaintArrays);
                        } else {
                            this.addGeometryParts(featureTable, selectionVector, canonical, paintDataDriven, options, imagePositions, dashPositions);
                        }
                        break;
                }
            } else {
                if (profileAccumulator) {
                    this.addGeometryParts(featureTable, selectionVector, canonical, paintDataDriven, options, imagePositions, dashPositions, profileAccumulator, columnarPaintArrays);
                } else if (columnarPaintArrays) {
                    this.addGeometryParts(featureTable, selectionVector, canonical, paintDataDriven, options, imagePositions, dashPositions, undefined, columnarPaintArrays);
                } else {
                    this.addGeometryParts(featureTable, selectionVector, canonical, paintDataDriven, options, imagePositions, dashPositions);
                }
            }
        } finally {
            this._linePopulateProfileAccumulator = undefined;
        }

        if (profileAccumulator) {
            const measuredFeatureSetupDuration = profileAccumulator.featureBuildDuration +
                profileAccumulator.layoutEvalDuration + profileAccumulator.clipDuration;
            const measuredGeometryDuration = profileAccumulator.coordinateDuration + profileAccumulator.tessellateDuration;

            recordLineSubphase('line.featureSetup.self', Math.max(0, profileAccumulator.featureSetupDuration - measuredFeatureSetupDuration));
            recordLineSubphase('line.featureSetup.total', profileAccumulator.featureSetupDuration, 'aggregate');
            recordLineSubphase('line.featureBuild', profileAccumulator.featureBuildDuration);
            recordLineSubphase('line.layoutEval', profileAccumulator.layoutEvalDuration);
            recordLineSubphase('line.clips', profileAccumulator.clipDuration);
            recordLineSubphase('line.geometry.self', Math.max(0, profileAccumulator.geometryDuration - measuredGeometryDuration));
            recordLineSubphase('line.geometry.total', profileAccumulator.geometryDuration, 'aggregate');
            recordLineSubphase('line.coordinates', profileAccumulator.coordinateDuration);
            recordLineSubphase('line.tessellate', profileAccumulator.tessellateDuration);
            recordLineSubphase('line.paintArrays', profileAccumulator.paintArraysDuration);
        }
    }

    private addGeometryParts(
        featureTable: FeatureTable,
        selectionVector: SelectionVector,
        canonical: CanonicalTileID,
        paintDataDriven: boolean,
        options?: PopulateParameters,
        imagePositions: {[_: string]: ImagePosition} | null = null,
        dashPositions?: {[_: string]: DashEntry},
        profileAccumulator?: LinePopulateProfileAccumulator,
        columnarPaintArrays = false
    ): void {
        const geometryVector = featureTable.geometryVector;
        const tileExtent = featureTable.extent;
        const layout = this.layers[0].layout;
        const lineJoin = layout.get('line-join');
        const cap = layout.get('line-cap');
        const miterLimit = layout.get('line-miter-limit');
        const roundLimit = layout.get('line-round-limit');
        const layoutDataDriven = !lineJoin.isConstant() || !cap.isConstant() || !miterLimit.isConstant() || !roundLimit.isConstant();
        const needsFeature = layoutDataDriven || (paintDataDriven && !columnarPaintArrays);
        const constantJoin = lineJoin.isConstant() ? lineJoin.evaluate({} as any, {}) : undefined;
        const constantCap = cap.isConstant() ? cap.evaluate({} as any, {}) : undefined;
        const constantMiterLimit = miterLimit.isConstant() ? miterLimit.evaluate({} as any, {}) : undefined;
        const constantRoundLimit = roundLimit.isConstant() ? roundLimit.evaluate({} as any, {}) : undefined;
        const {startVector: clipStartVector, endVector: clipEndVector} = this.lineClipVectors(featureTable);
        const hasClipVectors = !!clipStartVector && !!clipEndVector;
        if (!hasClipVectors) {
            this.lineClips = undefined;
        }
        const topologyVector = geometryVector.topologyVector;
        const geometryOffsets = topologyVector.geometryOffsets;
        const partOffsets = topologyVector.partOffsets;
        const ringOffsets = topologyVector.ringOffsets;
        const hasPolygonGeometry = 'containsPolygonGeometry' in geometryVector && typeof geometryVector.containsPolygonGeometry === 'function'
            ? geometryVector.containsPolygonGeometry()
            : !!(ringOffsets && ringOffsets.length > 0);
        const canUseDirectLineOffsets = partOffsets && !hasPolygonGeometry;

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            const featureBBoxes: FeatureIndexBBox[] = [];
            const featureSetupStart = profileAccumulator ? performance.now() : 0;
            const featureBuildStart = profileAccumulator ? performance.now() : 0;
            const feature = needsFeature
                ? this.buildReusablePaintFeature(featureTable, index)
                : undefined;
            if (profileAccumulator) {
                profileAccumulator.featureBuildDuration += performance.now() - featureBuildStart;
            }
            const layoutEvalStart = profileAccumulator ? performance.now() : 0;
            const join = constantJoin !== undefined ? constantJoin : lineJoin.evaluate(feature as any, {});
            const lineCap = constantCap !== undefined ? constantCap : cap.evaluate(feature as any, {});
            const lineMiterLimit = constantMiterLimit !== undefined ? constantMiterLimit : miterLimit.evaluate(feature as any, {});
            const lineRoundLimit = constantRoundLimit !== undefined ? constantRoundLimit : roundLimit.evaluate(feature as any, {});
            if (profileAccumulator) {
                profileAccumulator.layoutEvalDuration += performance.now() - layoutEvalStart;
            }
            const clipStart = profileAccumulator ? performance.now() : 0;
            if (hasClipVectors) {
                this.lineClips = this.lineFeatureClipsFromVectors(clipStartVector, clipEndVector, index);
            }
            if (profileAccumulator) {
                profileAccumulator.clipDuration += performance.now() - clipStart;
            }
            if (profileAccumulator) {
                profileAccumulator.featureSetupDuration += performance.now() - featureSetupStart;
            }

            const geometryStart = profileAccumulator ? performance.now() : 0;
            let handledDirectLineOffsets = false;

            if (canUseDirectLineOffsets) {
                const geometryType = geometryVector.geometryType(index);
                if (geometryType === GEOMETRY_TYPE.LINESTRING) {
                    const partOffset = geometryOffsets ? geometryOffsets[index] : index;
                    const start = partOffsets[partOffset];
                    const end = partOffsets[partOffset + 1];
                    const bbox = this.addSimpleLineFast(geometryVector, start, end, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent) ??
                        this.addLine(geometryVector, start, end, false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                    if (bbox) {
                        featureBBoxes.push(bbox);
                    }
                    handledDirectLineOffsets = true;
                } else if (geometryType === GEOMETRY_TYPE.MULTILINESTRING && geometryOffsets) {
                    const partOffsetStart = geometryOffsets[index];
                    const partOffsetEnd = geometryOffsets[index + 1];
                    for (let partOffset = partOffsetStart; partOffset < partOffsetEnd; partOffset++) {
                        const start = partOffsets[partOffset];
                        const end = partOffsets[partOffset + 1];
                        const bbox = this.addSimpleLineFast(geometryVector, start, end, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent) ??
                            this.addLine(geometryVector, start, end, false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                        if (bbox) {
                            featureBBoxes.push(bbox);
                        }
                    }
                    handledDirectLineOffsets = true;
                }
            }

            if (!handledDirectLineOffsets) {
                forEachFeatureGeometryPart(featureTable, index, (_partIndex, start, end, close) => {
                    const bbox = !close
                        ? (this.addSimpleLineFast(geometryVector, start, end, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent) ??
                            this.addLine(geometryVector, start, end, false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent))
                        : this.addLine(geometryVector, start, end, true, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                    if (bbox) {
                        featureBBoxes.push(bbox);
                    }
                });
            }
            this.featureIndexBBoxes[index] = featureBBoxes.length === 1 ? featureBBoxes[0] : featureBBoxes;
            if (profileAccumulator) {
                profileAccumulator.geometryDuration += performance.now() - geometryStart;
            }

            const paintStart = profileAccumulator ? performance.now() : 0;
            this.populateFeaturePaintArrays(featureTable, index, feature as any, canonical, options, imagePositions, dashPositions, columnarPaintArrays);
            if (profileAccumulator) {
                profileAccumulator.paintArraysDuration += performance.now() - paintStart;
            }
        }
    }

    addMixedGeometry(featureTable: FeatureTable, selectionVector: SelectionVector, lineJoin: any, cap: any,
        miterLimit: any, roundLimit: any, canonical: CanonicalTileID, paintDataDriven: boolean, options?: PopulateParameters, imagePositions: {[_: string]: ImagePosition} | null = null, dashPositions?: {[_: string]: DashEntry}): void {
        const geometryVector = featureTable.geometryVector;
        const topologyVector = geometryVector.topologyVector;
        const geometryOffsets = topologyVector.geometryOffsets;
        const partOffsets = topologyVector.partOffsets;
        const ringOffsets = topologyVector.ringOffsets;
        const tileExtent = featureTable.extent;

        const layoutDataDriven = !lineJoin.isConstant() || !cap.isConstant() || !miterLimit.isConstant() || !roundLimit.isConstant();
        const needsFeature = layoutDataDriven || paintDataDriven;

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            const feature = needsFeature
                ? this.buildReusablePaintFeature(featureTable, index)
                : {type: 'LineString', id: featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(index), index) : index, properties: {}};
            const join = lineJoin.evaluate(feature as any, {});
            const lineCap = cap.evaluate(feature as any, {});
            const lineMiterLimit = miterLimit.evaluate(feature as any, {});
            const lineRoundLimit = roundLimit.evaluate(feature as any, {});
            const geometryType = geometryVector.geometryType(index);
            this.lineClips = this.lineFeatureClips(featureTable, index);

            switch (geometryType) {
                case GEOMETRY_TYPE.LINESTRING: {
                    if (ringOffsets && geometryOffsets && partOffsets) {
                        const partOffset = geometryOffsets[index];
                        const ringOffset = partOffsets[partOffset];
                        const ringOffsetNext = partOffsets[partOffset + 1];
                        this.addLine(geometryVector, ringOffsets[ringOffset], ringOffsets[ringOffsetNext], false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                    } else if (ringOffsets && partOffsets) {
                        this.addLine(geometryVector, ringOffsets[index], ringOffsets[index + 1], false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                    } else if (geometryOffsets && partOffsets) {
                        const partOffset = geometryOffsets[index];
                        this.addLine(geometryVector, partOffsets[partOffset], partOffsets[partOffset + 1], false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                    } else if (partOffsets) {
                        this.addLine(geometryVector, partOffsets[index], partOffsets[index + 1], false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                    }
                    break;
                }
                case GEOMETRY_TYPE.MULTILINESTRING: {
                    if (ringOffsets && geometryOffsets && partOffsets) {
                        const partOffsetStart = geometryOffsets[index];
                        const numLineStrings = geometryOffsets[index + 1] - partOffsetStart;
                        for (let j = 0; j < numLineStrings; j++) {
                            const partOffset = partOffsetStart + j;
                            const ringOffset = partOffsets[partOffset];
                            const ringOffsetNext = partOffsets[partOffset + 1];
                            this.addLine(geometryVector, ringOffsets[ringOffset], ringOffsets[ringOffsetNext], false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                        }
                    } else if (geometryOffsets && partOffsets) {
                        const partOffsetStart = geometryOffsets[index];
                        const numLineStrings = geometryOffsets[index + 1] - partOffsetStart;
                        for (let j = 0; j < numLineStrings; j++) {
                            const partOffset = partOffsetStart + j;
                            this.addLine(geometryVector, partOffsets[partOffset], partOffsets[partOffset + 1], false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                        }
                    }
                    break;
                }
                case GEOMETRY_TYPE.POLYGON: {
                    if (geometryOffsets && partOffsets && ringOffsets) {
                        const partOffset = geometryOffsets[index];
                        const ringOffsetStart = partOffsets[partOffset];
                        const numRings = partOffsets[partOffset + 1] - ringOffsetStart;
                        for (let j = 0; j < numRings; j++) {
                            this.addLine(geometryVector, ringOffsets[ringOffsetStart + j], ringOffsets[ringOffsetStart + j + 1], true, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                        }
                    } else if (partOffsets && ringOffsets) {
                        const ringOffsetStart = partOffsets[index];
                        const numRings = partOffsets[index + 1] - ringOffsetStart;
                        for (let j = 0; j < numRings; j++) {
                            this.addLine(geometryVector, ringOffsets[ringOffsetStart + j], ringOffsets[ringOffsetStart + j + 1], true, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                        }
                    }
                    break;
                }
                case GEOMETRY_TYPE.MULTIPOLYGON: {
                    if (geometryOffsets && partOffsets && ringOffsets) {
                        const partOffsetStart = geometryOffsets[index];
                        const numPolygons = geometryOffsets[index + 1] - partOffsetStart;
                        for (let j = 0; j < numPolygons; j++) {
                            const ringOffsetStart = partOffsets[partOffsetStart + j];
                            const numRings = partOffsets[partOffsetStart + j + 1] - ringOffsetStart;
                            for (let k = 0; k < numRings; k++) {
                                this.addLine(geometryVector, ringOffsets[ringOffsetStart + k], ringOffsets[ringOffsetStart + k + 1], true, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                            }
                        }
                    }
                    break;
                }
                default:
                    continue;
            }

            this.populateFeaturePaintArrays(featureTable, index, feature as any, canonical, options, imagePositions, dashPositions);
        }
    }

    private sortSelectionVector(
        selectionVector: SelectionVector,
        featureTable: FeatureTable,
        lineSortKey: any,
        canonical: CanonicalTileID,
        lineSortKeySpec: unknown
    ): void {
        if (selectionVector.limit <= 1) {
            return;
        }

        const sortKeyPropertyName = getSimpleGetPropertyName(lineSortKeySpec);
        const sortKeyPropertyVector = sortKeyPropertyName ? featureTable.getPropertyVector(sortKeyPropertyName) : null;
        sortSelectionVectorByKey(selectionVector, (index) => sortKeyPropertyVector
            ? Number(normalizeColumnarValue(sortKeyPropertyVector.getValue(index)) ?? 0)
            : lineSortKey.evaluate(this.buildReusablePaintFeature(featureTable, index) as any, {}, canonical));
    }

    updateColumnar(states: FeatureStates, vtLayer: VectorTileLayer | undefined, imagePositions: {[_: string]: ImagePosition}, dashPositions?: Record<string, DashEntry>): void {
        if (!this.stateDependentLayers.length) return;
        const featureTable = (vtLayer as any)?.featureTable as FeatureTable | undefined;
        if (featureTable && !this._propertyColumns) {
            this._neededProperties = this.programConfigurations.getFeaturePropertyDependencies();
            this._propertyColumns = getColumnarPropertyColumns(featureTable, this._neededProperties);
        }
        const featureProvider = featureTable
            ? (index: number) => this.buildReusablePaintFeature(featureTable, index) as any
            : undefined;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {imagePositions, dashPositions}, featureProvider);
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
        if (this.layoutVertexBuffer2) {
            this.layoutVertexBuffer2.destroy();
        }
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
    }

    addLineStrings(featureTable: FeatureTable, selectionVector: SelectionVector, lineJoin: any, cap: any,
        miterLimit: any, roundLimit: any, canonical: CanonicalTileID, paintDataDriven: boolean, options?: PopulateParameters, imagePositions: {[_: string]: ImagePosition} | null = null, dashPositions?: {[_: string]: DashEntry}, columnarPaintArrays = false, profileAccumulator?: LinePopulateProfileAccumulator): void {
        const geometryVector = featureTable.geometryVector;
        const partOffsets = geometryVector.topologyVector.partOffsets;
        const tileExtent = featureTable.extent;

        const layoutDataDriven = !lineJoin.isConstant() || !cap.isConstant() || !miterLimit.isConstant() || !roundLimit.isConstant();
        const needsFeature = layoutDataDriven || (paintDataDriven && !columnarPaintArrays);
        const constantJoin = lineJoin.isConstant() ? lineJoin.evaluate({} as any, {}) : undefined;
        const constantCap = cap.isConstant() ? cap.evaluate({} as any, {}) : undefined;
        const constantMiterLimit = miterLimit.isConstant() ? miterLimit.evaluate({} as any, {}) : undefined;
        const constantRoundLimit = roundLimit.isConstant() ? roundLimit.evaluate({} as any, {}) : undefined;
        const {startVector: clipStartVector, endVector: clipEndVector} = this.lineClipVectors(featureTable);
        const hasClipVectors = !!clipStartVector && !!clipEndVector;
        if (!hasClipVectors) {
            this.lineClips = undefined;
        }

        for(let i = 0; i < selectionVector.limit; i++){
            const index = selectionVector.getIndex(i);
            const featureSetupStart = profileAccumulator ? performance.now() : 0;
            const featureBuildStart = profileAccumulator ? performance.now() : 0;
            const feature = needsFeature
                ? this.buildReusablePaintFeature(featureTable, index)
                : undefined;
            if (profileAccumulator) {
                profileAccumulator.featureBuildDuration += performance.now() - featureBuildStart;
            }
            const layoutEvalStart = profileAccumulator ? performance.now() : 0;
            const join = constantJoin !== undefined ? constantJoin : lineJoin.evaluate(feature as any, {});
            const lineCap = constantCap !== undefined ? constantCap : cap.evaluate(feature as any, {});
            const lineMiterLimit = constantMiterLimit !== undefined ? constantMiterLimit : miterLimit.evaluate(feature as any, {});
            const lineRoundLimit = constantRoundLimit !== undefined ? constantRoundLimit : roundLimit.evaluate(feature as any, {});
            if (profileAccumulator) {
                profileAccumulator.layoutEvalDuration += performance.now() - layoutEvalStart;
            }
            const clipStart = profileAccumulator ? performance.now() : 0;
            if (hasClipVectors) {
                this.lineClips = this.lineFeatureClipsFromVectors(clipStartVector, clipEndVector, index);
            }
            if (profileAccumulator) {
                profileAccumulator.clipDuration += performance.now() - clipStart;
            }
            if (profileAccumulator) {
                profileAccumulator.featureSetupDuration += performance.now() - featureSetupStart;
            }

            const startOffset = partOffsets[index];
            const endOffset = partOffsets[index+1];

            const geometryStart = profileAccumulator ? performance.now() : 0;
            const bbox = this.addSimpleLineFast(geometryVector, startOffset, endOffset, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent) ??
                this.addLine(geometryVector, startOffset, endOffset, false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
            this.featureIndexBBoxes[index] = bbox ?? [];
            if (profileAccumulator) {
                profileAccumulator.geometryDuration += performance.now() - geometryStart;
            }

            const paintStart = profileAccumulator ? performance.now() : 0;
            this.populateFeaturePaintArrays(featureTable, index, feature as any, canonical, options, imagePositions, dashPositions, columnarPaintArrays);
            if (profileAccumulator) {
                profileAccumulator.paintArraysDuration += performance.now() - paintStart;
            }
        }
    }

    addMultiLineStrings(featureTable: FeatureTable, selectionVector: SelectionVector, lineJoin: any, cap: any,
        miterLimit: any, roundLimit: any, canonical: CanonicalTileID, paintDataDriven: boolean, options?: PopulateParameters, imagePositions: {[_: string]: ImagePosition} | null = null, dashPositions?: {[_: string]: DashEntry}, columnarPaintArrays = false, profileAccumulator?: LinePopulateProfileAccumulator): void {
        const geometryVector = featureTable.geometryVector;
        const geometryOffsets = geometryVector.topologyVector.geometryOffsets;
        const partOffsets = geometryVector.topologyVector.partOffsets;
        const tileExtent = featureTable.extent;

        const layoutDataDriven = !lineJoin.isConstant() || !cap.isConstant() || !miterLimit.isConstant() || !roundLimit.isConstant();
        const needsFeature = layoutDataDriven || (paintDataDriven && !columnarPaintArrays);
        const constantJoin = lineJoin.isConstant() ? lineJoin.evaluate({} as any, {}) : undefined;
        const constantCap = cap.isConstant() ? cap.evaluate({} as any, {}) : undefined;
        const constantMiterLimit = miterLimit.isConstant() ? miterLimit.evaluate({} as any, {}) : undefined;
        const constantRoundLimit = roundLimit.isConstant() ? roundLimit.evaluate({} as any, {}) : undefined;
        const {startVector: clipStartVector, endVector: clipEndVector} = this.lineClipVectors(featureTable);
        const hasClipVectors = !!clipStartVector && !!clipEndVector;
        if (!hasClipVectors) {
            this.lineClips = undefined;
        }

        for(let i = 0; i < selectionVector.limit; i++){
            const index = selectionVector.getIndex(i);
            const featureSetupStart = profileAccumulator ? performance.now() : 0;
            const featureBuildStart = profileAccumulator ? performance.now() : 0;
            const feature = needsFeature
                ? this.buildReusablePaintFeature(featureTable, index)
                : undefined;
            if (profileAccumulator) {
                profileAccumulator.featureBuildDuration += performance.now() - featureBuildStart;
            }
            const layoutEvalStart = profileAccumulator ? performance.now() : 0;
            const join = constantJoin !== undefined ? constantJoin : lineJoin.evaluate(feature as any, {});
            const lineCap = constantCap !== undefined ? constantCap : cap.evaluate(feature as any, {});
            const lineMiterLimit = constantMiterLimit !== undefined ? constantMiterLimit : miterLimit.evaluate(feature as any, {});
            const lineRoundLimit = constantRoundLimit !== undefined ? constantRoundLimit : roundLimit.evaluate(feature as any, {});
            if (profileAccumulator) {
                profileAccumulator.layoutEvalDuration += performance.now() - layoutEvalStart;
            }
            const clipStart = profileAccumulator ? performance.now() : 0;
            if (hasClipVectors) {
                this.lineClips = this.lineFeatureClipsFromVectors(clipStartVector, clipEndVector, index);
            }
            if (profileAccumulator) {
                profileAccumulator.clipDuration += performance.now() - clipStart;
            }
            if (profileAccumulator) {
                profileAccumulator.featureSetupDuration += performance.now() - featureSetupStart;
            }

            const numLineStrings = geometryOffsets[index+1] - geometryOffsets[index];
            let partOffset = geometryOffsets[index];
            let featureBBox: FeatureIndexBBox | undefined;
            let featureBBoxes: FeatureIndexBBox[] | undefined;

            const geometryStart = profileAccumulator ? performance.now() : 0;
            for(let j = 0; j < numLineStrings; j++){
                const startOffset = partOffsets[partOffset];
                const endOffset = partOffsets[partOffset+1];

                const bbox = this.addSimpleLineFast(geometryVector, startOffset, endOffset, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent) ??
                    this.addLine(geometryVector, startOffset, endOffset, false, join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                if (bbox) {
                    if (numLineStrings === 1) {
                        featureBBox = bbox;
                    } else {
                        (featureBBoxes ??= []).push(bbox);
                    }
                }
                partOffset++;
            }
            this.featureIndexBBoxes[index] = featureBBoxes ?? featureBBox ?? [];
            if (profileAccumulator) {
                profileAccumulator.geometryDuration += performance.now() - geometryStart;
            }

            const paintStart = profileAccumulator ? performance.now() : 0;
            this.populateFeaturePaintArrays(featureTable, index, feature as any, canonical, options, imagePositions, dashPositions, columnarPaintArrays);
            if (profileAccumulator) {
                profileAccumulator.paintArraysDuration += performance.now() - paintStart;
            }
        }
    }

    addPolygon(featureTable: FeatureTable, selectionVector: SelectionVector, lineJoin: any, cap: any,
        miterLimit: any, roundLimit: any, canonical: CanonicalTileID, paintDataDriven: boolean, options?: PopulateParameters, imagePositions: {[_: string]: ImagePosition} | null = null, dashPositions?: {[_: string]: DashEntry}): void {
        const geometryVector = featureTable.geometryVector;
        const ringOffsets = geometryVector.topologyVector.ringOffsets;
        const partOffsets = geometryVector.topologyVector.partOffsets;
        const tileExtent = featureTable.extent;

        const layoutDataDriven = !lineJoin.isConstant() || !cap.isConstant() || !miterLimit.isConstant() || !roundLimit.isConstant();
        const needsFeature = layoutDataDriven || paintDataDriven;

        for(let i = 0; i < selectionVector.limit; i++){
            const index = selectionVector.getIndex(i);
            const feature = needsFeature
                ? this.buildReusablePaintFeature(featureTable, index)
                : {type: 'LineString', id: featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(index), index) : index, properties: {}};
            const join = lineJoin.evaluate(feature as any, {});
            const lineCap = cap.evaluate(feature as any, {});
            const lineMiterLimit = miterLimit.evaluate(feature as any, {});
            const lineRoundLimit = roundLimit.evaluate(feature as any, {});
            this.lineClips = this.lineFeatureClips(featureTable, index);

            const geometryType = geometryVector.geometryType(index);
            const ringOffsetStart = partOffsets[index];
            const numRings = partOffsets[index+1] - ringOffsetStart;

            for(let j = 0; j < numRings; j++){
                const ringStart = ringOffsets[ringOffsetStart + j];
                const ringEnd = ringOffsets[ringOffsetStart + j + 1];

                this.addLine(geometryVector, ringStart, ringEnd, geometryType === 2 || geometryType === 3,
                    join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
            }

            this.populateFeaturePaintArrays(featureTable, index, feature as any, canonical, options, imagePositions, dashPositions);
        }
    }

    addMultiPolygon(featureTable: FeatureTable, selectionVector: SelectionVector, lineJoin: any, cap: any,
        miterLimit: any, roundLimit: any, canonical: CanonicalTileID, paintDataDriven: boolean, options?: PopulateParameters, imagePositions: {[_: string]: ImagePosition} | null = null, dashPositions?: {[_: string]: DashEntry}): void {
        const geometryVector = featureTable.geometryVector as IGeometryVector;
        const geometryOffsets = geometryVector.topologyVector.geometryOffsets;
        const ringOffsets = geometryVector.topologyVector.ringOffsets;
        const partOffsets = geometryVector.topologyVector.partOffsets;
        const tileExtent = featureTable.extent;

        const layoutDataDriven = !lineJoin.isConstant() || !cap.isConstant() || !miterLimit.isConstant() || !roundLimit.isConstant();
        const needsFeature = layoutDataDriven || paintDataDriven;

        for(let i = 0; i < selectionVector.limit; i++){
            const index = selectionVector.getIndex(i);
            const feature = needsFeature
                ? this.buildReusablePaintFeature(featureTable, index)
                : {type: 'LineString', id: featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(index), index) : index, properties: {}};
            const join = lineJoin.evaluate(feature as any, {});
            const lineCap = cap.evaluate(feature as any, {});
            const lineMiterLimit = miterLimit.evaluate(feature as any, {});
            const lineRoundLimit = roundLimit.evaluate(feature as any, {});
            this.lineClips = this.lineFeatureClips(featureTable, index);

            const geometryType = geometryVector.geometryType(index);
            const partOffsetStart = geometryOffsets[index];
            const numPolygons = geometryOffsets[index+1] - partOffsetStart;

            for(let j = 0; j < numPolygons; j++){
                const ringOffsetStart = partOffsets[partOffsetStart + j];
                const numRings = partOffsets[partOffsetStart + j + 1] - ringOffsetStart;

                for(let k = 0; k < numRings; k++){
                    const ringStart = ringOffsets[ringOffsetStart + k];
                    const ringEnd = ringOffsets[ringOffsetStart + k + 1];

                    this.addLine(geometryVector, ringStart, ringEnd,
                        geometryType === 2 || geometryType === 3 || geometryType === 5 || geometryType === 6,
                        join, lineCap, lineMiterLimit, lineRoundLimit, tileExtent);
                }
            }

            this.populateFeaturePaintArrays(featureTable, index, feature as any, canonical, options, imagePositions, dashPositions);
        }
    }

    private populateFeaturePaintArrays(
        featureTable: FeatureTable,
        featureIndex: number,
        feature: any | undefined,
        canonical: CanonicalTileID,
        options?: PopulateParameters,
        imagePositions: {[_: string]: ImagePosition} | null = null,
        dashPositions?: {[_: string]: DashEntry},
        columnarPaintArrays = false
    ) {
        if (columnarPaintArrays && !this.hasDependencies) {
            const featureId = featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(featureIndex), featureIndex) : featureIndex;
            this.programConfigurations.populateColumnarPaintArrays(this.layoutVertexArray.length, featureIndex, featureId, this.getPaintPropertyColumn);
            return;
        }

        feature ??= this.buildReusablePaintFeature(featureTable, featureIndex);
        let paintFeature = feature;
        if (this.hasDependencies && options) {
            paintFeature = this.buildDependencyFeature(featureTable, featureIndex);
            if (hasPattern('line', this.layers, options)) {
                addPatternDependencies('line', this.layers, paintFeature, {zoom: this.zoom}, options);
            }
            if (this.hasDasharrayDependencies) {
                this.addLineDashDependencies(this.layers, paintFeature, this.zoom, options);
            }
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, paintFeature, featureIndex, {
            imagePositions,
            dashPositions,
            canonical
        });
    }

    private collectDeferredDependencies(featureTable: FeatureTable, selectionVector: SelectionVector, options: PopulateParameters): void {
        if (!this.hasDependencies) {
            return;
        }

        for (let i = 0; i < selectionVector.limit; i++) {
            const featureIndex = selectionVector.getIndex(i);
            const dependencyFeature = this.buildDependencyFeature(featureTable, featureIndex);

            if (hasPattern('line', this.layers, options)) {
                addPatternDependencies('line', this.layers, dependencyFeature as any, {zoom: this.zoom}, options);
            }
            if (this.hasDasharrayDependencies) {
                this.addLineDashDependencies(this.layers, dependencyFeature as any, this.zoom, options);
            }
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

    private addLineDashDependencies(layers: LineStyleLayer[], bucketFeature: BucketFeature, zoom: number, options: PopulateParameters): void {
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

    private addSimpleLineFast(geometryVector: IGeometryVector | IGpuVector, startOffset: number, endOffset: number, join: string, cap: string, miterLimit: number, roundLimit: number, tileExtent: number): FeatureIndexBBox | undefined | null {
        if (this.lineSubdivisionGranularity > 1) return null;
        const len = endOffset - startOffset;
        const mortonGeometry = 'mortonSettings' in geometryVector && geometryVector.mortonSettings;
        const vertexBuffer = !mortonGeometry && 'vertexBuffer' in geometryVector ? geometryVector.vertexBuffer : undefined;
        if (len < 2 || len > 8 || (!vertexBuffer && !mortonGeometry)) {
            return null;
        }
        const vertexOffsets = !mortonGeometry && 'vertexOffsets' in geometryVector ? geometryVector.vertexOffsets : undefined;

        const profileAccumulator = this._linePopulateProfileAccumulator;
        const coordinateStart = profileAccumulator ? performance.now() : 0;

        this.distance = 0;
        this.scaledDistance = 0;
        this.totalDistance = 0;

        const scaleFactor = EXTENT / tileExtent;
        if (!mortonGeometry && vertexBuffer && len === 2 && (cap === 'butt' || cap === 'square')) {
            const firstOffset = (vertexOffsets ? vertexOffsets[startOffset] : startOffset) * 2;
            const secondOffset = (vertexOffsets ? vertexOffsets[startOffset + 1] : startOffset + 1) * 2;
            const firstRawX = vertexBuffer[firstOffset];
            const firstRawY = vertexBuffer[firstOffset + 1];
            const secondRawX = vertexBuffer[secondOffset];
            const secondRawY = vertexBuffer[secondOffset + 1];

            if (firstRawX === secondRawX && firstRawY === secondRawY) {
                if (profileAccumulator) {
                    profileAccumulator.coordinateDuration += performance.now() - coordinateStart;
                }
                return null;
            }

            const x0 = clamp(Math.round(firstRawX * scaleFactor), MIN_COORD, MAX_COORD);
            const y0 = clamp(Math.round(firstRawY * scaleFactor), MIN_COORD, MAX_COORD);
            const x1 = clamp(Math.round(secondRawX * scaleFactor), MIN_COORD, MAX_COORD);
            const y1 = clamp(Math.round(secondRawY * scaleFactor), MIN_COORD, MAX_COORD);
            const minX = x0 < x1 ? x0 : x1;
            const minY = y0 < y1 ? y0 : y1;
            const maxX = x0 > x1 ? x0 : x1;
            const maxY = y0 > y1 ? y0 : y1;

            if (this.lineClips) {
                const dx = x1 - x0;
                const dy = y1 - y0;
                this.totalDistance = Math.sqrt(dx * dx + dy * dy);
            }

            if (profileAccumulator) {
                profileAccumulator.coordinateDuration += performance.now() - coordinateStart;
            }

            const tessellateStart = profileAccumulator ? performance.now() : 0;
            if (this.lineClips) {
                this.lineClipsArray.push(this.lineClips);
                this.updateScaledDistance();
                this.maxLineLength = Math.max(this.maxLineLength, this.totalDistance);
            }

            this.e1 = this.e2 = -1;
            const segment = this.segments.prepareSegment(20, this.layoutVertexArray, this.indexArray);
            const magnitude = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
            const normalX = magnitude === 0 ? 0 : -(y1 - y0) / magnitude;
            const normalY = magnitude === 0 ? 0 : (x1 - x0) / magnitude;
            const startCapOffset = cap === 'square' ? -1 : 0;
            const endCapOffset = cap === 'square' ? 1 : 0;

            this.addCurrentVertexXY(x0, y0, normalX, normalY, startCapOffset, startCapOffset, segment);
            this.updateDistance(x0, y0, x1, y1);
            this.addCurrentVertexXY(x1, y1, normalX, normalY, endCapOffset, endCapOffset, segment);

            if (profileAccumulator) {
                profileAccumulator.tessellateDuration += performance.now() - tessellateStart;
            }

            return [minX, minY, maxX, maxY];
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let previousRawX: number | undefined;
        let previousRawY: number | undefined;
        let previousX: number | undefined;
        let previousY: number | undefined;

        for (let i = 0; i < len; i++) {
            const vertexIndex = startOffset + i;
            let rawX: number;
            let rawY: number;
            if (mortonGeometry) {
                [rawX, rawY] = geometryVector.getVertex(vertexIndex);
            } else {
                const offset = (vertexOffsets ? vertexOffsets[vertexIndex] : vertexIndex) * 2;
                rawX = vertexBuffer[offset];
                rawY = vertexBuffer[offset + 1];
            }
            if (rawX === previousRawX && rawY === previousRawY) {
                if (profileAccumulator) {
                    profileAccumulator.coordinateDuration += performance.now() - coordinateStart;
                }
                return null;
            }

            const x = clamp(Math.round(rawX * scaleFactor), MIN_COORD, MAX_COORD);
            const y = clamp(Math.round(rawY * scaleFactor), MIN_COORD, MAX_COORD);
            this._lineCoordinateScratch[i * 2] = x;
            this._lineCoordinateScratch[i * 2 + 1] = y;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;

            if (this.lineClips && previousX !== undefined && previousY !== undefined) {
                const dx = x - previousX;
                const dy = y - previousY;
                this.totalDistance += Math.sqrt(dx * dx + dy * dy);
            }

            previousRawX = rawX;
            previousRawY = rawY;
            previousX = x;
            previousY = y;
        }

        if (profileAccumulator) {
            profileAccumulator.coordinateDuration += performance.now() - coordinateStart;
        }

        const tessellateStart = profileAccumulator ? performance.now() : 0;
        if (this.lineClips) {
            this.lineClipsArray.push(this.lineClips);
            this.updateScaledDistance();
            this.maxLineLength = Math.max(this.maxLineLength, this.totalDistance);
        }

        this._lineCoordinateScratch.length = len * 2;
        this.addLineGeometryFlat(this._lineCoordinateScratch, len, false, join, cap, miterLimit, roundLimit);

        if (profileAccumulator) {
            profileAccumulator.tessellateDuration += performance.now() - tessellateStart;
        }

        return [minX, minY, maxX, maxY];
    }

    /**
     * Tessellates numeric coordinates, subdividing closed rings and recalculating clipped distances without Point objects.
     * Preserves query bounds for nonempty parts even when they have no drawable segment, matching the legacy line index.
     * Polygon validity is checked after closing rings, which may omit the duplicate closing vertex in the raw vector.
     */
    addLine(geometryVector: IGeometryVector | IGpuVector, startOffset: number, endOffset: number, isPolygon: boolean,
        join: string, cap: any, miterLimit: any, roundLimit: any, tileExtent: number): FeatureIndexBBox | undefined {

        const profileAccumulator = this._linePopulateProfileAccumulator;
        const coordinateStart = profileAccumulator ? performance.now() : 0;

        this.distance = 0;
        this.scaledDistance = 0;
        this.totalDistance = 0;

        let len = endOffset - startOffset;

        // If the line has duplicate vertices at the ends, adjust start/length to remove them.
        while (len >= 2 && VectorUtils.equalsVertex(geometryVector, startOffset + len - 1,
            startOffset + len - 2)){
            len--;
        }
        let firstRelative = 0;
        while (firstRelative < len - 1 && VectorUtils.equalsVertex(geometryVector, startOffset + firstRelative, startOffset + firstRelative + 1)) {
            firstRelative++;
        }

        if (len < 1) {
            if (profileAccumulator) {
                profileAccumulator.coordinateDuration += performance.now() - coordinateStart;
            }
            return undefined;
        }

        let vertexCount = 0;
        let coordinateCount = 0;
        let previousX: number | undefined;
        let previousY: number | undefined;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const scaleFactor = EXTENT / tileExtent;

        for (let i = startOffset + firstRelative; i < startOffset + len; i++) {
            const rawScaledX = VectorUtils.getVertexX(geometryVector, i) * scaleFactor;
            const rawScaledY = VectorUtils.getVertexY(geometryVector, i) * scaleFactor;

            const scaledX = clamp(Math.round(rawScaledX), MIN_COORD, MAX_COORD);
            const scaledY = clamp(Math.round(rawScaledY), MIN_COORD, MAX_COORD);
            if (scaledX < minX) minX = scaledX;
            if (scaledY < minY) minY = scaledY;
            if (scaledX > maxX) maxX = scaledX;
            if (scaledY > maxY) maxY = scaledY;

            this._lineCoordinateScratch[coordinateCount++] = scaledX;
            this._lineCoordinateScratch[coordinateCount++] = scaledY;
            vertexCount++;

            if (this.lineClips && previousX !== undefined && previousY !== undefined) {
                this.totalDistance += VectorUtils.dist(previousX, previousY, scaledX, scaledY);
            }

            previousX = scaledX;
            previousY = scaledY;
        }

        // Polygon rings in the raw geometry vector are stored without the closing
        // duplicate vertex, while the legacy line bucket operates on closed rings.
        // Close the ring here so line tessellation stays byte-for-byte aligned.
        if (isPolygon && vertexCount > 0) {
            const firstX = this._lineCoordinateScratch[0];
            const firstY = this._lineCoordinateScratch[1];
            const lastOffset = coordinateCount - 2;
            const lastX = this._lineCoordinateScratch[lastOffset];
            const lastY = this._lineCoordinateScratch[lastOffset + 1];
            if (firstX !== lastX || firstY !== lastY) {
                if (this.lineClips) {
                    this.totalDistance += VectorUtils.dist(lastX, lastY, firstX, firstY);
                }
                this._lineCoordinateScratch[coordinateCount++] = firstX;
                this._lineCoordinateScratch[coordinateCount++] = firstY;
                vertexCount++;
            }
        }

        if (vertexCount < (isPolygon ? 3 : 2)) {
            if (profileAccumulator) {
                profileAccumulator.coordinateDuration += performance.now() - coordinateStart;
            }
            return minX === Infinity ? undefined : [minX, minY, maxX, maxY];
        }

        this._lineCoordinateScratch.length = coordinateCount;
        const vertices = subdivideFlattenedVertexLine(this._lineCoordinateScratch, this.lineSubdivisionGranularity);
        vertexCount = vertices.length / 2;
        if (this.lineClips && this.lineSubdivisionGranularity > 1) {
            this.totalDistance = 0;
            for (let i = 2; i < vertices.length; i += 2) {
                this.totalDistance += VectorUtils.dist(vertices[i - 2], vertices[i - 1], vertices[i], vertices[i + 1]);
            }
        }

        if (this.lineClips) {
            this.lineClipsArray.push(this.lineClips);
            this.updateScaledDistance();
            this.maxLineLength = Math.max(this.maxLineLength, this.totalDistance);
        }

        if (profileAccumulator) {
            profileAccumulator.coordinateDuration += performance.now() - coordinateStart;
        }
        const tessellateStart = profileAccumulator ? performance.now() : 0;
        this.addLineGeometryFlat(vertices, vertexCount, isPolygon, join, cap, miterLimit, roundLimit);
        if (profileAccumulator) {
            profileAccumulator.tessellateDuration += performance.now() - tessellateStart;
        }
        return minX === Infinity ? undefined : [minX, minY, maxX, maxY];
    }

    updateScaledDistance(): void {
        this.scaledDistance = this.lineClips && this.totalDistance !== 0
            ? this.lineClips.start + (this.lineClips.end - this.lineClips.start) * this.distance / this.totalDistance
            : this.distance;
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
            linesofarScaled >> 6
        );

        if (this.lineClips) {
            const progressRealigned = this.scaledDistance - this.lineClips.start;
            const endClipRealigned = this.lineClips.end - this.lineClips.start;
            const uvX = progressRealigned / endClipRealigned;
            this.layoutVertexArray2.emplaceBack(uvX, this.lineClipsArray.length);
        }
    }
}

register('ColumnarLineBucket', ColumnarLineBucket, {omit: [
    'layers',
    'patternFeatures',
    '_neededProperties',
    '_propertyColumns',
    '_propertyColumnByName',
    'pendingFeatureTable',
    'pendingSelectionVector',
    'pendingCanonical',
    '_lineCoordinateScratch',
    '_linePopulateProfileAccumulator',
    '_paintFeatureScratch',
    'getPaintPropertyColumn',
    'featureIndexSelectionVector',
    'featureIndexBBoxes'
]} as any);
