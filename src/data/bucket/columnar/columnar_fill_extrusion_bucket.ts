import {register} from '../../../util/web_worker_transfer';
import {addPatternDependencies, hasPattern} from '../pattern_bucket_features';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {FillExtrusionBucket} from '../fill_extrusion_bucket';
import {getTileUnitsForMeters, roundPolygonCornersIfNeeded} from '../round_polygon_corners';
import {getColumnarFeatureRows} from './evaluation_feature';

import type {FeatureTable} from '@maplibre/mlt';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {BucketParameters, PopulateParameters} from '../../bucket';
import type {FillExtrusionStyleLayer} from '../../../style/style_layer/fill_extrusion_style_layer';

/**
 * @internal
 * Fill extrusion bucket of an MLT feature table: the filter selects rows on the columns, and each selected row
 * is added as a vector tile fill extrusion bucket adds a feature.
 */
export class ColumnarFillExtrusionBucket extends FillExtrusionBucket {
    private readonly sourceLayerIndex: number;

    constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
        super(options);
        this.sourceLayerIndex = options.sourceLayerIndex;
    }

    populateFeatureTable(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        this.features = [];
        this.hasDependencies = hasPattern('fill-extrusion', this.layers, options);
        const layer = this.layers[0];
        const roundedCornerDistanceInMeters = layer.layout.get('fill-extrusion-rounded-corner-distance');
        const roundedCornerDistance = roundedCornerDistanceInMeters > 0 ? getTileUnitsForMeters(roundedCornerDistanceInMeters, canonical) : 0;
        const selectionVector = filter(featureTable, layer.filter, layer.getGlobalState(), canonical, new EvaluationParameters(this.zoom));

        const rows = getColumnarFeatureRows(featureTable, this.sourceLayerIndex, options);
        rows.readRows(selectionVector);
        rows.paintValues.addLayers(this.layers);
        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            const bucketFeature = rows.bucketFeature(index);
            bucketFeature.geometry = roundPolygonCornersIfNeeded(bucketFeature.geometry, roundedCornerDistance);

            if (this.hasDependencies) {
                this.features.push(addPatternDependencies('fill-extrusion', this.layers, bucketFeature, {zoom: this.zoom}, options));
            } else {
                this.addFeature(bucketFeature, bucketFeature.geometry, index, canonical, {}, options.subdivisionGranularity);
            }

            options.featureIndex.insert(undefined, bucketFeature.geometry, index, this.sourceLayerIndex, this.index, true);
        }
    }
}

register('ColumnarFillExtrusionBucket', ColumnarFillExtrusionBucket, {omit: ['layers', 'features']});
