import {createBucketDependencies} from '../../../../test/unit/lib/tile.ts';
import {describe, expect, test, vi} from 'vitest';
import {ColumnarFillBucket} from './columnar_fill_bucket';
import {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';
import {createPopulateOptions} from '../../../../test/unit/lib/tile';
import {CanonicalTileID} from '../../../tile/tile_id';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../../../style/evaluation_parameters';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {BucketParameters} from '../../bucket';

function createColumnarFillBucket(layout?: Record<string, any>, paint?: Record<string, any>): ColumnarFillBucket {
    const layer = new FillStyleLayer({
        id: 'test',
        type: 'fill',
        layout,
        paint
    } as LayerSpecification, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);

    return new ColumnarFillBucket({layers: [layer]} as BucketParameters<FillStyleLayer>);
}

function createTraversableFeatureTable(
    features: Array<Array<Array<{x: number; y: number}>>>,
    propertyValues?: Array<number | null>,
) {
    const flatVertices: Array<{x: number; y: number}> = [];
    const ringOffsets = new Uint32Array(features.flat().length + 1);
    const partOffsets = new Uint32Array(features.length + 1);
    let ringIndex = 0;
    let vertexIndex = 0;

    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
        partOffsets[featureIndex] = ringIndex;
        for (const ring of features[featureIndex]) {
            ringOffsets[ringIndex] = vertexIndex;
            ringIndex++;
            for (const vertex of ring) {
                flatVertices.push(vertex);
                vertexIndex++;
            }
        }
    }
    partOffsets[features.length] = ringIndex;
    ringOffsets[ringIndex] = vertexIndex;

    const getGeometries = vi.fn(() => {
        throw new Error('getGeometries should not be called');
    });
    const propertyVectors = propertyValues ? [{
        name: 'opacity',
        getValue(index: number) {
            return propertyValues[index];
        }
    }] : undefined;

    return {
        numFeatures: features.length,
        extent: 4096,
        geometryVector: {
            topologyVector: {
                partOffsets,
                ringOffsets
            },
            getGeometries
        },
        idVector: {
            getValue(index: number) {
                return [7, 11, 12][index] ?? index;
            }
        },
        propertyVectors,
        getPropertyVector(name: string) {
            return propertyVectors?.find((propertyVector) => propertyVector.name === name);
        },
        forEachFeaturePolygonGeometry(featureIndex: number, visitor: any) {
            visitor(featureIndex, featureIndex, partOffsets[featureIndex], partOffsets[featureIndex + 1], {
                partOffsets,
                ringOffsets
            });
        },
        forEachPolygonRing(_topologyVector: any, firstPartOffset: number, secondPartOffset: number, visitor: any) {
            for (let currentRingIndex = firstPartOffset; currentRingIndex < secondPartOffset; currentRingIndex++) {
                visitor(currentRingIndex, ringOffsets[currentRingIndex], ringOffsets[currentRingIndex + 1]);
            }
        },
        forEachVertexInRange(start: number, end: number, visitor: any) {
            for (let currentVertexIndex = start; currentVertexIndex < end; currentVertexIndex++) {
                const vertex = flatVertices[currentVertexIndex];
                visitor(vertex.x, vertex.y, currentVertexIndex);
            }
        }
    } as any;
}

describe('ColumnarFillBucket', () => {
    test('defers fill-pattern geometry until image positions are available', () => {
        const bucket = createColumnarFillBucket(undefined, {'fill-pattern': 'pattern'});
        const featureTable = createTraversableFeatureTable([
            [[
                {x: 0, y: 0},
                {x: 10, y: 0},
                {x: 10, y: 10},
                {x: 0, y: 10},
                {x: 0, y: 0}
            ]]
        ]);
        const options = createPopulateOptions(['pattern']);

        bucket.populate(featureTable, options, new CanonicalTileID(0, 0, 0));

        expect(options.patternDependencies).toEqual({pattern: true});
        expect(bucket.layoutVertexArray).toHaveLength(0);

        bucket.addFeatures(createBucketDependencies(options, new CanonicalTileID(0, 0, 0), {
            pattern: {
                tlbr: [0, 0, 16, 16],
                pixelRatio: 1
            }
        } as any));

        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(bucket.indexArray.length).toBeGreaterThan(0);
        expect(featureTable.geometryVector.getGeometries).not.toHaveBeenCalled();
    });

    test('sorts selected features by fill-sort-key before geometry processing', () => {
        const bucket = createColumnarFillBucket({'fill-sort-key': ['get', 'sort-key']});
        const addGeometryPolygons = vi.spyOn(bucket as any, 'addGeometryPolygons').mockImplementation(() => {});

        const featureTable = {
            numFeatures: 3,
            extent: 4096,
            geometryVector: {topologyVector: null},
            getPropertyVector(name: string) {
                if (name !== 'sort-key') return undefined;
                return {
                    getValue(index: number) {
                        return [3, 1, 2][index];
                    }
                };
            }
        } as any;

        bucket.populate(featureTable, createPopulateOptions([]), undefined);

        const selectionVector = addGeometryPolygons.mock.calls[0][0] as any;
        expect(Array.from(selectionVector.selectionValues().slice(0, selectionVector.limit))).toEqual([1, 2, 0]);
    });

    test('supports tessellating selected polygons from GPU vectors without getVertex', () => {
        const bucket = createColumnarFillBucket(undefined, {
            'fill-opacity': ['case', ['has', 'opacity'], 0.75, 0.25]
        });
        const featureTable = createTraversableFeatureTable([
            [[
                {x: 0, y: 0},
                {x: 10, y: 0},
                {x: 10, y: 10},
                {x: 0, y: 10},
                {x: 0, y: 0}
            ]],
            [[
                {x: 20, y: 0},
                {x: 28, y: 0},
                {x: 24, y: 8},
                {x: 20, y: 0}
            ]]
        ], [8, null]);

        bucket.populate(featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(bucket.indexArray.length).toBeGreaterThan(0);
        expect(bucket.indexArray2.length).toBeGreaterThan(0);
        expect(bucket.programConfigurations._featureMap.ids).toEqual([7, 11]);
        expect(bucket.featureIndexBBoxes).toEqual([
            [0, 0, 20, 20],
            [40, 0, 56, 16]
        ]);
        expect(featureTable.geometryVector.getGeometries).not.toHaveBeenCalled();
    });
});
