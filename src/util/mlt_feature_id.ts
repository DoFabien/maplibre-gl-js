import type {FeatureTable} from '@maplibre/mlt';

/** Reinterprets a decoded MLT id as the unsigned 64-bit number an MVT decoder returns for the same feature. */
export function normalizeMltFeatureId(rawId: unknown): number | undefined {
    if (rawId == null) {
        return undefined;
    }

    if (typeof rawId === 'bigint') {
        return Number(BigInt.asUintN(64, rawId));
    }

    if (typeof rawId === 'number') {
        return Number.isInteger(rawId) && rawId < 0
            ? Number(BigInt.asUintN(64, BigInt(rawId)))
            : rawId;
    }

    const coerced = Number(rawId);
    return Number.isNaN(coerced) ? undefined : coerced;
}

/** The id of a feature table row as vector tiles expose it: undefined when the row has none. */
export function getMltFeatureId(featureTable: FeatureTable, featureIndex: number): number | undefined {
    const idVector = featureTable.idVector;
    return idVector?.has(featureIndex) ? normalizeMltFeatureId(idVector.getValue(featureIndex)) : undefined;
}
