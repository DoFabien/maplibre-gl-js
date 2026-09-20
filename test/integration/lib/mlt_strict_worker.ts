import '../../../src/source/worker.ts';
import {GeometryVector, GpuVector} from '@maplibre/mlt';
import {activateMltMaterializationStats, createMltMaterializationStats, recordMltMaterialization} from '../../../src/util/mlt_materialization_stats.ts';

/** Dedicated render-test worker: strict counters stay active throughout decode, parse and overzoom. */
const stats = createMltMaterializationStats({strict: true});
activateMltMaterializationStats(stats);

/** Fails at the compatibility boundary before an entire geometry column can become Point arrays. */
function rejectGeometryMaterialization(): never {
    recordMltMaterialization('geometryPartsMaterialized', 1, {detail: 'geometryVector.getGeometries()'});
    throw new Error('Forbidden MLT materialization: geometryVector.getGeometries()');
}

GeometryVector.prototype.getGeometries = rejectGeometryMaterialization;
GpuVector.prototype.getGeometries = rejectGeometryMaterialization;
(globalThis as typeof globalThis & {__mltRenderStats: typeof stats}).__mltRenderStats = stats;
