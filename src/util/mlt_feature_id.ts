export function normalizeMltFeatureId(rawId: unknown, fallback?: number): number | undefined {
    if (rawId == null) {
        return fallback;
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
    return Number.isNaN(coerced) ? fallback : coerced;
}
