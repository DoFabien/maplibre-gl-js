import fs from 'fs';
import path from 'path';
import {describe, expect, test, vi} from 'vitest';
import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {MLTVectorTile} from './vector_tile_mlt';
import {createConstGeometryVector, createStringFlatVector, FeatureTable, GEOMETRY_TYPE, Int64ConstVector, TopologyVector} from '@maplibre/mlt';
import {GeoJSONFeature} from '../util/vectortile_to_geojson.ts';
import {createSyntheticMltTile, syntheticPolygonLayer} from '../../test/unit/lib/mlt_synthetic.ts';
import {normalizeMltFeatureId} from '../util/mlt_feature_id.ts';

describe('MLTVectorTile layer decode', () => {
    test.each([
        '14-8802-5374',
        '14-8802-5375',
        '14-8803-5374',
        '14-8803-5375',
    ])('matches the public MVT adapter in reverse order for %s', (tileName) => {
        const mvtPath = path.resolve(__dirname, `../../test/integration/assets/tiles/${tileName}.mvt`);
        const mltPath = path.resolve(__dirname, `../../test/integration/assets/tiles/mlt/gl-js/${tileName}.mlt`);
        const mvt = new VectorTile(new PbfReader(fs.readFileSync(mvtPath)));
        const rawMlt = fs.readFileSync(mltPath);
        const mlt = new MLTVectorTile(rawMlt.buffer.slice(rawMlt.byteOffset, rawMlt.byteOffset + rawMlt.byteLength));

        expect(Object.keys(mlt.layers).sort()).toEqual(Object.keys(mvt.layers).sort());
        for (const layerName of Object.keys(mvt.layers)) {
            const mvtLayer = mvt.layers[layerName];
            const mltLayer = mlt.layers[layerName];
            expect(mltLayer).toHaveLength(mvtLayer.length);
            expect(mltLayer.extent).toBe(mvtLayer.extent);

            for (let featureIndex = mvtLayer.length - 1; featureIndex >= 0; featureIndex--) {
                const mvtFeature = mvtLayer.feature(featureIndex);
                const mltFeature = mltLayer.feature(featureIndex);
                expect(mltFeature.type).toBe(mvtFeature.type);
                expect(mltFeature.id).toBe(mvtFeature.id ?? featureIndex);
                expect(Object.entries(mltFeature.properties)).toEqual(Object.entries(mvtFeature.properties));
                expect(mltFeature.loadGeometry().map((part) => part.map(({x, y}) => [x, y])))
                    .toEqual(mvtFeature.loadGeometry().map((part) => part.map(({x, y}) => [x, y])));
            }
        }
    }, 20_000);

    test('matches the public MVT adapter under deterministic pseudo-random access', () => {
        const tileName = '14-8802-5374';
        const mvtPath = path.resolve(__dirname, `../../test/integration/assets/tiles/${tileName}.mvt`);
        const mltPath = path.resolve(__dirname, `../../test/integration/assets/tiles/mlt/gl-js/${tileName}.mlt`);
        const mvt = new VectorTile(new PbfReader(fs.readFileSync(mvtPath)));
        const rawMlt = fs.readFileSync(mltPath);
        const mlt = new MLTVectorTile(rawMlt.buffer.slice(rawMlt.byteOffset, rawMlt.byteOffset + rawMlt.byteLength));
        let randomState = 0x5eed1234;

        for (const layerName of Object.keys(mvt.layers)) {
            const mvtLayer = mvt.layers[layerName];
            const mltLayer = mlt.layers[layerName];
            const featureIndices = Array.from({length: mvtLayer.length}, (_value, index) => index);
            for (let index = featureIndices.length - 1; index > 0; index--) {
                randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
                const swapIndex = randomState % (index + 1);
                [featureIndices[index], featureIndices[swapIndex]] = [featureIndices[swapIndex], featureIndices[index]];
            }

            for (const featureIndex of featureIndices) {
                const mvtFeature = mvtLayer.feature(featureIndex);
                const mltFeature = mltLayer.feature(featureIndex);
                expect(mltFeature.type).toBe(mvtFeature.type);
                expect(mltFeature.id).toBe(mvtFeature.id ?? featureIndex);
                expect(Object.entries(mltFeature.properties)).toEqual(Object.entries(mvtFeature.properties));
                expect(mltFeature.loadGeometry().map((part) => part.map(({x, y}) => [x, y])))
                    .toEqual(mvtFeature.loadGeometry().map((part) => part.map(({x, y}) => [x, y])));
            }
        }
    }, 20_000);

    test('matches the GeoJSON output of MVT across every geometry type', () => {
        const tileName = '14-8802-5374';
        const mvtPath = path.resolve(__dirname, `../../test/integration/assets/tiles/${tileName}.mvt`);
        const mltPath = path.resolve(__dirname, `../../test/integration/assets/tiles/mlt/gl-js/${tileName}.mlt`);
        const mvt = new VectorTile(new PbfReader(fs.readFileSync(mvtPath)));
        const rawMlt = fs.readFileSync(mltPath);
        const mlt = new MLTVectorTile(rawMlt.buffer.slice(rawMlt.byteOffset, rawMlt.byteOffset + rawMlt.byteLength));
        const comparedTypes = new Set<number>();

        for (const layerName of Object.keys(mvt.layers)) {
            const mvtLayer = mvt.layers[layerName];
            const mltLayer = mlt.layers[layerName];
            for (let featureIndex = 0; featureIndex < mvtLayer.length; featureIndex++) {
                const mvtFeature = mvtLayer.feature(featureIndex);
                if (comparedTypes.has(mvtFeature.type)) continue;
                const actual = new GeoJSONFeature(mltLayer.feature(featureIndex), 14, 8802, 5374, undefined).toJSON();
                const expected = new GeoJSONFeature(mvtFeature, 14, 8802, 5374, undefined).toJSON();
                expect(actual.geometry).toEqual(expected.geometry);
                expect(actual.properties).toEqual(expected.properties);
                comparedTypes.add(mvtFeature.type);
            }
        }

        expect([...comparedTypes].sort()).toEqual([1, 2, 3]);
    });

    test('creates layers from eagerly decoded feature tables', () => {
        const tilePath = path.resolve(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-8802-5374.mlt');
        const rawTile = fs.readFileSync(tilePath);
        const tile = new MLTVectorTile(rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength));

        expect(Object.keys(tile.layers).length).toBeGreaterThan(0);

        const layerName = Object.keys(tile.layers)[0];
        const layer: any = tile.layers[layerName];

        expect(layer.name).toBe(layerName);
        expect(layer.extent).toBeGreaterThan(0);
        expect(layer.length).toBeGreaterThan(0);
        expect(layer.featureTable.name).toBe(layerName);
        expect(tile.layers[layerName]).toBe(layer);

        const filteredTile = new MLTVectorTile(
            rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength),
            {layerNames: [layerName]}
        );
        expect(Object.keys(filteredTile.layers)).toEqual([layerName]);

        const skippedTile = new MLTVectorTile(
            rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength),
            {layerNames: ['missing-layer']}
        );
        expect(Object.keys(skippedTile.layers)).toEqual([]);

        const roadTile = new MLTVectorTile(
            rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength),
            {
                layerNames: ['road'],
                propertyColumnNamesByLayer: new Map([['road', new Set(['class'])]])
            }
        );
        expect(Object.keys(roadTile.layers)).toEqual(['road']);
        expect(((roadTile.layers.road as any).featureTable.propertyVectors ?? []).map((propertyVector: any) => propertyVector.name)).toEqual(['class']);

        const deferredRoadTile = new MLTVectorTile(
            rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength),
            {layerNames: ['road'], deferPropertyColumns: true}
        );
        const deferredRoadLayer: any = deferredRoadTile.layers.road;
        expect(deferredRoadLayer.featureTable.propertyVectors).toEqual([]);
        expect(deferredRoadLayer.featureTable.availablePropertyNames).toContain('class');
        expect(deferredRoadLayer.featureTable.getPropertyVector('class')).toBeDefined();
        expect(deferredRoadLayer.featureTable.propertyVectors.map((propertyVector: any) => propertyVector.name)).toEqual(['class']);
        const feature = deferredRoadLayer.feature(0);
        expect(feature.properties).toBeDefined();
        expect(deferredRoadLayer.featureTable.propertyVectors.map((propertyVector: any) => propertyVector.name).sort())
            .toEqual([...deferredRoadLayer.featureTable.availablePropertyNames].sort());
    });

    test('returns the same properties object for repeated reads of a feature', () => {
        const tilePath = path.resolve(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-8802-5374.mlt');
        const rawTile = fs.readFileSync(tilePath);
        const tile = new MLTVectorTile(
            rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength),
            {layerNames: ['road']}
        );

        const feature = tile.layers.road.feature(0);
        const properties = feature.properties;
        expect(feature.properties).toBe(properties);
        expect(feature.loadGeometry().length).toBeGreaterThan(0);
    });

    test('resolves deferred property columns on demand', () => {
        const tilePath = path.resolve(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-8802-5374.mlt');
        const rawTile = fs.readFileSync(tilePath);
        const tile = new MLTVectorTile(
            rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength),
            {layerNames: ['road'], deferPropertyColumns: true},
        );
        const featureTable = (tile.layers.road as any).featureTable as FeatureTable;
        expect(featureTable.getPropertyVector('class')).toBeDefined();
    });

    test('resolves and snapshots public property columns once per layer', () => {
        const tilePath = path.resolve(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-8802-5374.mlt');
        const rawTile = fs.readFileSync(tilePath);
        const tile = new MLTVectorTile(
            rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength),
            {layerNames: ['road'], deferPropertyColumns: true},
        );
        const layer: any = tile.layers.road;
        const materialize = vi.spyOn(layer.featureTable, 'materializePropertyVectors');

        const firstProperties = layer.feature(0).properties;
        const secondProperties = layer.feature(1).properties;

        expect(materialize).toHaveBeenCalledTimes(1);
        expect(Object.keys(firstProperties).length).toBeGreaterThan(0);
        expect(Object.keys(secondProperties).length).toBeGreaterThan(0);
        const propertyName = Object.keys(firstProperties)[0];
        const descriptor = Object.getOwnPropertyDescriptor(firstProperties, propertyName);
        expect(descriptor?.get).toBeUndefined();
        expect(descriptor?.writable).toBe(true);
    });

    test('materializes public values without per-property closures', () => {
        const firstColumn = createStringFlatVector(['one'], 'first');
        const secondColumn = createStringFlatVector(['two'], 'second');
        const firstGetValue = vi.spyOn(firstColumn, 'getValue');
        const secondGetValue = vi.spyOn(secondColumn, 'getValue');
        const featureTable = new FeatureTable(
            'properties-one',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.POINT,
                new TopologyVector(null, null, null),
                null,
                new Int32Array([10, 20]),
            ),
            null,
            [firstColumn, secondColumn],
        );
        const feature = MLTVectorTile.fromFeatureTables([featureTable]).layers['properties-one'].feature(0);

        expect(firstGetValue).not.toHaveBeenCalled();
        expect(secondGetValue).not.toHaveBeenCalled();
        expect(feature.properties.first).toBe('one');
        expect(firstGetValue).toHaveBeenCalledTimes(1);
        expect(secondGetValue).toHaveBeenCalledTimes(1);

        expect(Object.entries(feature.properties)).toEqual([['first', 'one'], ['second', 'two']]);
        expect(firstGetValue).toHaveBeenCalledTimes(1);
        expect(secondGetValue).toHaveBeenCalledTimes(1);

        delete feature.properties.first;
        expect(feature.properties.first).toBeUndefined();
        expect(Object.keys(feature.properties)).toEqual(['second']);
        feature.properties.first = 'replacement';
        expect(feature.properties.first).toBe('replacement');
    });

    test('checks feature bounds and returns independent mutable public graphs', () => {
        const layer = createSyntheticMltTile().layers[syntheticPolygonLayer];

        expect(() => layer.feature(-1)).toThrow('feature index out of bounds');
        expect(() => layer.feature(layer.length)).toThrow('feature index out of bounds');

        const first = layer.feature(0);
        const second = layer.feature(0);
        expect(second).not.toBe(first);
        expect(second.properties).not.toBe(first.properties);
        expect(first.properties).toBe(first.properties);

        const propertyName = Object.keys(first.properties)[0];
        expect(propertyName).toBeDefined();
        const original = second.properties[propertyName];
        first.properties[propertyName] = 'mutated';
        expect(second.properties[propertyName]).toBe(original);

        const firstGeometry = first.loadGeometry();
        const secondGeometry = first.loadGeometry();
        expect(secondGeometry).not.toBe(firstGeometry);
        expect(secondGeometry[0]).not.toBe(firstGeometry[0]);
        expect(secondGeometry[0][0]).not.toBe(firstGeometry[0][0]);
        firstGeometry[0][0].x += 100;
        expect(secondGeometry[0][0].x).not.toBe(firstGeometry[0][0].x);

        const closedRing = secondGeometry.find((part) => part.length > 1 &&
            part[0].x === part[part.length - 1].x && part[0].y === part[part.length - 1].y);
        expect(closedRing).toBeDefined();
        expect(closedRing?.[closedRing.length - 1]).not.toBe(closedRing?.[0]);
    });

    test('normalizes a signed 64-bit id at the public adapter boundary', () => {
        const signedId = -4294967297n;
        const featureTable = new FeatureTable(
            'signed-id',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.POINT,
                new TopologyVector(null, null, null),
                null,
                new Int32Array([10, 20]),
            ),
            new Int64ConstVector('id', signedId, 1, true),
        );

        const feature = MLTVectorTile.fromFeatureTables([featureTable]).layers['signed-id'].feature(0);
        expect(feature.id).toBe(normalizeMltFeatureId(signedId));
    });

});
