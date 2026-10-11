import {
    type Vector,
    type SelectionVector,
    FlatSelectionVector,
    SequenceSelectionVector,
    SINGLE_PART_GEOMETRY_TYPE,
    unionSelectionVectors,
    invertSelectionVector,
    intersectSelectionVectors,
    StringDictionaryVector,
    StringFsstDictionaryVector,
} from '@maplibre/mlt';
import {expression as styleExpression, featureFilter, type FeatureFilter, type FilterSpecification, type GlobalProperties} from '@maplibre/maplibre-gl-style-spec';
import {ColumnarEvaluationFeature} from '../../bucket/columnar/evaluation_feature.ts';
import {toEvaluationFeature} from '../../evaluation_feature.ts';

import type {FeatureTable} from '@maplibre/mlt';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';

const ORDERING_OPERATORS = new Set<string>(['>=', '<=', '>', '<']);
const COMPARISON_OPERATORS = new Set<string>(['==', '!=', ...ORDERING_OPERATORS]);

type FilterTarget =
    | { kind: 'property'; name: string }
    | { kind: 'geometry-type' };

/** A normalized leaf filter that compares a single target against one or more values. */
type NormalizedLeafFilter = {
    operator: string;
    target: FilterTarget;
    values: unknown[];
};

/** A normalized compound filter that combines child filters with a logical operator. */
type NormalizedCompoundFilter = {
    operator: 'all' | 'any' | 'none';
    children: NormalizedFilter[];
};

type NormalizedConstantFilter = {
    operator: 'constant';
    value: boolean;
};

/** A filter part evaluated row by row by the style specification. */
type NormalizedStyleFilter = {
    operator: 'style';
    filter: FeatureFilter;
};

type NormalizedFilter = NormalizedLeafFilter | NormalizedCompoundFilter | NormalizedConstantFilter | NormalizedStyleFilter;

type GlobalState = Record<string, unknown> | undefined;

/** Geometry types as vector tile filters name them, without multi-part names; any other name matches no feature. */
const GEOMETRY_TYPES_BY_NAME: Record<string, SINGLE_PART_GEOMETRY_TYPE> = {
    Point: SINGLE_PART_GEOMETRY_TYPE.POINT,
    LineString: SINGLE_PART_GEOMETRY_TYPE.LINESTRING,
    Polygon: SINGLE_PART_GEOMETRY_TYPE.POLYGON,
};
const EMPTY_UINT32 = new Uint32Array(0);
const EMPTY_SELECTION = new FlatSelectionVector(EMPTY_UINT32);

function isLiteralValue(value: unknown): boolean {
    return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function allDefined<T>(items: Array<T | undefined>): items is T[] {
    return items.every(item => item !== undefined);
}

function constant(value: boolean): NormalizedConstantFilter {
    return {operator: 'constant', value};
}

/**
 * A leaf that runs on the columns, or undefined for one that the style specification evaluates: a
 * comparison with null, which a missing value may equal, and an ordering comparison of geometry types.
 */
function leaf(operator: string, target: FilterTarget | undefined, values: unknown[]): NormalizedLeafFilter | undefined {
    if (!target || values.includes(null)) return undefined;
    if (target.kind === 'geometry-type' && ORDERING_OPERATORS.has(operator)) return undefined;
    return {operator, target, values};
}

/**
 * Normalizes a filter written in the legacy syntax, where a string names the target: `"$type"`, `"$id"` or a
 * property. A missing property reads as undefined, so it equals no value, `null` included, while every legacy
 * comparison still succeeds or fails without error. Filters of the id are left to the style specification.
 */
function normalizeLegacy(filter: unknown): NormalizedFilter | undefined {
    if (!Array.isArray(filter)) return undefined;
    const [op, key] = filter;
    if (filter.length <= 1) return constant(op !== 'any');

    if (op === 'all' || op === 'any' || op === 'none') {
        const children = filter.slice(1).map(normalizeLegacy);
        return allDefined(children) ? {operator: op, children} : undefined;
    }
    if (typeof key !== 'string') return undefined;
    if (op === 'has' || op === '!has') {
        return key === '$type' ? constant(op === 'has') : leaf(op, legacyTarget(key), []);
    }

    const isComparison = COMPARISON_OPERATORS.has(op);
    if (!isComparison && op !== 'in' && op !== '!in') return undefined;
    if (isComparison && filter.length !== 3) return undefined;
    const values = filter.slice(2);
    if (!values.every(isLiteralValue)) return undefined;

    const target = legacyTarget(key);
    if (target?.kind !== 'property' || ORDERING_OPERATORS.has(op) || !values.includes(null)) {
        return leaf(op, target, values);
    }
    if (op === '==' || op === '!=') return constant(op === '!=');
    return leaf(op, target, values.filter(value => value !== null));
}

function legacyTarget(key: string): FilterTarget | undefined {
    if (key === '$type') return {kind: 'geometry-type'};
    return key === '$id' ? undefined : {kind: 'property', name: key};
}

/** The target of an expression leaf: `["get", string]` or `["geometry-type"]`. */
function expressionTarget(arg: unknown): FilterTarget | undefined {
    if (!Array.isArray(arg)) return undefined;
    if (arg[0] === 'get') return arg.length === 2 && typeof arg[1] === 'string' ? {kind: 'property', name: arg[1]} : undefined;
    return arg.length === 1 && arg[0] === 'geometry-type' ? {kind: 'geometry-type'} : undefined;
}

const UNRESOLVED = Symbol('mlt-filter-unresolved-value');

/** A primitive literal, or a `["global-state", string]` lookup of a primitive value, which the normalized filter keeps. */
function resolveValue(value: unknown, globalState: GlobalState): unknown {
    if (isLiteralValue(value)) return value;
    if (!Array.isArray(value) || value[0] !== 'global-state' || value.length !== 2 || typeof value[1] !== 'string') return UNRESOLVED;
    if (!globalState || !Object.hasOwn(globalState, value[1])) return UNRESOLVED;
    const resolved = globalState[value[1]];
    return isLiteralValue(resolved) ? resolved : UNRESOLVED;
}

/** The property named by a `has` key: a string or `["literal", string]`. */
function existenceKey(key: unknown): string | undefined {
    if (typeof key === 'string') return key;
    return Array.isArray(key) && key[0] === 'literal' && key.length === 2 && typeof key[1] === 'string' ? key[1] : undefined;
}

/**
 * Normalizes the part of an expression filter that runs on the columns: comparisons, membership and existence
 * tests of a property or the geometry type against literal or global-state values, boolean `match` and `case`
 * and their combinations. Returns undefined for anything else, which the style specification evaluates row by
 * row.
 *
 * An ordering comparison fails in the style specification when the value is missing or of another type, which
 * rejects the whole row. The columns read that failure as `false`, which is only the same result where `false`
 * rejects the row too: `errorSafe` parts, the root and `all` children.
 */
function normalizeExpression(expr: unknown, globalState: GlobalState, errorSafe: boolean): NormalizedFilter | undefined {
    if (typeof expr === 'boolean') return constant(expr);
    if (!Array.isArray(expr)) return undefined;
    const op = expr[0];

    if (COMPARISON_OPERATORS.has(op)) {
        const value = resolveValue(expr[2], globalState);
        if (expr.length !== 3 || value === UNRESOLVED) return undefined;
        if (!errorSafe && ORDERING_OPERATORS.has(op)) return undefined;
        return leaf(op, expressionTarget(expr[1]), [value]);
    }

    switch (op) {
        case 'all':
        case 'any': {
            const children = expr.slice(1).map(child => normalizeExpression(child, globalState, errorSafe && op === 'all'));
            return allDefined(children) ? {operator: op, children} : undefined;
        }
        case '!': {
            if (expr.length !== 2) return undefined;
            const child = normalizeExpression(expr[1], globalState, false);
            return child && {operator: 'none', children: [child]};
        }
        case 'in': {
            const haystack = expr[2];
            if (expr.length !== 3 || !Array.isArray(haystack) || haystack[0] !== 'literal' || haystack.length !== 2) return undefined;
            return Array.isArray(haystack[1]) && haystack[1].every(isLiteralValue) ? leaf('in', expressionTarget(expr[1]), haystack[1]) : undefined;
        }
        case 'has': {
            const key = existenceKey(expr[1]);
            return expr.length === 2 && key !== undefined ? leaf('has', {kind: 'property', name: key}, []) : undefined;
        }
        case 'match':
            return normalizeMatch(expr);
        case 'case':
            return normalizeCase(expr, globalState);
        case 'literal':
            return expr.length === 2 && typeof expr[1] === 'boolean' ? constant(expr[1]) : undefined;
        case 'global-state': {
            const value = resolveValue(expr, globalState);
            return typeof value === 'boolean' ? constant(value) : undefined;
        }
        default:
            return undefined;
    }
}

/**
 * Normalizes a boolean `["match", target, label1, output1, ..., fallback]` into an `in` leaf, or an `!in` leaf
 * of the labels that map to `false` when the fallback is `true`. Labels are unique primitives.
 */
function normalizeMatch(expr: unknown[]): NormalizedLeafFilter | undefined {
    const target = expressionTarget(expr[1]);
    const fallback = expr[expr.length - 1];
    if (!target || expr.length < 4 || expr.length % 2 !== 1 || typeof fallback !== 'boolean') return undefined;

    const labels = new Set<unknown>();
    const values: unknown[] = [];
    for (let i = 2; i < expr.length - 1; i += 2) {
        const output = expr[i + 1];
        const branchLabels = Array.isArray(expr[i]) ? expr[i] as unknown[] : [expr[i]];
        if (typeof output !== 'boolean' || branchLabels.length === 0) return undefined;
        for (const label of branchLabels) {
            if (!isLiteralValue(label) || labels.has(label)) return undefined;
            labels.add(label);
            if (output !== fallback) values.push(label);
        }
    }
    return leaf(fallback ? '!in' : 'in', target, values);
}

/** Normalizes a boolean `case` into an `any` of clauses, each true when its condition holds and no earlier one does. */
function normalizeCase(expr: unknown[], globalState: GlobalState): NormalizedFilter | undefined {
    const fallback = expr[expr.length - 1];
    if (expr.length < 4 || expr.length % 2 !== 0 || typeof fallback !== 'boolean') return undefined;

    const previousConditions: NormalizedFilter[] = [];
    const trueClauses: NormalizedFilter[] = [];
    for (let i = 1; i < expr.length - 1; i += 2) {
        const condition = normalizeExpression(expr[i], globalState, false);
        const output = expr[i + 1];
        if (!condition || typeof output !== 'boolean') return undefined;
        if (output) {
            const clauseChildren = [...previousConditions.map(negate), condition];
            trueClauses.push(clauseChildren.length === 1 ? condition : {operator: 'all', children: clauseChildren});
        }
        previousConditions.push(condition);
    }
    if (fallback) {
        trueClauses.push(previousConditions.length === 0 ? constant(true) : {operator: 'all', children: previousConditions.map(negate)});
    }

    if (trueClauses.length === 0) return constant(false);
    return trueClauses.length === 1 ? trueClauses[0] : {operator: 'any', children: trueClauses};
}

function negate(filter: NormalizedFilter): NormalizedCompoundFilter {
    return {operator: 'none', children: [filter]};
}

function styleFilter(filter: unknown, globalState: GlobalState): NormalizedStyleFilter {
    return {operator: 'style', filter: featureFilter(filter as FilterSpecification, 'MLT filter', globalState)};
}

/**
 * Normalizes the children of an expression `all`, flattening nested `all`, each on the columns when possible.
 * Returns undefined when a style-evaluated child would not read as an expression on its own, such as
 * `["==", "kind", "primary"]`, whose meaning depends on the filter around it.
 */
function normalizeAllChildren(expr: unknown[], globalState: GlobalState, children: NormalizedFilter[]): NormalizedFilter[] | undefined {
    for (const child of expr.slice(1)) {
        if (Array.isArray(child) && child[0] === 'all') {
            if (!normalizeAllChildren(child, globalState, children)) return undefined;
            continue;
        }
        const normalized = normalizeExpression(child, globalState, true) ??
            (styleExpression.isExpressionFilter(child) ? styleFilter(child, globalState) : undefined);
        if (!normalized) return undefined;
        children.push(normalized);
    }
    return children;
}

/**
 * Normalizes a whole filter. The style specification reads a filter either in the legacy syntax or as an
 * expression, and so does this. Parts the columns cannot run are evaluated by the style specification, which
 * rejects a row when its evaluation fails. The same failure in a part evaluated on its own only makes that
 * part false, which is equivalent at the root and for the children of a top-level expression `all`: those
 * children are normalized separately, and anywhere else a style-evaluated part keeps its whole subtree.
 */
function normalizeFilterUncached(filter: FilterSpecification, globalState: GlobalState): NormalizedFilter {
    const whole = styleFilter(filter, globalState);
    if (!styleExpression.isExpressionFilter(filter)) {
        return normalizeLegacy(filter) ?? whole;
    }
    const columnar = normalizeExpression(filter, globalState, true);
    if (columnar) return columnar;
    const children = Array.isArray(filter) && filter[0] === 'all' ? normalizeAllChildren(filter, globalState, []) : undefined;
    return children ? {operator: 'all', children} : whole;
}

const normalizedFilterCache = new WeakMap<object, {globalState: string; normalized: NormalizedFilter}>();

/**
 * Normalized filters are reused across tiles while the filter object and the global state values stay the same.
 * The global state object is updated in place, so its values are compared rather than its identity.
 */
function normalizeFilter(filter: FilterSpecification, globalState: Record<string, unknown> | undefined): NormalizedFilter {
    if (typeof filter !== 'object' || filter === null) {
        return normalizeFilterUncached(filter, globalState);
    }
    const globalStateKey = JSON.stringify(globalState ?? null);
    const cached = normalizedFilterCache.get(filter);
    if (cached?.globalState === globalStateKey) {
        return cached.normalized;
    }
    const normalized = normalizeFilterUncached(filter, globalState);
    normalizedFilterCache.set(filter, {globalState: globalStateKey, normalized});
    return normalized;
}

/** Evaluates the style filters of a table on one row at a time, with the geometry only when they need it. */
class StyleRows {
    private readonly row: ColumnarEvaluationFeature;

    constructor(featureTable: FeatureTable, private readonly canonical: CanonicalTileID | undefined, private readonly globals: GlobalProperties) {
        this.row = new ColumnarEvaluationFeature(featureTable);
    }

    matches(filter: FeatureFilter, featureIndex: number): boolean {
        this.row.setIndex(featureIndex);
        const feature = filter.needGeometry ? toEvaluationFeature(this.row, true) : this.row;
        return filter.filter(this.globals, feature, this.canonical);
    }
}

const DEFAULT_GLOBALS = {} as GlobalProperties;

/** Whether a filter runs entirely on the columns, without row-by-row style evaluation. */
export function isColumnarMltFilter(filter: FilterSpecification | void, globalState?: Record<string, unknown>): boolean {
    return !filter || !containsStyleFilter(normalizeFilter(filter, globalState));
}

function containsStyleFilter(filter: NormalizedFilter): boolean {
    if (filter.operator === 'style') return true;
    return 'children' in filter && filter.children.some(containsStyleFilter);
}

/**
 * Selects the rows of an MLT feature table that pass a style filter; runtime globals must use the effective
 * zoom, not the canonical tile zoom.
 *
 * Comparisons, membership and existence tests of a property or the geometry type against literal values and
 * their boolean combinations run on the columns. Any other expression is evaluated row by row by the style
 * specification's own filter, through a columnar view of the row, so the result is the vector tile result.
 */
export default function filter(featureTable: FeatureTable, expression: FilterSpecification | void, globalState?: Record<string, unknown>, canonical?: CanonicalTileID, globals: GlobalProperties = DEFAULT_GLOBALS): SelectionVector {
    if (expression === undefined || expression === null) {
        return new SequenceSelectionVector(0, 1, featureTable.numFeatures);
    }
    return executeFilter(featureTable, normalizeFilter(expression as FilterSpecification, globalState), undefined, new StyleRows(featureTable, canonical, globals));
}

/** Evaluates a style filter row by row, on the selected rows only when a selection is given. */
function executeStyleFilter(featureTable: FeatureTable, filter: FeatureFilter, selectionVector: SelectionVector | undefined, rows: StyleRows): SelectionVector {
    const selected = selectionVector?.selectionValues();
    const rowCount = selected ? selectionVector.limit : featureTable.numFeatures;
    const kept = new Uint32Array(rowCount);
    let count = 0;
    for (let i = 0; i < rowCount; i++) {
        const featureIndex = selected ? selected[i] : i;
        if (rows.matches(filter, featureIndex)) kept[count++] = featureIndex;
    }
    return new FlatSelectionVector(kept, count);
}

/** Selects the rows that pass a normalized filter, or narrows `selectionVector` to them. */
function executeFilter(featureTable: FeatureTable, normalized: NormalizedFilter, selectionVector: SelectionVector | undefined, rows: StyleRows): SelectionVector {
    switch (normalized.operator) {
        case 'all':
            return executeAll(featureTable, (normalized as NormalizedCompoundFilter).children, selectionVector, rows);
        case 'any':
        case 'none': {
            const result = executeAnyOrNone(featureTable, normalized as NormalizedCompoundFilter, rows);
            return selectionVector ? intersectSelectionVectors(selectionVector, result) : result;
        }
        case 'style':
            return executeStyleFilter(featureTable, (normalized as NormalizedStyleFilter).filter, selectionVector, rows);
        case 'constant':
            return (normalized as NormalizedConstantFilter).value ? selectAll(featureTable.numFeatures, selectionVector) : EMPTY_SELECTION;
        default:
            return executeLeaf(featureTable, normalized as NormalizedLeafFilter, selectionVector);
    }
}

/**
 * Narrows the selection with each child of an `all` in turn, those evaluated row by row last so that they only
 * visit the remaining rows.
 */
function executeAll(featureTable: FeatureTable, children: NormalizedFilter[], selectionVector: SelectionVector | undefined, rows: StyleRows): SelectionVector {
    const ordered = [...children.filter(child => child.operator !== 'style'), ...children.filter(child => child.operator === 'style')];
    for (const child of ordered) {
        selectionVector = executeFilter(featureTable, child, selectionVector, rows);
        if (selectionVector.limit === 0) return selectionVector;
    }
    return selectionVector ?? selectAll(featureTable.numFeatures);
}

/** Selects the rows that pass any child of `any`, or, for `none`, the other rows. */
function executeAnyOrNone(featureTable: FeatureTable, compound: NormalizedCompoundFilter, rows: StyleRows): SelectionVector {
    const results = compound.children
        .map(child => executeFilter(featureTable, child, undefined, rows))
        .filter(result => result.limit > 0);
    const matching = results.length === 0 ? EMPTY_SELECTION :
        results.length === 1 ? results[0] : unionSelectionVectors(results, featureTable.numFeatures);
    return compound.operator === 'any' ? matching : invertSelectionVector(matching, featureTable.numFeatures);
}

function executeLeaf(featureTable: FeatureTable, leaf: NormalizedLeafFilter, selectionVector?: SelectionVector): SelectionVector {
    return leaf.target.kind === 'geometry-type'
        ? executeGeometryTypeFilter(featureTable, leaf.operator, leaf.values as string[], selectionVector)
        : executePropertyFilter(featureTable, leaf.operator, leaf.target.name, leaf.values, selectionVector);
}

/**
 * Selects the rows whose geometry type is, or for `!=` and `!in` is not, one of the named types, or narrows
 * `selectionVector` to them.
 */
function executeGeometryTypeFilter(featureTable: FeatureTable, operator: string, geometryTypeNames: string[], selectionVector?: SelectionVector): SelectionVector {
    const negated = operator === '!=' || operator === '!in';
    if (!negated && operator !== '==' && operator !== 'in') {
        throw new Error(`Operator ${operator} not supported on geometry type.`);
    }

    const geometryTypes = [...new Set(geometryTypeNames.map(name => GEOMETRY_TYPES_BY_NAME[name]).filter(type => type !== undefined))];
    if (geometryTypes.length === 0) {
        return negated ? selectAll(featureTable.numFeatures, selectionVector) : selectNone(selectionVector);
    }

    const geometryVector = featureTable.geometryVector;
    if (!negated && geometryTypes.length === 1 && selectionVector) {
        geometryVector.filterSelected(geometryTypes[0], selectionVector);
        return selectionVector;
    }

    const matching = geometryTypes.length === 1
        ? geometryVector.filter(geometryTypes[0])
        : unionSelectionVectors(geometryTypes.map(type => geometryVector.filter(type)), featureTable.numFeatures);
    const selected = negated ? invertSelectionVector(matching, featureTable.numFeatures) : matching;
    return selectionVector ? intersectSelectionVectors(selectionVector, selected) : selected;
}

/** Selects the rows that pass a leaf of a property, or narrows `selectionVector` to them; a missing column only passes negated leaves. */
function executePropertyFilter(featureTable: FeatureTable, operator: string, columnName: string, values: unknown[], selectionVector?: SelectionVector): SelectionVector {
    const propertyVector = featureTable.getPropertyVector(columnName);
    if (propertyVector) return executeVectorOperation(propertyVector, operator, values, selectionVector);
    return operator === '!=' || operator === '!in' || operator === '!has' ? selectAll(featureTable.numFeatures, selectionVector) : EMPTY_SELECTION;
}

type VectorValueKind = 'string' | 'number' | 'bigint' | 'boolean' | 'none';

const vectorValueKinds = new WeakMap<Vector, VectorValueKind>();

/** The type of a column's values, sampled from its first non-null value; columns are typed. */
function getVectorValueKind(vector: Vector): VectorValueKind {
    let kind = vectorValueKinds.get(vector);
    if (kind) return kind;
    kind = 'none';
    for (let i = 0; i < vector.size; i++) {
        if (vector.has(i)) {
            const type = typeof vector.getValue(i);
            kind = type === 'string' || type === 'number' || type === 'bigint' || type === 'boolean' ? type : 'none';
            break;
        }
    }
    vectorValueKinds.set(vector, kind);
    return kind;
}

const INCOMPATIBLE = Symbol('mlt-filter-incompatible-value');

/**
 * Converts a filter value to the column's representation, or INCOMPATIBLE when no value of the column can
 * equal it: vector tiles compare numbers, strings and booleans strictly, and decode 64-bit integers as numbers.
 */
function toColumnValue(kind: VectorValueKind, value: unknown): unknown {
    if (kind === 'bigint') {
        return typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : INCOMPATIBLE;
    }
    return typeof value === kind ? value : INCOMPATIBLE;
}

/**
 * Ordering comparisons only compare values of the same type: expressions compare numbers or strings and
 * fail otherwise, which rejects the row, and legacy filters also compare booleans. JavaScript would
 * coerce mismatched types instead.
 */
function isComparableVector(vector: Vector, value: unknown): boolean {
    const kind = getVectorValueKind(vector);
    switch (typeof value) {
        case 'string': return kind === 'string';
        case 'number': return kind === 'number' || kind === 'bigint';
        case 'boolean': return kind === 'boolean';
        default: return false;
    }
}

function selectNone(selectionVector?: SelectionVector): SelectionVector {
    if (!selectionVector) return EMPTY_SELECTION;
    selectionVector.setLimit(0);
    return selectionVector;
}

function selectAll(featureCount: number, selectionVector?: SelectionVector): SelectionVector {
    return selectionVector ?? new SequenceSelectionVector(0, 1, featureCount);
}

/**
 * Keeps the rows, of the selection in place or of the whole vector, whose value is present and `matches`;
 * rows without a value are kept only with `keepMissing`.
 */
function selectRows(vector: Vector, selectionVector: SelectionVector | undefined, matches: (row: number) => boolean, keepMissing: boolean): SelectionVector {
    const rows = selectionVector?.selectionValues();
    const rowCount = rows ? rows.length : vector.size;
    const kept = rows ?? new Uint32Array(rowCount);
    let count = 0;
    for (let i = 0; i < rowCount; i++) {
        const row = rows ? rows[i] : i;
        if (vector.has(row) ? matches(row) : keepMissing) kept[count++] = row;
    }
    return keepSelected(selectionVector, kept, count);
}

/**
 * Keeps the rows of a dictionary column whose entry is, or with `negated` is not, one of `values`; rows without
 * a value are kept only when negated. The entries are compared once, then every row only reads its entry index.
 */
function selectDictionaryRows(vector: StringDictionaryVector | StringFsstDictionaryVector, selectionVector: SelectionVector | undefined, values: unknown[], negated: boolean): SelectionVector {
    const valueSet = new Set(values);
    const entryMatches = new Uint8Array(vector.dictionarySize);
    let matchingEntries = 0;
    for (let entry = 0; entry < entryMatches.length; entry++) {
        if (!valueSet.has(vector.getDictionaryValue(entry))) continue;
        entryMatches[entry] = 1;
        matchingEntries++;
    }
    if (matchingEntries === 0) {
        return negated ? selectAll(vector.size, selectionVector) : selectNone(selectionVector);
    }

    const entryIndices = vector.index;
    const nullability = vector.nullability;
    const rows = selectionVector?.selectionValues();
    const rowCount = rows ? rows.length : vector.size;
    const kept = rows ?? new Uint32Array(rowCount);
    let count = 0;
    for (let i = 0; i < rowCount; i++) {
        const row = rows ? rows[i] : i;
        const present = !nullability || nullability.get(row);
        if (present ? (entryMatches[entryIndices[row]] === 1) !== negated : negated) kept[count++] = row;
    }
    return keepSelected(selectionVector, kept, count);
}

/** Keeps the rows of the selection in place, or of the whole vector, whose present value compares to `value` as `operator` says. */
function selectOrderedRows(vector: Vector, selectionVector: SelectionVector | undefined, operator: string, value: unknown): SelectionVector {
    const rows = selectionVector?.selectionValues();
    const rowCount = rows ? rows.length : vector.size;
    const kept = rows ?? new Uint32Array(rowCount);
    let count = 0;
    for (let i = 0; i < rowCount; i++) {
        const row = rows ? rows[i] : i;
        if (!vector.has(row)) continue;
        const rowValue = vector.getValue(row);
        const matches = operator === '<' ? rowValue < value :
            operator === '<=' ? rowValue <= value :
                operator === '>' ? rowValue > value :
                    rowValue >= value;
        if (matches) kept[count++] = row;
    }
    return keepSelected(selectionVector, kept, count);
}

/**
 * The first `count` rows of `kept`, which were written over the selection's own rows when a selection was
 * narrowed in place.
 */
function keepSelected(selectionVector: SelectionVector | undefined, kept: Uint32Array, count: number): SelectionVector {
    if (!selectionVector) return new FlatSelectionVector(kept, count);
    selectionVector.setLimit(count);
    return selectionVector;
}

/** Selects the rows of a column, or narrows a selection in place, with a comparison, membership or existence test. */
function executeVectorOperation(vector: Vector, operator: string, filterValues: unknown[], selectionVector?: SelectionVector): SelectionVector {
    switch (operator) {
        case 'has':
            return selectRows(vector, selectionVector, () => true, false);
        case '!has':
            return selectRows(vector, selectionVector, () => false, true);
        case '<':
        case '<=':
        case '>':
        case '>=':
            if (!isComparableVector(vector, filterValues[0])) return selectNone(selectionVector);
            return selectOrderedRows(vector, selectionVector, operator, filterValues[0]);
    }

    const negated = operator === '!=' || operator === '!in';
    if (!negated && operator !== '==' && operator !== 'in') {
        throw new Error(`Operator ${operator} not supported.`);
    }
    const kind = getVectorValueKind(vector);
    const values = filterValues.map(value => toColumnValue(kind, value)).filter(value => value !== INCOMPATIBLE);
    if (values.length === 0) {
        return negated ? selectAll(vector.size, selectionVector) : selectNone(selectionVector);
    }
    if (vector instanceof StringDictionaryVector || vector instanceof StringFsstDictionaryVector) {
        return selectDictionaryRows(vector, selectionVector, values, negated);
    }
    const valueSet = new Set(values);
    return selectRows(vector, selectionVector, row => valueSet.has(vector.getValue(row)) !== negated, negated);
}
