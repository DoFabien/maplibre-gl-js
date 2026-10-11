import {register} from '../../../util/web_worker_transfer';
import {addPatternDependencies, hasPattern} from '../pattern_bucket_features';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {LineBucket} from '../line_bucket';
import {sortSelectionByKey} from './selection_sort';
import {getColumnarFeatureRows} from './evaluation_feature';

import type {FeatureTable} from '@maplibre/mlt';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {BucketParameters, PopulateParameters} from '../../bucket';
import type {LineStyleLayer} from '../../../style/style_layer/line_style_layer';

/**
 * @internal
 * Line bucket of an MLT feature table: the filter selects rows on the columns, and each selected row is added
 * as a vector tile line bucket adds a feature.
 */
export class ColumnarLineBucket extends LineBucket {
    private readonly sourceLayerIndex: number;

    constructor(options: BucketParameters<LineStyleLayer>) {
        super(options);
        this.sourceLayerIndex = options.sourceLayerIndex;
    }

    populateFeatureTable(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        const layer = this.layers[0];
        const hasLinePattern = hasPattern('line', this.layers, options);
        this.hasDependencies = hasLinePattern || this.hasLineDasharray(this.layers);
        const selectionVector = filter(featureTable, layer.filter, layer.getGlobalState(), canonical, new EvaluationParameters(this.zoom));

        const rows = getColumnarFeatureRows(featureTable, this.sourceLayerIndex, options);
        rows.readRows(selectionVector);
        rows.paintValues.addLayers(this.layers);
        const lineSortKey = layer.layout.get('line-sort-key');
        if (!lineSortKey.isConstant()) {
            sortSelectionByKey(selectionVector, index => rows.evaluate(lineSortKey, index, canonical));
        }

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            const bucketFeature = rows.bucketFeature(index);
            const geometry = bucketFeature.geometry;

            if (this.hasDependencies) {
                if (hasLinePattern) {
                    addPatternDependencies('line', this.layers, bucketFeature, {zoom: this.zoom}, options);
                } else {
                    this.addLineDashDependencies(this.layers, bucketFeature, this.zoom, options);
                }
                this.patternFeatures.push(bucketFeature);
            } else {
                this.addFeature(bucketFeature, geometry, index, canonical, {}, {}, options.subdivisionGranularity);
            }

            options.featureIndex.insert(undefined, geometry, index, this.sourceLayerIndex, this.index);
        }
    }
}

register('ColumnarLineBucket', ColumnarLineBucket, {omit: ['layers', 'patternFeatures']});
