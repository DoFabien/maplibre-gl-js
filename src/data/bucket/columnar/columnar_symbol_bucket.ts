import {register} from '../../../util/web_worker_transfer';
import filter from '../../filter/mlt/filter';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {SymbolBucket} from '../symbol_bucket';
import {getColumnarFeatureRows} from './evaluation_feature';
import {loadFeatureGeometry} from './geometry_traversal';
import {getMltFeatureId} from '../../../util/mlt_feature_id.ts';

import type {FeatureTable} from '@maplibre/mlt';
import type Point from '@mapbox/point-geometry';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {CanonicalTileID} from '../../../tile/tile_id';
import type {BucketFeature, IndexedFeature, PopulateParameters} from '../../bucket';

/** A row of an MLT feature table as a vector tile feature, with the properties the buckets of the parse share. */
class ColumnarRowFeature implements VectorTileFeatureLike {
    readonly id: VectorTileFeatureLike['id'];
    readonly extent: number;

    constructor(private readonly featureTable: FeatureTable, private readonly index: number, readonly type: BucketFeature['type'], readonly properties: Record<string, any>) {
        this.id = getMltFeatureId(featureTable, index);
        this.extent = featureTable.extent;
    }

    loadGeometry(): Point[][] {
        return loadFeatureGeometry(this.featureTable, this.index);
    }
}

/**
 * @internal
 * Symbol bucket of an MLT feature table: the filter selects rows on the columns, and the selected rows are laid out
 * as a vector tile symbol bucket lays out features.
 */
export class ColumnarSymbolBucket extends SymbolBucket {
    populateFeatureTable(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        const layer = this.layers[0];
        const selectionVector = filter(featureTable, layer.filter, layer.getGlobalState(), canonical, new EvaluationParameters(this.zoom));
        const rows = getColumnarFeatureRows(featureTable, this.sourceLayerIndex, options);
        rows.readRows(selectionVector);

        const features: IndexedFeature[] = [];
        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            const {id, type, properties} = rows.row(index);
            features.push({feature: new ColumnarRowFeature(featureTable, index, type, properties), id, index, sourceLayerIndex: this.sourceLayerIndex});
        }
        this.populate(features, options, canonical);
    }
}

register('ColumnarSymbolBucket', ColumnarSymbolBucket, {omit: ['layers', 'collisionBoxArray', 'features', 'compareText']});
