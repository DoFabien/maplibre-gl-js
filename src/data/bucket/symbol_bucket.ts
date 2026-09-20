import {
    symbolLayoutAttributes,
    collisionVertexAttributes,
    collisionBoxLayout,
    dynamicLayoutAttributes,
} from './symbol_attributes.ts';
import {SymbolLayoutArray,
    SymbolDynamicLayoutArray,
    SymbolOpacityArray,
    CollisionBoxLayoutArray,
    CollisionVertexArray,
    PlacedSymbolArray,
    SymbolInstanceArray,
    GlyphOffsetArray,
    SymbolLineVertexArray,
    TextAnchorOffsetArray
} from '../array_types.g.ts';
import Point from '@mapbox/point-geometry';
import {SegmentVector} from '../segment.ts';
import {ProgramConfigurationSet} from '../program_configuration.ts';
import {TriangleIndexArray, LineIndexArray} from '../array_types.g.ts';
import {EXTENT} from '../extent.ts';
import {transformText} from '../../symbol/transform_text.ts';
import {mergeLines} from '../../symbol/merge_lines.ts';
import {isCluster} from '../../util/graphemes.ts';
import {TaggedString} from '../../symbol/tagged_string.ts';
import {allowsVerticalWritingMode, stringContainsRTLText} from '../../util/script_detection.ts';
import {WritingMode} from '../../symbol/shaping.ts';
import {loadGeometry} from '../load_geometry.ts';
import {toEvaluationFeature} from '../evaluation_feature.ts';
import {VectorTileFeature} from '@mapbox/vector-tile';
import {verticalizedCharacterMap} from '../../util/verticalize_punctuation.ts';
import {getSizeData, MAX_PACKED_SIZE, MAX_GLYPHS} from '../../symbol/symbol_size.ts';
import {performSymbolLayout} from '../../symbol/symbol_layout.ts';
import {register} from '../../util/web_worker_transfer.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {Formatted, ResolvedImage} from '@maplibre/maplibre-gl-style-spec';
import {getOverlapMode} from '../../style/style_layer/overlap_mode.ts';
import {createSelectionVector, type FeatureTable, GEOMETRY_TYPE} from '@maplibre/mlt';
import filter from '../filter/mlt/filter.ts';
import {loadFeatureGeometry} from './columnar/geometry_traversal.ts';
import {normalizeColumnarValue} from './columnar/feature_properties.ts';
import {ColumnarEvaluationFeature} from './columnar/evaluation_feature.ts';
import {collectExpressionPropertyDependencies, collectFilterPropertyDependencies} from './columnar/property_dependencies.ts';
import {
    getCoordinateDistance,
    getSymbolLinePointCount,
    isFlatSymbolLine,
    type SymbolLine,
} from '../../symbol/symbol_line.ts';
import {recordParseProfile} from '../bucket.ts';
import {normalizeMltFeatureId} from '../../util/mlt_feature_id.ts';

import type {ColumnarLineChain} from '../../symbol/columnar_symbol_geometry.ts';
import type {Anchor} from '../../symbol/anchor.ts';
import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {
    Bucket,
    BucketParameters,
    BucketDependencyParameters,
    IndexedFeature,
    ParseProfile,
    PopulateParameters
} from '../bucket.ts';
import type {CollisionBoxArray, CollisionBox, SymbolInstance} from '../array_types.g.ts';
import type {StructArray, StructArrayMember, ViewType} from '../../util/struct_array.ts';
import type {SymbolStyleLayer} from '../../style/style_layer/symbol_style_layer.ts';
import type {Context} from '../../webgl/context.ts';
import type {IndexBuffer} from '../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../webgl/vertex_buffer.ts';
import type {SymbolQuad} from '../../symbol/quads.ts';
import type {SizeData} from '../../symbol/symbol_size.ts';
import type {FeatureStates} from '../../source/source_state.ts';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';
import type {DashEntry} from '../../render/line_atlas.ts';

const emptySymbolGeometry: Point[][] = [];
const emptySymbolProperties = Object.freeze({});

export type SingleCollisionBox = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    anchorPointX: number;
    anchorPointY: number;
};

export type CollisionArrays = {
    textBox?: SingleCollisionBox;
    verticalTextBox?: SingleCollisionBox;
    iconBox?: SingleCollisionBox;
    verticalIconBox?: SingleCollisionBox;
    textFeatureIndex?: number;
    verticalTextFeatureIndex?: number;
    iconFeatureIndex?: number;
    verticalIconFeatureIndex?: number;
};

export type SymbolFeature = {
    sortKey: number | void;
    text: Formatted | void;
    icon: ResolvedImage;
    index: number;
    sourceLayerIndex: number;
    geometry: Point[][];
    columnarFeatureTable?: FeatureTable;
    columnarLineSlices?: ColumnarLineChain;
    columnarEvaluationFeature?: ColumnarEvaluationFeature;
    activateColumnarEvaluationContext?: () => void;
    deactivateColumnarEvaluationContext?: () => void;
    properties: any;
    type: 'Unknown' | 'Point' | 'LineString' | 'Polygon';
    id?: any;
};

class ColumnarSymbolFeature implements SymbolFeature {
    sortKey: number | void;
    text: Formatted | void;
    icon: ResolvedImage;
    index: number;
    sourceLayerIndex: number;
    geometry: Point[][];
    columnarFeatureTable?: FeatureTable;
    columnarLineSlices?: ColumnarLineChain;
    columnarEvaluationFeature?: ColumnarEvaluationFeature;
    type: SymbolFeature['type'];
    id?: any;
    private columnarEvaluationContextActive = false;

    constructor(
        feature: Omit<SymbolFeature, 'properties' | 'columnarEvaluationFeature'>,
        columnarEvaluationFeature: ColumnarEvaluationFeature,
    ) {
        this.sortKey = feature.sortKey;
        this.text = feature.text;
        this.icon = feature.icon;
        this.index = feature.index;
        this.sourceLayerIndex = feature.sourceLayerIndex;
        this.geometry = feature.geometry;
        this.columnarFeatureTable = feature.columnarFeatureTable;
        this.columnarLineSlices = feature.columnarLineSlices;
        this.columnarEvaluationFeature = columnarEvaluationFeature;
        this.type = feature.type;
        this.id = feature.id;
    }

    get properties(): Record<string, unknown> {
        const evaluationFeature = this.columnarEvaluationFeature;
        if (!evaluationFeature) return emptySymbolProperties;
        if (!this.columnarEvaluationContextActive) evaluationFeature.setIndex(this.index);
        return evaluationFeature.properties;
    }

    activateColumnarEvaluationContext(): void {
        this.columnarEvaluationFeature?.setIndex(this.index);
        this.columnarEvaluationContextActive = true;
    }

    deactivateColumnarEvaluationContext(): void {
        this.columnarEvaluationContextActive = false;
    }
}

export type SortKeyRange = {
    sortKey: number;
    symbolInstanceStart: number;
    symbolInstanceEnd: number;
};

// Opacity arrays are frequently updated but don't contain a lot of information, so we pack them
// tight. Each Uint32 is actually four duplicate Uint8s for the four corners of a glyph
// 7 bits are for the current opacity, and the lowest bit is the target opacity

// actually defined in symbol_attributes.js
// const placementOpacityAttributes = [
//     { name: 'a_fade_opacity', components: 1, type: 'Uint32' }
// ];
const shaderOpacityAttributes = [
    {name: 'a_fade_opacity', components: 1, type: 'Uint8' as ViewType, offset: 0}
];

function addVertex(
    array: StructArray,
    anchorX: number,
    anchorY: number,
    ox: number,
    oy: number,
    tx: number,
    ty: number,
    sizeVertex: number,
    isSDF: boolean,
    pixelOffsetX: number,
    pixelOffsetY: number,
    minFontScaleX: number,
    minFontScaleY: number,
    elevation: number
) {
    const aSizeX = sizeVertex ? Math.min(MAX_PACKED_SIZE, Math.round(sizeVertex[0])) : 0;
    const aSizeY = sizeVertex ? Math.min(MAX_PACKED_SIZE, Math.round(sizeVertex[1])) : 0;
    array.emplaceBack(
        // a_pos_offset
        anchorX,
        anchorY,
        Math.round(ox * 32),
        Math.round(oy * 32),

        // a_data
        tx, // x coordinate of symbol on glyph atlas texture
        ty, // y coordinate of symbol on glyph atlas texture
        (aSizeX << 1) + (isSDF ? 1 : 0),
        aSizeY,
        pixelOffsetX * 16,
        pixelOffsetY * 16,
        minFontScaleX * 256,
        minFontScaleY * 256,
        elevation
    );
}

function addDynamicAttributes(dynamicLayoutVertexArray: StructArray, p: Point, angle: number): void {
    dynamicLayoutVertexArray.emplaceBack(p.x, p.y, angle);
    dynamicLayoutVertexArray.emplaceBack(p.x, p.y, angle);
    dynamicLayoutVertexArray.emplaceBack(p.x, p.y, angle);
    dynamicLayoutVertexArray.emplaceBack(p.x, p.y, angle);
}

function containsRTLText(formattedText: Formatted): boolean {
    for (const section of formattedText.sections) {
        if (stringContainsRTLText(section.text)) {
            return true;
        }
    }
    return false;
}

function getSimpleGetExpressionPropertyName(expression: unknown): string | null {
    return Array.isArray(expression) && expression.length === 2 && expression[0] === 'get' && typeof expression[1] === 'string'
        ? expression[1]
        : null;
}

export class SymbolBuffers {
    layoutVertexArray: SymbolLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    programConfigurations: ProgramConfigurationSet<SymbolStyleLayer>;
    segments: SegmentVector;

    dynamicLayoutVertexArray: SymbolDynamicLayoutArray;
    dynamicLayoutVertexBuffer: VertexBuffer;

    opacityVertexArray: SymbolOpacityArray;
    opacityVertexBuffer: VertexBuffer;
    hasVisibleVertices: boolean;

    collisionVertexArray: CollisionVertexArray;
    collisionVertexBuffer: VertexBuffer;

    placedSymbolArray: PlacedSymbolArray;

    constructor(programConfigurations: ProgramConfigurationSet<SymbolStyleLayer>) {
        this.layoutVertexArray = new SymbolLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = programConfigurations;
        this.segments = new SegmentVector();
        this.dynamicLayoutVertexArray = new SymbolDynamicLayoutArray();
        this.opacityVertexArray = new SymbolOpacityArray();
        this.hasVisibleVertices = false;
        this.placedSymbolArray = new PlacedSymbolArray();
    }

    isEmpty(): boolean {
        return this.layoutVertexArray.length === 0 &&
            this.indexArray.length === 0 &&
            this.dynamicLayoutVertexArray.length === 0 &&
            this.opacityVertexArray.length === 0;
    }

    upload(context: Context, dynamicIndexBuffer: boolean, upload?: boolean, update?: boolean): void {
        if (this.isEmpty()) {
            return;
        }

        if (upload) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, symbolLayoutAttributes.members);
            this.indexBuffer = context.createIndexBuffer(this.indexArray, dynamicIndexBuffer);
            this.dynamicLayoutVertexBuffer = context.createVertexBuffer(this.dynamicLayoutVertexArray, dynamicLayoutAttributes.members, true);
            this.opacityVertexBuffer = context.createVertexBuffer(this.opacityVertexArray, shaderOpacityAttributes, true);
            // This is a performance hack so that we can write to opacityVertexArray with uint32s
            // even though the shaders read uint8s
            this.opacityVertexBuffer.itemSize = 1;
        }
        if (upload || update) {
            this.programConfigurations.upload(context);
        }
    }

    destroy(): void {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.dynamicLayoutVertexBuffer.destroy();
        this.opacityVertexBuffer.destroy();
    }
}

register('SymbolBuffers', SymbolBuffers);

class CollisionBuffers {
    layoutVertexArray: StructArray;
    layoutAttributes: StructArrayMember[];
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray | LineIndexArray;
    indexBuffer: IndexBuffer;

    segments: SegmentVector;

    collisionVertexArray: CollisionVertexArray;
    collisionVertexBuffer: VertexBuffer;

    constructor(LayoutArray: {
        new (...args: any): StructArray;
    },
    layoutAttributes: StructArrayMember[],
    IndexArray: {
        new (...args: any): TriangleIndexArray | LineIndexArray;
    }) {
        this.layoutVertexArray = new LayoutArray();
        this.layoutAttributes = layoutAttributes;
        this.indexArray = new IndexArray();
        this.segments = new SegmentVector();
        this.collisionVertexArray = new CollisionVertexArray();
    }

    upload(context: Context): void {
        this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, this.layoutAttributes);
        this.indexBuffer = context.createIndexBuffer(this.indexArray);
        this.collisionVertexBuffer = context.createVertexBuffer(this.collisionVertexArray, collisionVertexAttributes.members, true);
    }

    destroy(): void {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.segments.destroy();
        this.collisionVertexBuffer.destroy();
    }
}

register('CollisionBuffers', CollisionBuffers);

/**
 * @internal
 * Unlike other buckets, which simply implement `addFeature` with type-specific
 * logic for (essentially) triangulating feature geometries, SymbolBucket
 * requires specialized behavior:
 *
 * 1. WorkerTile.parse(), the logical owner of the bucket creation process,
 *    calls SymbolBucket.populate(), which resolves text and icon tokens on
 *    each feature, adds each glyphs and symbols needed to the passed-in
 *    collections options.glyphDependencies and options.iconDependencies, and
 *    stores the feature data for use in subsequent step (this.features).
 *
 * 2. WorkerTile asynchronously requests from the main thread all of the glyphs
 *    and icons needed (by this bucket and any others).
 *
 * 3. WorkerTile calls SymbolBucket.addFeatures(), which delegates text shaping
 *    and layout to performSymbolLayout(). This step populates:
 *      `this.symbolInstances`: metadata on generated symbols
 *      `this.collisionBoxArray`: collision data for use by foreground
 *      `this.text`: SymbolBuffers for text symbols
 *      `this.icons`: SymbolBuffers for icons
 *      `this.iconCollisionBox`: Debug SymbolBuffers for icon collision boxes
 *      `this.textCollisionBox`: Debug SymbolBuffers for text collision boxes
 *    The results are sent to the foreground for rendering
 *
 * 4. placement.ts is run on the foreground,
 *    and uses the CollisionIndex along with current camera settings to determine
 *    which symbols can actually show on the map. Collided symbols are hidden
 *    using a dynamic "OpacityVertexArray".
 */
export class SymbolBucket implements Bucket<FeatureTable | IndexedFeature[]> {
    readonly isColumnar: boolean;

    collisionBoxArray: CollisionBoxArray;
    zoom: number;
    overscaling: number;
    layers: SymbolStyleLayer[];
    layerIds: string[];
    stateDependentLayers: SymbolStyleLayer[];
    stateDependentLayerIds: string[];

    index: number;
    sdfIcons: boolean;
    iconsInText: boolean;
    iconsNeedLinear: boolean;
    bucketInstanceId: number;
    justReloaded: boolean;
    hasDependencies: boolean;

    textSizeData: SizeData;
    iconSizeData: SizeData;

    glyphOffsetArray: GlyphOffsetArray;
    /**
     * The glyph cap for this bucket, normally {@link MAX_GLYPHS}. Tests lower it to
     * exercise the overflow warning without filling a bucket with 65,535 glyphs.
     */
    maxGlyphs: number;
    lineVertexArray: SymbolLineVertexArray;
    features: SymbolFeature[];
    symbolInstances: SymbolInstanceArray;
    textAnchorOffsets: TextAnchorOffsetArray;
    collisionArrays: CollisionArrays[];
    sortKeyRanges: SortKeyRange[];
    pixelRatio: number;
    tilePixelRatio: number;
    compareText: {[_: string]: Point[]};
    fadeStartTime: number;
    sortFeaturesByKey: boolean;
    sortFeaturesByY: boolean;
    canOverlap: boolean;
    sortedAngle: number;
    featureSortOrder: number[];
    maxHeightOffset: number;

    collisionCircleArray: number[];

    text: SymbolBuffers;
    icon: SymbolBuffers;
    textCollisionBox: CollisionBuffers;
    iconCollisionBox: CollisionBuffers;
    uploaded: boolean;
    sourceLayerIndex: number;
    sourceID: string;
    symbolInstanceIndexes: number[];
    writingModes: WritingMode[];
    allowVerticalPlacement: boolean;
    hasRTLText: boolean;
    private _featureStateFeatureTable?: FeatureTable;
    private _featureStateIdResolver?: (featureIndex: number) => string | number | undefined;
    profile?: ParseProfile;

    constructor(options: BucketParameters<SymbolStyleLayer>) {
        this.isColumnar = options.encoding === 'mlt';
        this.collisionBoxArray = options.collisionBoxArray;
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.pixelRatio = options.pixelRatio;
        this.sourceLayerIndex = options.sourceLayerIndex;
        this.hasDependencies = true;
        this.hasRTLText = false;
        this.maxHeightOffset = 0;
        this.sortKeyRanges = [];

        this.collisionCircleArray = [];
        this.maxGlyphs = MAX_GLYPHS;

        const layer = this.layers[0];
        const unevaluatedLayoutValues = layer._unevaluatedLayout._values;

        this.textSizeData = getSizeData(this.zoom, unevaluatedLayoutValues['text-size']);
        this.iconSizeData = getSizeData(this.zoom, unevaluatedLayoutValues['icon-size']);

        const layout = this.layers[0].layout;
        const sortKey = layout.get('symbol-sort-key');
        const zOrder = layout.get('symbol-z-order');
        this.canOverlap =
            getOverlapMode(layout, 'text-overlap', 'text-allow-overlap') !== 'never' ||
            getOverlapMode(layout, 'icon-overlap', 'icon-allow-overlap') !== 'never' ||
            layout.get('text-ignore-placement') ||
            layout.get('icon-ignore-placement');
        this.sortFeaturesByKey = zOrder !== 'viewport-y' && !sortKey.isConstant();
        const zOrderByViewportY = zOrder === 'viewport-y' || (zOrder === 'auto' && !this.sortFeaturesByKey);
        this.sortFeaturesByY = zOrderByViewportY && this.canOverlap;

        if (layout.get('symbol-placement') === 'point') {
            this.writingModes = layout.get('text-writing-mode').map(wm => WritingMode[wm]);
        }

        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);

        this.sourceID = options.sourceID;
    }

    createArrays(): void {
        this.text = new SymbolBuffers(new ProgramConfigurationSet(this.layers, this.zoom, property => property.startsWith('text')));
        this.icon = new SymbolBuffers(new ProgramConfigurationSet(this.layers, this.zoom, property => property.startsWith('icon')));

        this.glyphOffsetArray = new GlyphOffsetArray();
        this.lineVertexArray = new SymbolLineVertexArray();
        this.symbolInstances = new SymbolInstanceArray();
        this.textAnchorOffsets = new TextAnchorOffsetArray();
    }

    /**
     * Collects the glyphs a label needs into `stacks`, so that the tile can ask for them.
     *
     * A cluster of several codepoints is asked for as a whole, so that it can be drawn as the one
     * shape it is written as. Its codepoints are asked for as well, to give layout something to draw
     * a codepoint at a time where the cluster itself yields no glyph. See `shapeLines`.
     *
     * A cluster can span two sections, a letter in one and the accent written on it in the next, so
     * the label is taken as a whole and each cluster attributed to the section its first character
     * came from -- the same way layout attributes it. Collecting each section's text on its own
     * would ask for glyphs no cluster is ever looked up by.
     */
    private calculateGlyphDependencies(
        text: Formatted,
        stacks: Record<string, Record<string, boolean>>,
        fontStack: string,
        textAlongLine: boolean,
        doesAllowVerticalWritingMode: boolean): void {

        const needsVerticalForms = (textAlongLine || this.allowVerticalPlacement) && doesAllowVerticalWritingMode;
        const tagged = TaggedString.fromFeature(text, fontStack);
        const graphemes = tagged.graphemes();

        for (let i = 0; i < graphemes.length; i++) {
            const section = tagged.getSection(i);
            if ('imageName' in section) continue;

            const stack = stacks[section.fontStack] ||= {};
            const grapheme = graphemes[i];
            if (isCluster(grapheme)) stack[grapheme] = true;

            for (const char of grapheme) {
                stack[char] = true;
                if (!needsVerticalForms) continue;

                const verticalChar = verticalizedCharacterMap[char];
                if (verticalChar) stack[verticalChar] = true;
            }
        }
    }

    populate(features: IndexedFeature[] | FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        this.profile = options.profile;
        if (Array.isArray(features)) {
            this.populateIndexedFeatures(features, options, canonical);
        } else {
            this.populateFeatureTable(features, options, canonical);
        }
    }

    private populateIndexedFeatures(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
        const populateFeaturesStart = options.profile ? performance.now() : 0;
        const layer = this.layers[0];
        const layout = layer.layout;

        const textFont = layout.get('text-font');
        const textField = layout.get('text-field');
        const iconImage = layout.get('icon-image');
        const hasText =
            (textField.value.kind !== 'constant' ||
                (textField.value.value instanceof Formatted && !textField.value.value.isEmpty()) ||
                textField.value.value.toString().length > 0) &&
            (textFont.value.kind !== 'constant' || textFont.value.value.length > 0);
        // we should always resolve the icon-image value if the property was defined in the style
        // this allows us to fire the styleimagemissing event if image evaluation returns null
        // the only way to distinguish between null returned from a coalesce statement with no valid images
        // and null returned because icon-image wasn't defined is to check whether or not iconImage.parameters is an empty object
        const hasIcon = iconImage.value.kind !== 'constant' || !!iconImage.value.value || Object.keys(iconImage.parameters).length > 0;
        const symbolSortKey = layout.get('symbol-sort-key');

        this.features = [];

        if (!hasText && !hasIcon) {
            return;
        }

        const icons = options.iconDependencies;
        const stacks = options.glyphDependencies;
        const availableImages = options.availableImages;
        const globalProperties = new EvaluationParameters(this.zoom);

        for (const {feature, id, index, sourceLayerIndex} of features) {

            const needGeometry = layer._featureFilter.needGeometry;
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);
            if (!options.skipLayerFeatureFilter && !layer._featureFilter.filter(globalProperties, evaluationFeature, canonical)) {
                continue;
            }

            if (!needGeometry)  evaluationFeature.geometry = loadGeometry(feature);

            let text: Formatted | void;
            if (hasText) {
                // Expression evaluation will automatically coerce to Formatted
                // but plain string token evaluation skips that pathway so do the
                // conversion here.
                const resolvedTokens = layer.getValueAndResolveTokens('text-field', evaluationFeature, canonical, availableImages);
                const formattedText = Formatted.factory(resolvedTokens);

                this.hasRTLText ||= containsRTLText(formattedText);
                text = transformText(formattedText, layer, evaluationFeature);
            }

            let icon: ResolvedImage;
            if (hasIcon) {
                // Expression evaluation will automatically coerce to Image
                // but plain string token evaluation skips that pathway so do the
                // conversion here.
                const resolvedTokens = layer.getValueAndResolveTokens('icon-image', evaluationFeature, canonical, availableImages);
                if (resolvedTokens instanceof ResolvedImage) {
                    icon = resolvedTokens;
                } else {
                    icon = ResolvedImage.fromString(resolvedTokens);
                }
            }

            if (!text && !icon) {
                continue;
            }
            const sortKey = this.sortFeaturesByKey ?
                symbolSortKey.evaluate(evaluationFeature, {}, canonical) :
                undefined;

            const symbolFeature: SymbolFeature = {
                id,
                text,
                icon,
                index,
                sourceLayerIndex,
                geometry: evaluationFeature.geometry,
                properties: feature.properties,
                type: VectorTileFeature.types[feature.type],
                sortKey
            };
            this.features.push(symbolFeature);

            if (icon) {
                icons[icon.name] = true;
            }

            if (text) {
                const fontStack = textFont.evaluate(evaluationFeature, {}, canonical).join(',');
                const textAlongLine = layout.get('text-rotation-alignment') !== 'viewport' && layout.get('symbol-placement') !== 'point';
                this.allowVerticalPlacement = this.writingModes?.includes(WritingMode.vertical);
                const doesAllowVerticalWritingMode = allowsVerticalWritingMode(text.toString());
                this.calculateGlyphDependencies(text, stacks, fontStack, textAlongLine, doesAllowVerticalWritingMode);

                for (const section of text.sections) {
                    if (section.image) icons[section.image.name] = true;
                }
            }
        }

        if (options.profile) {
            recordParseProfile(options.profile, {
                phase: 'symbol.filterProperties',
                duration: performance.now() - populateFeaturesStart,
                encoding: 'mvt',
                sourceLayerId: this.sourceID,
                layerId: layer.id,
                layerType: 'symbol',
                featureCount: features.length,
            });
        }

        if (layout.get('symbol-placement') === 'line') {
            // Merge adjacent lines with the same text to improve labelling.
            // It's better to place labels on one long line than on many short segments.
            const mergeStart = options.profile ? performance.now() : 0;
            this.features = mergeLines(this.features);
            if (options.profile) {
                recordParseProfile(options.profile, {
                    phase: 'symbol.mergeLines',
                    duration: performance.now() - mergeStart,
                    encoding: 'mvt',
                    sourceLayerId: this.sourceID,
                    layerId: layer.id,
                    layerType: 'symbol',
                    featureCount: features.length,
                });
            }
        }

        if (this.sortFeaturesByKey) {
            this.features.sort((a, b) => {
                // a.sortKey is always a number when sortFeaturesByKey is true
                return (a.sortKey as number) - (b.sortKey as number);
            });
        }
    }

    private populateFeatureTable(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        const populateFeaturesStart = options.profile ? performance.now() : 0;
        this._featureStateFeatureTable = featureTable;
        this._featureStateIdResolver = (featureIndex) => options.featureIndex.getMltId(featureTable, featureIndex, featureTable.name);
        const layer = this.layers[0];
        const layout = layer.layout;

        const textFont = layout.get('text-font');
        const textField = layout.get('text-field');
        const iconImage = layout.get('icon-image');
        const hasText =
            (textField.value.kind !== 'constant' ||
                (textField.value.value instanceof Formatted && !textField.value.value.isEmpty()) ||
                textField.value.value.toString().length > 0) &&
            (textFont.value.kind !== 'constant' || textFont.value.value.length > 0);
        const hasIcon = iconImage.value.kind !== 'constant' || !!iconImage.value.value || Object.keys(iconImage.parameters).length > 0;
        const symbolSortKey = layout.get('symbol-sort-key');

        this.features = [];

        if (!hasText && !hasIcon) {
            return;
        }

        const icons = options.iconDependencies;
        const stacks = options.glyphDependencies;
        const availableImages = options.availableImages;
        const resolvedImageCache = new Map<string, ResolvedImage>();
        const filterSpecification = layer.filter as any;
        const selectionVector = filterSpecification ? filter(featureTable, filterSpecification, layer.getGlobalState(), canonical, new EvaluationParameters(this.zoom)) : createSelectionVector(featureTable.numFeatures);
        const scaleFactor = EXTENT / featureTable.extent;
        const serializedLayout = layer.serialize().layout ?? {};
        const textFieldPropertyName = getSimpleGetExpressionPropertyName(serializedLayout['text-field']);
        const iconImagePropertyName = getSimpleGetExpressionPropertyName(serializedLayout['icon-image']);
        const symbolSortKeyPropertyName = getSimpleGetExpressionPropertyName(serializedLayout['symbol-sort-key']);
        const textFieldPropertyVector = hasText && textFieldPropertyName ? featureTable.getPropertyVector(textFieldPropertyName) : undefined;
        const iconImagePropertyVector = hasIcon && iconImagePropertyName ? featureTable.getPropertyVector(iconImagePropertyName) : undefined;
        const symbolSortKeyPropertyVector = this.sortFeaturesByKey && symbolSortKeyPropertyName ? featureTable.getPropertyVector(symbolSortKeyPropertyName) : undefined;
        const symbolPlacement = layout.get('symbol-placement');
        const usePointPlacement = symbolPlacement === 'point';
        const useLinePlacement = symbolPlacement === 'line' || symbolPlacement === 'line-center';
        const columnarEvaluationFeature = new ColumnarEvaluationFeature(
            featureTable,
            this.getColumnarSymbolPropertyDependencies(layer),
        );

        for (let i = 0; i < selectionVector.limit; i++) {
            const featureIndex = Number(selectionVector.getIndex(i));
            const id = featureTable.idVector ? normalizeMltFeatureId(featureTable.idVector.getValue(featureIndex), featureIndex) : featureIndex;
            const geometryType = featureTable.geometryVector.geometryType(featureIndex);
            const evaluationType = this.toEvaluationType(geometryType);
            const symbolType = this.toSymbolType(geometryType);
            const useColumnarGeometry = (
                usePointPlacement && symbolType !== 'Unknown' ||
                useLinePlacement && symbolType !== 'Unknown'
            ) &&
                (options.skipLayerFeatureFilter || !layer._featureFilter.needGeometry);
            const geometry = useColumnarGeometry
                ? emptySymbolGeometry
                : this.createLazyFeatureGeometry(featureTable, featureIndex, scaleFactor);
            const evaluationFeature = {
                type: evaluationType,
                id,
                properties: columnarEvaluationFeature.setIndex(featureIndex).properties,
                geometry
            };

            let text: Formatted | void;
            if (hasText) {
                const resolvedTokens = textFieldPropertyVector
                    ? (
                        textFieldPropertyVector.has(featureIndex)
                            ? normalizeColumnarValue(textFieldPropertyVector.getValue(featureIndex))
                            : undefined
                    )
                    : layer.getValueAndResolveTokens('text-field', evaluationFeature, canonical, availableImages);
                const formattedText = Formatted.factory(resolvedTokens);

                this.hasRTLText ||= containsRTLText(formattedText);
                text = transformText(formattedText, layer, evaluationFeature);
            }

            let icon: ResolvedImage;
            if (hasIcon) {
                const resolvedTokens = iconImagePropertyVector
                    ? (
                        iconImagePropertyVector.has(featureIndex)
                            ? normalizeColumnarValue(iconImagePropertyVector.getValue(featureIndex))
                            : undefined
                    )
                    : layer.getValueAndResolveTokens('icon-image', evaluationFeature, canonical, availableImages);
                if (resolvedTokens instanceof ResolvedImage) {
                    icon = resolvedTokens;
                } else {
                    icon = resolvedImageCache.get(resolvedTokens);
                    if (!icon) {
                        icon = ResolvedImage.fromString(resolvedTokens);
                        resolvedImageCache.set(resolvedTokens, icon);
                    }
                }
            }

            if (!text && !icon) {
                continue;
            }

            const sortKey = this.sortFeaturesByKey ?
                (
                    symbolSortKeyPropertyVector
                        ? (
                            symbolSortKeyPropertyVector.has(featureIndex)
                                ? normalizeColumnarValue(symbolSortKeyPropertyVector.getValue(featureIndex)) as number
                                : undefined
                        )
                        : symbolSortKey.evaluate(evaluationFeature, {}, canonical)
                ) :
                undefined;

            const symbolFeature = new ColumnarSymbolFeature({
                id,
                text,
                icon,
                index: featureIndex,
                sourceLayerIndex: this.sourceLayerIndex,
                geometry,
                columnarFeatureTable: useColumnarGeometry ? featureTable : undefined,
                type: symbolType,
                sortKey,
            }, columnarEvaluationFeature);
            this.features.push(symbolFeature);

            if (icon) {
                icons[icon.name] = true;
            }

            if (text) {
                const fontStack = textFont.evaluate(evaluationFeature, {}, canonical).join(',');
                const textAlongLine = layout.get('text-rotation-alignment') !== 'viewport' && layout.get('symbol-placement') !== 'point';
                this.allowVerticalPlacement = this.writingModes?.includes(WritingMode.vertical);
                const doesAllowVerticalWritingMode = allowsVerticalWritingMode(text.toString());
                this.calculateGlyphDependencies(text, stacks, fontStack, textAlongLine, doesAllowVerticalWritingMode);
                for (const section of text.sections) {
                    if (section.image) icons[section.image.name] = true;
                }
            }
        }

        if (options.profile) {
            recordParseProfile(options.profile, {
                phase: 'symbol.filterProperties',
                duration: performance.now() - populateFeaturesStart,
                encoding: 'mlt',
                sourceLayerId: featureTable.name,
                layerId: layer.id,
                layerType: 'symbol',
                featureCount: selectionVector.limit,
            });
        }

        if (layout.get('symbol-placement') === 'line') {
            const mergeStart = options.profile ? performance.now() : 0;
            this.features = mergeLines(this.features);
            if (options.profile) {
                recordParseProfile(options.profile, {
                    phase: 'symbol.mergeLines',
                    duration: performance.now() - mergeStart,
                    encoding: 'mlt',
                    sourceLayerId: featureTable.name,
                    layerId: layer.id,
                    layerType: 'symbol',
                    featureCount: selectionVector.limit,
                });
            }
        }

        if (this.sortFeaturesByKey) {
            this.features.sort((a, b) => {
                return (a.sortKey as number) - (b.sortKey as number);
            });
        }
    }

    private getColumnarSymbolPropertyDependencies(layer: SymbolStyleLayer): Set<string> | null {
        const neededProperties = new Set<string>();
        const serializedLayer = layer.serialize();

        for (const value of Object.values(serializedLayer.layout ?? {})) {
            if (!collectExpressionPropertyDependencies(value, neededProperties)) return null;
        }

        if (layer.filter !== undefined && !collectFilterPropertyDependencies(layer.filter, neededProperties)) {
            return null;
        }

        const textPaintDependencies = new ProgramConfigurationSet(this.layers, this.zoom, property => property.startsWith('text')).getFeaturePropertyDependencies();
        if (textPaintDependencies === null) return null;
        for (const propertyName of textPaintDependencies) {
            neededProperties.add(propertyName);
        }

        const iconPaintDependencies = new ProgramConfigurationSet(this.layers, this.zoom, property => property.startsWith('icon')).getFeaturePropertyDependencies();
        if (iconPaintDependencies === null) return null;
        for (const propertyName of iconPaintDependencies) {
            neededProperties.add(propertyName);
        }

        return neededProperties;
    }

    private createLazyFeatureGeometry(featureTable: FeatureTable, featureIndex: number, scaleFactor: number): Point[][] {
        let geometry: Point[][] | undefined;
        const load = () => {
            geometry ||= loadFeatureGeometry(featureTable, featureIndex, scaleFactor);
            return geometry;
        };

        return new Proxy([], {
            get(target, prop, receiver) {
                if (prop === 'length') {
                    return load().length;
                }
                if (prop === Symbol.iterator) {
                    return load()[Symbol.iterator].bind(load());
                }
                if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                    return load()[Number(prop)];
                }
                const value = Reflect.get(load(), prop, receiver);
                return typeof value === 'function' ? value.bind(load()) : value;
            },
            set(_target, prop, value) {
                geometry ||= loadFeatureGeometry(featureTable, featureIndex, scaleFactor);
                geometry[prop as any] = value;
                return true;
            }
        }) as Point[][];
    }

    private toEvaluationType(geometryType: number): 0 | 1 | 2 | 3 {
        switch (geometryType) {
            case GEOMETRY_TYPE.POINT:
            case GEOMETRY_TYPE.MULTIPOINT:
                return 1;
            case GEOMETRY_TYPE.LINESTRING:
            case GEOMETRY_TYPE.MULTILINESTRING:
                return 2;
            case GEOMETRY_TYPE.POLYGON:
            case GEOMETRY_TYPE.MULTIPOLYGON:
                return 3;
            default:
                return 0;
        }
    }

    private toSymbolType(geometryType: number): SymbolFeature['type'] {
        switch (geometryType) {
            case GEOMETRY_TYPE.POINT:
            case GEOMETRY_TYPE.MULTIPOINT:
                return 'Point';
            case GEOMETRY_TYPE.LINESTRING:
            case GEOMETRY_TYPE.MULTILINESTRING:
                return 'LineString';
            case GEOMETRY_TYPE.POLYGON:
            case GEOMETRY_TYPE.MULTIPOLYGON:
                return 'Polygon';
            default:
                return 'Unknown';
        }
    }

    update(states: FeatureStates, layerData: VectorTileLayerLike | undefined, imagePositions: {[_: string]: ImagePosition}, _dashPositions?: Record<string, DashEntry>): void {
        const vtLayer = this.isColumnar ? undefined : layerData;
        if (!this.stateDependentLayers.length) return;
        this.text.programConfigurations.updatePaintArrays(states, vtLayer, this.layers, {
            imagePositions
        });
        this.icon.programConfigurations.updatePaintArrays(states, vtLayer, this.layers, {
            imagePositions
        });
    }

    prepareColumnarFeatureStateData(): void {
        if (!this.isColumnar || !this._featureStateFeatureTable || !this._featureStateIdResolver) return;
        this.text.programConfigurations.prepareColumnarFeatureStateData(this._featureStateFeatureTable, this._featureStateIdResolver);
        this.icon.programConfigurations.prepareColumnarFeatureStateData(this._featureStateFeatureTable, this._featureStateIdResolver);
        this._featureStateFeatureTable = undefined;
        this._featureStateIdResolver = undefined;
    }

    releaseColumnarLayoutData(): void {
        if (!this.isColumnar) return;
        for (const feature of this.features) {
            feature.geometry = emptySymbolGeometry;
            feature.columnarFeatureTable = undefined;
            feature.columnarLineSlices = undefined;
            feature.columnarEvaluationFeature = undefined;
        }
    }

    canUpdateFeatureStateWithoutVtLayer(): boolean {
        return this.isColumnar &&
            this.text.programConfigurations.canUpdatePaintArraysWithoutVtLayer() &&
            this.icon.programConfigurations.canUpdatePaintArraysWithoutVtLayer();
    }

    addFeatures({options, canonical, glyphMap, glyphPositions, iconMap, iconPositions, showCollisionBoxes}: BucketDependencyParameters): void {
        performSymbolLayout({
            bucket: this,
            glyphMap,
            glyphPositions,
            imageMap: iconMap,
            imagePositions: iconPositions,
            showCollisionBoxes,
            canonical,
            subdivisionGranularity: options.subdivisionGranularity,
            hasPromoteId: options.featureIndex.promoteId != null
        });
    }

    isEmpty(): boolean {
        return this.symbolInstances.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.text.programConfigurations.needsUpload || this.icon.programConfigurations.needsUpload;
    }

    upload(context: Context): void {
        if (!this.uploaded && this.hasDebugData()) {
            this.textCollisionBox.upload(context);
            this.iconCollisionBox.upload(context);
        }
        this.text.upload(context, this.sortFeaturesByY, !this.uploaded, this.text.programConfigurations.needsUpload);
        this.icon.upload(context, this.sortFeaturesByY, !this.uploaded, this.icon.programConfigurations.needsUpload);
        this.uploaded = true;
    }

    destroyDebugData(): void {
        this.textCollisionBox.destroy();
        this.iconCollisionBox.destroy();
    }

    destroy(): void {
        this.text.destroy();
        this.icon.destroy();

        if (this.hasDebugData()) {
            this.destroyDebugData();
        }
    }

    addToLineVertexArray(anchor: Anchor, line: SymbolLine): {lineStartIndex: number; lineLength: number} {
        const profileStart = this.profile ? performance.now() : 0;
        const lineStartIndex = this.lineVertexArray.length;
        if (anchor.segment !== undefined) {
            const pointCount = getSymbolLinePointCount(line);
            this.lineVertexArray.resize(lineStartIndex + pointCount);

            if (isFlatSymbolLine(line)) {
                const segment = anchor.segment;
                let sumForwardLength = getCoordinateDistance(anchor.x, anchor.y, line[(segment + 1) * 2], line[(segment + 1) * 2 + 1]);
                let sumBackwardLength = getCoordinateDistance(anchor.x, anchor.y, line[segment * 2], line[segment * 2 + 1]);

                for (let i = segment + 1; i < pointCount; i++) {
                    const offset = i * 2;
                    const x = line[offset];
                    const y = line[offset + 1];
                    this.lineVertexArray.emplace(lineStartIndex + i, x, y, sumForwardLength);
                    if (i < pointCount - 1) {
                        const nextOffset = offset + 2;
                        sumForwardLength += getCoordinateDistance(line[nextOffset], line[nextOffset + 1], x, y);
                    }
                }

                for (let i = segment; i >= 0; i--) {
                    const offset = i * 2;
                    const x = line[offset];
                    const y = line[offset + 1];
                    this.lineVertexArray.emplace(lineStartIndex + i, x, y, sumBackwardLength);
                    if (i > 0) {
                        const previousOffset = offset - 2;
                        sumBackwardLength += getCoordinateDistance(line[previousOffset], line[previousOffset + 1], x, y);
                    }
                }
            } else {
                const segment = anchor.segment;
                let sumForwardLength = anchor.dist(line[segment + 1]);
                let sumBackwardLength = anchor.dist(line[segment]);

                for (let i = segment + 1; i < pointCount; i++) {
                    const point = line[i];
                    this.lineVertexArray.emplace(lineStartIndex + i, point.x, point.y, sumForwardLength);
                    if (i < pointCount - 1) sumForwardLength += line[i + 1].dist(point);
                }

                for (let i = segment; i >= 0; i--) {
                    const point = line[i];
                    this.lineVertexArray.emplace(lineStartIndex + i, point.x, point.y, sumBackwardLength);
                    if (i > 0) sumBackwardLength += line[i - 1].dist(point);
                }
            }
        }
        const result = {
            lineStartIndex,
            lineLength: this.lineVertexArray.length - lineStartIndex
        };
        if (this.profile) {
            recordParseProfile(this.profile, {
                phase: 'symbol.lineVertexWrite',
                duration: performance.now() - profileStart,
                encoding: this.isColumnar ? 'mlt' : 'mvt',
                sourceLayerId: this.sourceID,
                layerId: this.layers[0].id,
                layerType: 'symbol',
                featureCount: 1,
            });
        }
        return result;
    }

    addSymbols(arrays: SymbolBuffers,
        quads: SymbolQuad[],
        sizeVertex: any,
        lineOffset: [number, number],
        alongLine: boolean,
        feature: SymbolFeature,
        writingMode: WritingMode,
        labelAnchor: Anchor,
        lineStartIndex: number,
        lineLength: number,
        associatedIconIndex: number,
        canonical: CanonicalTileID,
        elevation: number): void {
        const indexArray = arrays.indexArray;
        const layoutVertexArray = arrays.layoutVertexArray;

        const segment = arrays.segments.prepareSegment(4 * quads.length, layoutVertexArray, indexArray, this.canOverlap ? feature.sortKey as number : undefined);
        const glyphOffsetArrayStart = this.glyphOffsetArray.length;
        const vertexStartIndex = segment.vertexLength;

        const angle = (this.allowVerticalPlacement && writingMode === WritingMode.vertical) ? Math.PI / 2 : 0;

        const sections = feature.text && feature.text.sections;

        for (let i = 0; i < quads.length; i++) {
            const {tl, tr, bl, br, tex, pixelOffsetTL, pixelOffsetBR, minFontScaleX, minFontScaleY, glyphOffset, isSDF, sectionIndex} = quads[i];
            const index = segment.vertexLength;

            const y = glyphOffset[1];
            addVertex(layoutVertexArray, labelAnchor.x, labelAnchor.y, tl.x, y + tl.y, tex.x, tex.y, sizeVertex, isSDF, pixelOffsetTL.x, pixelOffsetTL.y, minFontScaleX, minFontScaleY, elevation);
            addVertex(layoutVertexArray, labelAnchor.x, labelAnchor.y, tr.x, y + tr.y, tex.x + tex.w, tex.y, sizeVertex, isSDF, pixelOffsetBR.x, pixelOffsetTL.y, minFontScaleX, minFontScaleY, elevation);
            addVertex(layoutVertexArray, labelAnchor.x, labelAnchor.y, bl.x, y + bl.y, tex.x, tex.y + tex.h, sizeVertex, isSDF, pixelOffsetTL.x, pixelOffsetBR.y, minFontScaleX, minFontScaleY, elevation);
            addVertex(layoutVertexArray, labelAnchor.x, labelAnchor.y, br.x, y + br.y, tex.x + tex.w, tex.y + tex.h, sizeVertex, isSDF, pixelOffsetBR.x, pixelOffsetBR.y, minFontScaleX, minFontScaleY, elevation);

            addDynamicAttributes(arrays.dynamicLayoutVertexArray, labelAnchor, angle);

            indexArray.emplaceBack(index, index + 2, index + 1);
            indexArray.emplaceBack(index + 1, index + 2, index + 3);

            segment.vertexLength += 4;
            segment.primitiveLength += 2;

            this.glyphOffsetArray.emplaceBack(glyphOffset[0]);

            if (i === quads.length - 1 || sectionIndex !== quads[i + 1].sectionIndex) {
                arrays.programConfigurations.populatePaintArrays(layoutVertexArray.length, feature, feature.index, {imagePositions: {}, canonical, formattedSection: sections?.[sectionIndex]});
            }
        }

        arrays.placedSymbolArray.emplaceBack(
            labelAnchor.x, labelAnchor.y,
            glyphOffsetArrayStart,
            this.glyphOffsetArray.length - glyphOffsetArrayStart,
            vertexStartIndex,
            lineStartIndex,
            lineLength,
            labelAnchor.segment,
            sizeVertex ? sizeVertex[0] : 0,
            sizeVertex ? sizeVertex[1] : 0,
            lineOffset[0], lineOffset[1],
            writingMode,
            // placedOrientation is null initially; will be updated to horizontal(1)/vertical(2) if placed
            0,
            false as unknown as number,
            // The crossTileID is only filled/used on the foreground for dynamic text anchors
            0,
            associatedIconIndex,
            elevation
        );
    }

    _addCollisionDebugVertex(layoutVertexArray: StructArray, collisionVertexArray: StructArray, point: Point, anchorX: number, anchorY: number, extrude: Point): number {
        collisionVertexArray.emplaceBack(0, 0);
        return layoutVertexArray.emplaceBack(
            // pos
            point.x,
            point.y,
            // a_anchor_pos
            anchorX,
            anchorY,
            // extrude
            Math.round(extrude.x),
            Math.round(extrude.y));
    }

    addCollisionDebugVertices(x1: number, y1: number, x2: number, y2: number, arrays: CollisionBuffers, boxAnchorPoint: Point, symbolInstance: SymbolInstance): void {
        const segment = arrays.segments.prepareSegment(4, arrays.layoutVertexArray, arrays.indexArray);
        const index = segment.vertexLength;

        const layoutVertexArray = arrays.layoutVertexArray;
        const collisionVertexArray = arrays.collisionVertexArray;

        const anchorX = symbolInstance.anchorX;
        const anchorY = symbolInstance.anchorY;

        this._addCollisionDebugVertex(layoutVertexArray, collisionVertexArray, boxAnchorPoint, anchorX, anchorY, new Point(x1, y1));
        this._addCollisionDebugVertex(layoutVertexArray, collisionVertexArray, boxAnchorPoint, anchorX, anchorY, new Point(x2, y1));
        this._addCollisionDebugVertex(layoutVertexArray, collisionVertexArray, boxAnchorPoint, anchorX, anchorY, new Point(x2, y2));
        this._addCollisionDebugVertex(layoutVertexArray, collisionVertexArray, boxAnchorPoint, anchorX, anchorY, new Point(x1, y2));

        segment.vertexLength += 4;

        const indexArray = arrays.indexArray as LineIndexArray;
        indexArray.emplaceBack(index, index + 1);
        indexArray.emplaceBack(index + 1, index + 2);
        indexArray.emplaceBack(index + 2, index + 3);
        indexArray.emplaceBack(index + 3, index);

        segment.primitiveLength += 4;
    }

    addDebugCollisionBoxes(startIndex: number, endIndex: number, symbolInstance: SymbolInstance, isText: boolean): void {
        for (let b = startIndex; b < endIndex; b++) {
            const box: CollisionBox = this.collisionBoxArray.get(b);
            const x1 = box.x1;
            const y1 = box.y1;
            const x2 = box.x2;
            const y2 = box.y2;

            this.addCollisionDebugVertices(x1, y1, x2, y2,
                isText ? this.textCollisionBox : this.iconCollisionBox,
                box.anchorPoint, symbolInstance);
        }
    }

    generateCollisionDebugBuffers(): void {
        if (this.hasDebugData()) {
            this.destroyDebugData();
        }

        this.textCollisionBox = new CollisionBuffers(CollisionBoxLayoutArray, collisionBoxLayout.members, LineIndexArray);
        this.iconCollisionBox = new CollisionBuffers(CollisionBoxLayoutArray, collisionBoxLayout.members, LineIndexArray);

        for (let i = 0; i < this.symbolInstances.length; i++) {
            const symbolInstance = this.symbolInstances.get(i);
            this.addDebugCollisionBoxes(symbolInstance.textBoxStartIndex, symbolInstance.textBoxEndIndex, symbolInstance, true);
            this.addDebugCollisionBoxes(symbolInstance.verticalTextBoxStartIndex, symbolInstance.verticalTextBoxEndIndex, symbolInstance, true);
            this.addDebugCollisionBoxes(symbolInstance.iconBoxStartIndex, symbolInstance.iconBoxEndIndex, symbolInstance, false);
            this.addDebugCollisionBoxes(symbolInstance.verticalIconBoxStartIndex, symbolInstance.verticalIconBoxEndIndex, symbolInstance, false);
        }
    }

    // These flat arrays are meant to be quicker to iterate over than the source
    // CollisionBoxArray
    _deserializeCollisionBoxesForSymbol(
        collisionBoxArray: CollisionBoxArray,
        textStartIndex: number,
        textEndIndex: number,
        verticalTextStartIndex: number,
        verticalTextEndIndex: number,
        iconStartIndex: number,
        iconEndIndex: number,
        verticalIconStartIndex: number,
        verticalIconEndIndex: number
    ): CollisionArrays {

        const collisionArrays = {} as CollisionArrays;
        for (let k = textStartIndex; k < textEndIndex; k++) {
            const box: CollisionBox = collisionBoxArray.get(k);
            collisionArrays.textBox = {x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, anchorPointX: box.anchorPointX, anchorPointY: box.anchorPointY};
            collisionArrays.textFeatureIndex = box.featureIndex;
            break; // Only one box allowed per instance
        }
        for (let k = verticalTextStartIndex; k < verticalTextEndIndex; k++) {
            const box: CollisionBox = collisionBoxArray.get(k);
            collisionArrays.verticalTextBox = {x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, anchorPointX: box.anchorPointX, anchorPointY: box.anchorPointY};
            collisionArrays.verticalTextFeatureIndex = box.featureIndex;
            break; // Only one box allowed per instance
        }
        for (let k = iconStartIndex; k < iconEndIndex; k++) {
            // An icon can only have one box now, so this indexing is a bit vestigial...
            const box: CollisionBox = collisionBoxArray.get(k);
            collisionArrays.iconBox = {x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, anchorPointX: box.anchorPointX, anchorPointY: box.anchorPointY};
            collisionArrays.iconFeatureIndex = box.featureIndex;
            break; // Only one box allowed per instance
        }
        for (let k = verticalIconStartIndex; k < verticalIconEndIndex; k++) {
            // An icon can only have one box now, so this indexing is a bit vestigial...
            const box: CollisionBox = collisionBoxArray.get(k);
            collisionArrays.verticalIconBox = {x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, anchorPointX: box.anchorPointX, anchorPointY: box.anchorPointY};
            collisionArrays.verticalIconFeatureIndex = box.featureIndex;
            break; // Only one box allowed per instance
        }
        return collisionArrays;
    }

    deserializeCollisionBoxes(collisionBoxArray: CollisionBoxArray): void {
        this.collisionArrays = [];
        for (let i = 0; i < this.symbolInstances.length; i++) {
            const symbolInstance = this.symbolInstances.get(i);
            this.collisionArrays.push(this._deserializeCollisionBoxesForSymbol(
                collisionBoxArray,
                symbolInstance.textBoxStartIndex,
                symbolInstance.textBoxEndIndex,
                symbolInstance.verticalTextBoxStartIndex,
                symbolInstance.verticalTextBoxEndIndex,
                symbolInstance.iconBoxStartIndex,
                symbolInstance.iconBoxEndIndex,
                symbolInstance.verticalIconBoxStartIndex,
                symbolInstance.verticalIconBoxEndIndex
            ));
        }
    }

    hasTextData(): boolean {
        return this.text.segments.get().length > 0;
    }

    hasIconData(): boolean {
        return this.icon.segments.get().length > 0;
    }

    hasDebugData(): boolean {
        return !!(this.textCollisionBox && this.iconCollisionBox);
    }

    hasTextCollisionBoxData(): boolean {
        return this.hasDebugData() && this.textCollisionBox.segments.get().length > 0;
    }

    hasIconCollisionBoxData(): boolean {
        return this.hasDebugData() && this.iconCollisionBox.segments.get().length > 0;
    }

    addIndicesForPlacedSymbol(iconOrText: SymbolBuffers, placedSymbolIndex: number): void {
        const placedSymbol = iconOrText.placedSymbolArray.get(placedSymbolIndex);

        const endIndex = placedSymbol.vertexStartIndex + placedSymbol.numGlyphs * 4;
        for (let vertexIndex = placedSymbol.vertexStartIndex; vertexIndex < endIndex; vertexIndex += 4) {
            iconOrText.indexArray.emplaceBack(vertexIndex, vertexIndex + 2, vertexIndex + 1);
            iconOrText.indexArray.emplaceBack(vertexIndex + 1, vertexIndex + 2, vertexIndex + 3);
        }
    }

    getSortedSymbolIndexes(angle: number): number[] {
        if (this.sortedAngle === angle && this.symbolInstanceIndexes !== undefined) {
            return this.symbolInstanceIndexes;
        }
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        const rotatedYs = [];
        const featureIndexes = [];
        const result = [];

        for (let i = 0; i < this.symbolInstances.length; ++i) {
            result.push(i);
            const symbolInstance = this.symbolInstances.get(i);
            rotatedYs.push(Math.round(sin * symbolInstance.anchorX + cos * symbolInstance.anchorY) | 0);
            featureIndexes.push(symbolInstance.featureIndex);
        }

        result.sort((aIndex, bIndex) => {
            return (rotatedYs[aIndex] - rotatedYs[bIndex]) ||
                   (featureIndexes[bIndex] - featureIndexes[aIndex]);
        });

        return result;
    }

    addToSortKeyRanges(symbolInstanceIndex: number, sortKey: number): void {
        const last = this.sortKeyRanges[this.sortKeyRanges.length - 1];
        if (last?.sortKey === sortKey) {
            last.symbolInstanceEnd = symbolInstanceIndex + 1;
        } else {
            this.sortKeyRanges.push({
                sortKey,
                symbolInstanceStart: symbolInstanceIndex,
                symbolInstanceEnd: symbolInstanceIndex + 1
            });
        }
    }

    sortFeatures(angle: number): void {
        if (!this.sortFeaturesByY) return;
        if (this.sortedAngle === angle) return;

        // The current approach to sorting doesn't sort across segments so don't try.
        // Sorting within segments separately seemed not to be worth the complexity.
        if (this.text.segments.get().length > 1 || this.icon.segments.get().length > 1) return;

        // If the symbols are allowed to overlap sort them by their vertical screen position.
        // The index array buffer is rewritten to reference the (unchanged) vertices in the
        // sorted order.

        // To avoid sorting the actual symbolInstance array we sort an array of indexes.
        this.symbolInstanceIndexes = this.getSortedSymbolIndexes(angle);
        this.sortedAngle = angle;

        this.text.indexArray.clear();
        this.icon.indexArray.clear();

        this.featureSortOrder = [];

        for (const i of this.symbolInstanceIndexes) {
            const symbolInstance = this.symbolInstances.get(i);
            this.featureSortOrder.push(symbolInstance.featureIndex);

            const placedTextSymbolIndexes = [
                symbolInstance.rightJustifiedTextSymbolIndex,
                symbolInstance.centerJustifiedTextSymbolIndex,
                symbolInstance.leftJustifiedTextSymbolIndex
            ];
            for (let i = 0; i < placedTextSymbolIndexes.length; i++) {
                const index = placedTextSymbolIndexes[i];
                // Only add a given index the first time it shows up,
                // to avoid duplicate opacity entries when multiple justifications
                // share the same glyphs.
                if (index >= 0 && placedTextSymbolIndexes.indexOf(index) === i) {
                    this.addIndicesForPlacedSymbol(this.text, index);
                }
            }

            if (symbolInstance.verticalPlacedTextSymbolIndex >= 0) {
                this.addIndicesForPlacedSymbol(this.text, symbolInstance.verticalPlacedTextSymbolIndex);
            }

            if (symbolInstance.placedIconSymbolIndex >= 0) {
                this.addIndicesForPlacedSymbol(this.icon, symbolInstance.placedIconSymbolIndex);
            }

            if (symbolInstance.verticalPlacedIconSymbolIndex >= 0) {
                this.addIndicesForPlacedSymbol(this.icon, symbolInstance.verticalPlacedIconSymbolIndex);
            }
        }

        if (this.text.indexBuffer) this.text.indexBuffer.updateData(this.text.indexArray);
        if (this.icon.indexBuffer) this.icon.indexBuffer.updateData(this.icon.indexArray);
    }
}

register('SymbolBucket', SymbolBucket, {
    omit: ['layers', 'collisionBoxArray', 'features', 'compareText', '_featureStateFeatureTable', '_featureStateIdResolver']
} as any);

export {addDynamicAttributes};
