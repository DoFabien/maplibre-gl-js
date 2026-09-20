import type Point from '@mapbox/point-geometry';

/**
 * Symbol placement accepts legacy Point arrays and allocation-light flattened
 * coordinate buffers used by the MLT columnar path.
 */
export type SymbolLine = Point[] | number[];

export function isFlatSymbolLine(line: SymbolLine): line is number[] {
    return line.length === 0 || typeof line[0] === 'number';
}

export function getSymbolLinePointCount(line: SymbolLine): number {
    return isFlatSymbolLine(line) ? line.length / 2 : line.length;
}

export function getSymbolLineX(line: SymbolLine, pointIndex: number): number {
    return isFlatSymbolLine(line) ? line[pointIndex * 2] : line[pointIndex].x;
}

export function getSymbolLineY(line: SymbolLine, pointIndex: number): number {
    return isFlatSymbolLine(line) ? line[pointIndex * 2 + 1] : line[pointIndex].y;
}

export function getSymbolLineDistance(line: SymbolLine, firstIndex: number, secondIndex: number): number {
    return getCoordinateDistance(
        getSymbolLineX(line, firstIndex),
        getSymbolLineY(line, firstIndex),
        getSymbolLineX(line, secondIndex),
        getSymbolLineY(line, secondIndex)
    );
}

export function getSymbolLineAngle(line: SymbolLine, fromIndex: number, toIndex: number): number {
    return Math.atan2(
        getSymbolLineY(line, fromIndex) - getSymbolLineY(line, toIndex),
        getSymbolLineX(line, fromIndex) - getSymbolLineX(line, toIndex)
    );
}

export function getCoordinateDistance(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}
