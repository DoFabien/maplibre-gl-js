import Point from '@mapbox/point-geometry';

import type {IGeometryVector, IGpuVector} from '@maplibre/mlt';

export default class VectorUtils{
    private VectorUtils(){}

    static getVertex(geometryVector: IGeometryVector | IGpuVector, index: number): [number, number] {
        if ('getVertex' in geometryVector && typeof geometryVector.getVertex === 'function') {
            return geometryVector.getVertex(index);
        }

        const offset = index * 2;
        return [geometryVector.vertexBuffer[offset], geometryVector.vertexBuffer[offset + 1]];
    }

    static getVertexX(geometryVector: IGeometryVector | IGpuVector, index: number): number {
        if ('mortonSettings' in geometryVector && geometryVector.mortonSettings) {
            return geometryVector.getVertex(index)[0];
        }

        const vertexOffsets = 'vertexOffsets' in geometryVector ? geometryVector.vertexOffsets : undefined;
        const offset = vertexOffsets ? vertexOffsets[index] * 2 : index * 2;
        return geometryVector.vertexBuffer[offset];
    }

    static getVertexY(geometryVector: IGeometryVector | IGpuVector, index: number): number {
        if ('mortonSettings' in geometryVector && geometryVector.mortonSettings) {
            return geometryVector.getVertex(index)[1];
        }

        const vertexOffsets = 'vertexOffsets' in geometryVector ? geometryVector.vertexOffsets : undefined;
        const offset = vertexOffsets ? vertexOffsets[index] * 2 : index * 2;
        return geometryVector.vertexBuffer[offset + 1];
    }

    static equals (x1: number, y1: number, x2: number, y2: number): boolean {
        return x1 === x2 && y1 === y2;
    }

    static equalsVertex(geometryVector: IGeometryVector | IGpuVector, index1: number, index2: number): boolean {
        return VectorUtils.getVertexX(geometryVector, index1) === VectorUtils.getVertexX(geometryVector, index2) &&
            VectorUtils.getVertexY(geometryVector, index1) === VectorUtils.getVertexY(geometryVector, index2);
    }

    static sub(x1: number, y1: number, x2: number, y2: number): Point {
        const x = x1 - x2;
        const y = y1 - y2;
        return new Point(x, y);
    }

    static subPoint(x1: number, y1: number, point: Point): Point {
        const x = x1 - point.x;
        const y = y1 - point.y ;
        return new Point(x, y);
    }

    static dist(x1: number, y1: number, x2: number, y2: number): number {
        const dx = x2 - x1;
        const dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
    }

    static add(x1: number, y1: number, x2: number, y2: number): Point {
        const x = x1 + x2;
        const y = y1 + y2;
        return new Point(x, y);
    }

}
