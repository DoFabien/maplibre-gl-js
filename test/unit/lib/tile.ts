import fs from 'fs';
import path from 'path';
import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {OverscaledTileID} from '../../../src/tile/tile_id.ts';
import {FeatureIndex} from '../../../src/data/feature_index.ts';
import {SubdivisionGranularitySetting} from '../../../src/render/subdivision_granularity_settings.ts';

import type {BucketDependencyParameters, IndexedFeature, PopulateParameters} from '../../../src/data/bucket.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

export type CreateBucketParameters = {
    id: string;
    layout?: Record<string, any>;
    paint?: Record<string, any>;
    globalState?: Record<string, any>;
    availableImages?: string[];
};

export function loadVectorTile(name = 'mbsv5-6-18-23.vector.pbf'): VectorTile {
    return new VectorTile(new PbfReader(fs.readFileSync(path.resolve(__dirname, '../../../test/unit/assets', name))));
}

export function getFeaturesFromLayer(sourceLayer: VectorTileLayerLike): IndexedFeature[] {
    const features = new Array<IndexedFeature>(sourceLayer.length);
    for (let i = 0; i < sourceLayer.length; i++) {
        const feature = sourceLayer.feature(i);
        features[i] = {
            feature,
            id: feature.id,
            index: i,
            sourceLayerIndex: 0
        };
    }
    return features;
}

export function createPopulateOptions(availableImages: string[]): PopulateParameters {
    return {
        featureIndex: new FeatureIndex(new OverscaledTileID(0, 0, 0, 0, 0)),
        iconDependencies: {},
        patternDependencies: {},
        glyphDependencies: {},
        dashDependencies: {},
        availableImages,
        subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
    };
}

/** Supplies empty asynchronous resources for bucket tests that only need patterns or dashes. */
export function createBucketDependencies(
    options: PopulateParameters,
    canonical: BucketDependencyParameters['canonical'],
    patternPositions: BucketDependencyParameters['patternPositions'] = {},
    dashPositions: BucketDependencyParameters['dashPositions'] = {},
): BucketDependencyParameters {
    return {options, canonical, patternPositions, dashPositions, patternMap: {},
        glyphMap: {}, glyphPositions: {}, iconMap: {}, iconPositions: {}, showCollisionBoxes: false};
}
