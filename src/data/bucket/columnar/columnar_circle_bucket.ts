import {register} from '../../../util/web_worker_transfer';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {CircleBucket} from '../circle_bucket';
import {sortSelectionByKey} from './selection_sort';
import {getColumnarFeatureRows} from './evaluation_feature';

import type {FeatureTable} from '@maplibre/mlt';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {BucketParameters, PopulateParameters} from '../../bucket';
import type {CircleStyleLayer} from '../../../style/style_layer/circle_style_layer';
import type {HeatmapStyleLayer} from '../../../style/style_layer/heatmap_style_layer.ts';

/**
 * @internal
 * Circle bucket of an MLT feature table, also used for heatmaps: the filter selects rows on the columns, and each
 * selected row is added as a vector tile circle bucket adds a feature.
 */
export class ColumnarCircleBucket<Layer extends CircleStyleLayer | HeatmapStyleLayer = CircleStyleLayer> extends CircleBucket<Layer> {
    private readonly sourceLayerIndex: number;

    constructor(options: BucketParameters<Layer>) {
        super(options);
        this.sourceLayerIndex = options.sourceLayerIndex;
    }

    populateFeatureTable(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        const styleLayer = this.layers[0];
        const circleStyle = styleLayer.type === 'circle' ? styleLayer as CircleStyleLayer : undefined;
        const subdivide = styleLayer.type === 'heatmap' || circleStyle?.paint.get('circle-pitch-alignment') === 'map';
        const granularity = subdivide ? options.subdivisionGranularity.circle : 1;
        const selectionVector = filter(featureTable, styleLayer.filter, styleLayer.getGlobalState(), canonical, new EvaluationParameters(this.zoom));

        const rows = getColumnarFeatureRows(featureTable, this.sourceLayerIndex, options);
        rows.readRows(selectionVector);
        rows.paintValues.addLayers(this.layers);
        const circleSortKey = circleStyle?.layout.get('circle-sort-key');
        const sortKeys = circleSortKey && !circleSortKey.isConstant() ?
            sortSelectionByKey(selectionVector, index => rows.evaluate(circleSortKey, index, canonical)) :
            undefined;

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            const bucketFeature = rows.bucketFeature(index, sortKeys?.[i]);
            this.addFeature(bucketFeature, bucketFeature.geometry, index, canonical, granularity);
            options.featureIndex.insert(undefined, bucketFeature.geometry, index, this.sourceLayerIndex, this.index);
        }
    }
}

register('ColumnarCircleBucket', ColumnarCircleBucket, {omit: ['layers']});
