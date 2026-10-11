import {register} from '../../../util/web_worker_transfer';
import {addPatternDependencies, hasPattern} from '../pattern_bucket_features';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {FillBucket} from '../fill_bucket';
import {sortSelectionByKey} from './selection_sort';
import {getColumnarFeatureRows} from './evaluation_feature';

import type {FeatureTable} from '@maplibre/mlt';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {BucketParameters, PopulateParameters} from '../../bucket';
import type {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';

/**
 * @internal
 * Fill bucket of an MLT feature table: the filter selects rows on the columns, and each selected row is added
 * as a vector tile fill bucket adds a feature.
 */
export class ColumnarFillBucket extends FillBucket {
    private readonly sourceLayerIndex: number;

    constructor(options: BucketParameters<FillStyleLayer>) {
        super(options);
        this.sourceLayerIndex = options.sourceLayerIndex;
    }

    populateFeatureTable(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        const layer = this.layers[0];
        this.hasDependencies = hasPattern('fill', this.layers, options);
        const selectionVector = filter(featureTable, layer.filter, layer.getGlobalState(), canonical, new EvaluationParameters(this.zoom));

        const rows = getColumnarFeatureRows(featureTable, this.sourceLayerIndex, options);
        rows.readRows(selectionVector);
        rows.paintValues.addLayers(this.layers);
        const fillSortKey = layer.layout.get('fill-sort-key');
        if (!fillSortKey.isConstant()) {
            sortSelectionByKey(selectionVector, index => rows.evaluate(fillSortKey, index, canonical, options.availableImages));
        }

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            const bucketFeature = rows.bucketFeature(index);
            const geometry = bucketFeature.geometry;

            if (this.hasDependencies) {
                this.patternFeatures.push(addPatternDependencies('fill', this.layers, bucketFeature, {zoom: this.zoom}, options));
            } else {
                this.addFeature(bucketFeature, geometry, index, canonical, {}, options.subdivisionGranularity);
            }

            options.featureIndex.insert(undefined, geometry, index, this.sourceLayerIndex, this.index);
        }
    }
}

register('ColumnarFillBucket', ColumnarFillBucket, {omit: ['layers', 'patternFeatures']});
