import {
    type Vector,
    type SelectionVector,
    FlatSelectionVector,
    SequenceSelectionVector,
    ConstSelectionVector,
    SINGLE_PART_GEOMETRY_TYPE,
    GEOMETRY_TYPE,
    unionSelectionVectors,
    invertSelectionVector,
    intersectSelectionVectors,
    BooleanFlatVector,
    IndexedVector,
} from '@maplibre/mlt';
import {featureFilter, type ExpressionSpecification, type FilterSpecification, type GlobalProperties} from '@maplibre/maplibre-gl-style-spec';
import {getVectorTypeHandlers} from './vectorTypeHandlers';
import {
    createNonNullSelectionVector,
    filterNonNullSelected,
    filterNullSelected,
    nullableValues,
} from './utils/filterUtils';
import {ColumnarWithinEvaluator, normalizeWithinGeometry, type CanonicalWithinTileID, type WithinGeometry} from './within.ts';

import type {FeatureTable} from '@maplibre/mlt';

export const enum SupportedFilterOperator {
    Equal = '==',
    NotEqual = '!=',
    GreaterThanOrEqual = '>=',
    LessThanOrEqual = '<=',
    GreaterThan = '>',
    LessThan = '<',
    In = 'in',
    NotIn = '!in',
    Has = 'has',
    NotHas = '!has',
    All = 'all',
    Any = 'any',
    None = 'none',
    Not = '!',
    Match = 'match',
    Case = 'case',
    Within = 'within',
}

export type MltFilterSupport = {supported: true} | {supported: false; reason: string};

const COMPARISON_OPERATORS = new Set<string>(['==', '!=', '>=', '<=', '>', '<']);
const MEMBERSHIP_OPERATORS = new Set<string>(['in', '!in']);
const EXISTENCE_OPERATORS = new Set<string>(['has', '!has']);
const COMPOUND_OPERATORS = new Set<string>(['all', 'any', 'none']);
const NUMERIC_SCALAR_OPERATORS = new Set<string>(['+', '-', '*', '/', '%', 'min', 'max']);
const STRING_SCALAR_OPERATORS = new Set<string>(['upcase', 'downcase']);
const EVALUATION_ERROR = Symbol('mlt-filter-evaluation-error');
const WITHIN_CONTEXT = Symbol('mlt-filter-within-context');
const GLOBALS_CONTEXT = Symbol('mlt-filter-globals-context');
type VariableScope = ReadonlySet<string>;
type ScalarEnvironment = ReadonlyMap<string | symbol, unknown>;
type ScalarBinding = {name: string; value: ScalarExpression};
type EvaluationError = typeof EVALUATION_ERROR;
type MatchBranch = {labels: unknown[]; output: ScalarExpression};

function unsupported(reason: string): MltFilterSupport {
    return {supported: false, reason};
}

function isLiteralValue(value: unknown): boolean {
    return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isLiteralScalarExpressionValue(value: unknown): boolean {
    return isLiteralValue(value) || (Array.isArray(value) && value.every(isLiteralValue));
}

function isEvaluationError(value: unknown): value is EvaluationError {
    return value === EVALUATION_ERROR;
}

function getGlobalStateValueSupport(value: unknown, globalState: Record<string, unknown> | undefined): MltFilterSupport {
    if (!Array.isArray(value) || value[0] !== 'global-state') {
        return unsupported('Expected ["global-state", string] expression.');
    }
    if (value.length !== 2 || typeof value[1] !== 'string') {
        return unsupported('MLT filters only support ["global-state", string] values.');
    }
    if (!globalState || !Object.hasOwn(globalState, value[1])) {
        return unsupported(`MLT global-state filter value "${value[1]}" is not available.`);
    }
    if (!isLiteralValue(globalState[value[1]])) {
        return unsupported('MLT global-state filter values must resolve to primitive values.');
    }

    return {supported: true};
}

function getGlobalStateMembershipHaystackSupport(value: unknown, globalState: Record<string, unknown> | undefined): MltFilterSupport {
    const globalStateSupport = getGlobalStateValueExpressionSupport(value, globalState);
    if (!globalStateSupport.supported) return globalStateSupport;

    const resolved = globalState?.[(value as unknown[])[1] as string];
    if (typeof resolved === 'string') {
        return {supported: true};
    }
    if (Array.isArray(resolved) && resolved.every(isLiteralValue)) {
        return {supported: true};
    }

    return unsupported('MLT global-state membership haystacks must resolve to strings or primitive arrays.');
}

function getGlobalStateValueExpressionSupport(value: unknown, globalState: Record<string, unknown> | undefined): MltFilterSupport {
    if (!Array.isArray(value) || value[0] !== 'global-state') {
        return unsupported('Expected ["global-state", string] expression.');
    }
    if (value.length !== 2 || typeof value[1] !== 'string') {
        return unsupported('MLT filters only support ["global-state", string] values.');
    }
    if (!globalState || !Object.hasOwn(globalState, value[1])) {
        return unsupported(`MLT global-state filter value "${value[1]}" is not available.`);
    }

    return {supported: true};
}

function getValueSupport(value: unknown, globalState: Record<string, unknown> | undefined): MltFilterSupport {
    if (isLiteralValue(value)) {
        return {supported: true};
    }
    if (Array.isArray(value) && value[0] === 'global-state') {
        return getGlobalStateValueSupport(value, globalState);
    }

    return unsupported('MLT filter values must be primitive or supported global-state lookups.');
}

function resolveBooleanExpressionValue(value: unknown, globalState: Record<string, unknown> | undefined): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value) && value.length === 2) {
        if (value[0] === 'literal' && typeof value[1] === 'boolean') {
            return value[1];
        }
        if (value[0] === 'global-state' && typeof value[1] === 'string' && globalState && Object.hasOwn(globalState, value[1])) {
            const resolved = globalState[value[1]];
            return typeof resolved === 'boolean' ? resolved : undefined;
        }
    }
    return undefined;
}

function isSimpleTargetAccessor(target: unknown): boolean {
    return Array.isArray(target) && (target[0] === 'get' || target[0] === 'id' || target[0] === 'geometry-type');
}

function isComputedComparisonExpression(expr: unknown[]): boolean {
    return Array.isArray(expr[1]) &&
        (!isSimpleTargetAccessor(expr[1]) || (Array.isArray(expr[2]) && expr[2][0] !== 'global-state'));
}

function isDynamicMembershipExpression(expr: unknown[]): boolean {
    if (!MEMBERSHIP_OPERATORS.has(expr[0] as string) || expr.length !== 3) {
        return false;
    }

    const needle = expr[1];
    const haystack = expr[2];
    if (
        Array.isArray(needle) &&
        isSimpleTargetAccessor(needle) &&
        Array.isArray(haystack) &&
        haystack[0] === 'literal' &&
        Array.isArray(haystack[1])
    ) {
        return false;
    }
    if (Array.isArray(needle) && !isSimpleTargetAccessor(needle)) {
        return true;
    }
    return Array.isArray(haystack);
}

function getTargetSupport(target: unknown): MltFilterSupport {
    if (!Array.isArray(target)) {
        return typeof target === 'string'
            ? {supported: true}
            : unsupported(`Unsupported non-string filter target: ${String(target)}`);
    }

    const accessor = target[0];
    if (accessor === 'get') {
        return typeof target[1] === 'string' && target.length === 2
            ? {supported: true}
            : unsupported('MLT filters only support ["get", string] property accessors.');
    }
    if (accessor === 'id' || accessor === 'geometry-type') {
        return target.length === 1
            ? {supported: true}
            : unsupported(`MLT filters only support [${JSON.stringify(accessor)}] without arguments.`);
    }

    return unsupported(`Unsupported MLT filter accessor: ${String(accessor)}`);
}

function getExistenceTargetSupport(op: string, target: unknown): MltFilterSupport {
    if (typeof target === 'string') {
        return {supported: true};
    }

    if (!Array.isArray(target)) {
        return unsupported(`Unsupported non-string filter target: ${String(target)}`);
    }

    if (target[0] === 'literal') {
        return target.length === 2 && typeof target[1] === 'string'
            ? {supported: true}
            : unsupported(`MLT ${op} filters only support ["literal", string] property names.`);
    }

    if (target[0] === 'get') {
        if (op === '!has') {
            return unsupported('MLT dynamic !has filters require expression-style ["!", ["has", ["get", string]]] for parity.');
        }
        return target.length === 2 && typeof target[1] === 'string'
            ? {supported: true}
            : unsupported('MLT dynamic has filters only support ["get", string] property-name accessors.');
    }

    return unsupported(`Unsupported MLT ${op} filter target expression: ${String(target[0])}`);
}

function getLiteralArraySupport(value: unknown): MltFilterSupport {
    if (!Array.isArray(value) || value[0] !== 'literal' || !Array.isArray(value[1]) || value.length !== 2) {
        return unsupported('MLT expression-style in filters require ["literal", [...]] values.');
    }

    for (const entry of value[1]) {
        if (!isLiteralValue(entry)) {
            return unsupported('MLT filter literal arrays may only contain primitive values.');
        }
    }
    return {supported: true};
}

function getLeafSupport(expr: unknown[], op: string, globalState: Record<string, unknown> | undefined): MltFilterSupport {
    if (EXISTENCE_OPERATORS.has(op)) {
        if (expr.length !== 2) {
            return unsupported(`MLT ${op} filters only support one target argument.`);
        }
        return getExistenceTargetSupport(op, expr[1]);
    }

    const targetSupport = getTargetSupport(expr[1]);
    if (!targetSupport.supported) return targetSupport;

    if (COMPARISON_OPERATORS.has(op)) {
        if (expr.length !== 3) {
            return unsupported(`MLT ${op} filters require exactly one comparison value.`);
        }
        return Array.isArray(expr[1])
            ? getValueSupport(expr[2], globalState)
            : isLiteralValue(expr[2])
                ? {supported: true}
                : unsupported(`MLT ${op} legacy filters only support primitive comparison values.`);
    }

    if (MEMBERSHIP_OPERATORS.has(op)) {
        if (Array.isArray(expr[1])) {
            return getLiteralArraySupport(expr[2]);
        }
        for (let i = 2; i < expr.length; i++) {
            if (!isLiteralValue(expr[i])) {
                return unsupported(`MLT ${op} legacy filters only support primitive membership values.`);
            }
        }
        return {supported: true};
    }

    return unsupported(`Unsupported MLT filter operator: ${op}`);
}

function getMatchLabelSupport(label: unknown): MltFilterSupport {
    if (Array.isArray(label)) {
        if (label.length === 0) {
            return unsupported('MLT match filters require at least one branch label.');
        }
        for (const entry of label) {
            if (!isLiteralValue(entry)) {
                return unsupported('MLT match labels may only contain primitive values.');
            }
        }
    } else if (!isLiteralValue(label)) {
        return unsupported('MLT match labels may only contain primitive values.');
    }

    return {supported: true};
}

function isSimpleMatchFilter(expr: unknown[]): boolean {
    if (!Array.isArray(expr[1])) return false;
    if (!isSimpleTargetAccessor(expr[1])) return false;

    for (let i = 3; i < expr.length; i += 2) {
        if (typeof expr[i] !== 'boolean') return false;
    }
    const fallback = expr[expr.length - 1];
    if (typeof fallback !== 'boolean') return false;

    return true;
}

function getMatchDuplicateSupport(expr: unknown[]): MltFilterSupport {
    const labelSet = new Set<unknown>();
    for (let i = 2; i < expr.length - 1; i += 2) {
        const label = expr[i];
        if (Array.isArray(label)) {
            for (const entry of label) {
                if (labelSet.has(entry)) {
                    return unsupported('MLT match labels must be unique.');
                }
                labelSet.add(entry);
            }
        } else {
            if (labelSet.has(label)) {
                return unsupported('MLT match labels must be unique.');
            }
            labelSet.add(label);
        }
    }
    return {supported: true};
}

function getGeneralBooleanMatchSupport(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): MltFilterSupport {
    if (expr.length < 4 || expr.length % 2 !== 1) {
        return unsupported('MLT match filters require label/output pairs and a fallback.');
    }

    if (!Array.isArray(expr[1])) {
        return unsupported('MLT match filters require expression-style accessors for parity with the legacy filter path.');
    }
    const inputSupport = getScalarExpressionSupport(expr[1], globalState, scope);
    if (!inputSupport.supported) return inputSupport;

    const duplicateSupport = getMatchDuplicateSupport(expr);
    if (!duplicateSupport.supported) return duplicateSupport;

    for (let i = 2; i < expr.length - 1; i += 2) {
        const labelSupport = getMatchLabelSupport(expr[i]);
        if (!labelSupport.supported) return labelSupport;

        const outputSupport = getExpressionSupport(expr[i + 1], globalState, scope);
        if (!outputSupport.supported) return outputSupport;
    }

    return getExpressionSupport(expr[expr.length - 1], globalState, scope);
}

function getBooleanMatchSupport(expr: unknown[]): MltFilterSupport {
    if (!Array.isArray(expr[1])) {
        return unsupported('MLT match filters require expression-style accessors for parity with the legacy filter path.');
    }
    const targetSupport = getTargetSupport(expr[1]);
    if (!targetSupport.supported) return targetSupport;
    if (expr.length < 4 || expr.length % 2 !== 1) {
        return unsupported('MLT match filters require label/output pairs and a fallback.');
    }

    const fallback = expr[expr.length - 1];
    if (typeof fallback !== 'boolean') {
        return unsupported('MLT match filters only support boolean outputs.');
    }

    const duplicateSupport = getMatchDuplicateSupport(expr);
    if (!duplicateSupport.supported) return duplicateSupport;

    for (let i = 2; i < expr.length - 1; i += 2) {
        const label = expr[i];
        const output = expr[i + 1];
        if (typeof output !== 'boolean') {
            return unsupported('MLT match filters only support boolean outputs.');
        }
        const labelSupport = getMatchLabelSupport(label);
        if (!labelSupport.supported) return labelSupport;
    }

    return {supported: true};
}

function getScalarMatchSupport(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): MltFilterSupport {
    if (expr.length < 4 || expr.length % 2 !== 1) {
        return unsupported('MLT match expressions require label/output pairs and a fallback.');
    }

    if (!Array.isArray(expr[1])) {
        return unsupported('MLT match expressions require expression-style accessors for parity with the legacy filter path.');
    }
    const inputSupport = getScalarExpressionSupport(expr[1], globalState, scope);
    if (!inputSupport.supported) return inputSupport;

    const duplicateSupport = getMatchDuplicateSupport(expr);
    if (!duplicateSupport.supported) return duplicateSupport;

    for (let i = 2; i < expr.length - 1; i += 2) {
        const labelSupport = getMatchLabelSupport(expr[i]);
        if (!labelSupport.supported) return labelSupport;

        const outputSupport = getScalarExpressionSupport(expr[i + 1], globalState, scope);
        if (!outputSupport.supported) return outputSupport;
    }

    return getScalarExpressionSupport(expr[expr.length - 1], globalState, scope);
}

function isSimpleCaseFilter(expr: unknown[]): boolean {
    for (let i = 2; i < expr.length; i += 2) {
        if (typeof expr[i] !== 'boolean') return false;
    }
    const fallback = expr[expr.length - 1];
    if (typeof fallback !== 'boolean') return false;

    return true;
}

function getBooleanCaseSupport(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope = new Set()): MltFilterSupport {
    if (expr.length < 4 || expr.length % 2 !== 0) {
        return unsupported('MLT case filters require condition/output pairs and a fallback.');
    }

    const fallback = expr[expr.length - 1];
    if (typeof fallback !== 'boolean') {
        return unsupported('MLT case filters only support boolean outputs.');
    }

    let hasLegacyCondition = false;
    let hasExpressionCondition = false;
    for (let i = 1; i < expr.length - 1; i += 2) {
        const conditionSupport = getExpressionSupport(expr[i], globalState, scope);
        if (!conditionSupport.supported) return conditionSupport;
        if (containsLegacyTarget(expr[i])) hasLegacyCondition = true;
        if (containsExpressionTarget(expr[i])) hasExpressionCondition = true;

        const output = expr[i + 1];
        if (typeof output !== 'boolean') {
            return unsupported('MLT case filters only support boolean outputs.');
        }
    }

    if (hasLegacyCondition && hasExpressionCondition) {
        return unsupported('MLT case filters require either legacy shorthand or expression-style accessors, not both.');
    }

    return {supported: true};
}

function getScalarCaseSupport(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): MltFilterSupport {
    if (expr.length < 4 || expr.length % 2 !== 0) {
        return unsupported('MLT case expressions require condition/output pairs and a fallback.');
    }

    let hasLegacyCondition = false;
    let hasExpressionCondition = false;
    for (let i = 1; i < expr.length - 1; i += 2) {
        const conditionSupport = getExpressionSupport(expr[i], globalState, scope);
        if (!conditionSupport.supported) return conditionSupport;
        if (containsLegacyTarget(expr[i])) hasLegacyCondition = true;
        if (containsExpressionTarget(expr[i])) hasExpressionCondition = true;

        const outputSupport = getScalarExpressionSupport(expr[i + 1], globalState, scope);
        if (!outputSupport.supported) return outputSupport;
    }

    if (hasLegacyCondition && hasExpressionCondition) {
        return unsupported('MLT case expressions require either legacy shorthand or expression-style accessors, not both.');
    }

    return getScalarExpressionSupport(expr[expr.length - 1], globalState, scope);
}

function getDynamicMembershipSupport(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): MltFilterSupport {
    if (expr.length !== 3) {
        return unsupported(`MLT ${String(expr[0])} expressions require exactly two arguments.`);
    }

    const needleSupport = getScalarExpressionSupport(expr[1], globalState, scope);
    if (!needleSupport.supported) return needleSupport;

    const haystack = expr[2];
    if (Array.isArray(haystack) && haystack[0] === 'literal') {
        return getScalarExpressionSupport(haystack, globalState, scope);
    }
    if (Array.isArray(haystack) && haystack[0] === 'global-state') {
        return getGlobalStateMembershipHaystackSupport(haystack, globalState);
    }

    return getScalarExpressionSupport(haystack, globalState, scope);
}

function getCoalesceSupport(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope = new Set()): MltFilterSupport {
    if (expr.length < 2) {
        return unsupported('MLT coalesce filters require at least one argument.');
    }

    for (let i = 1; i < expr.length; i++) {
        const arg = expr[i];
        if (arg === null) continue;

        if (Array.isArray(arg) && arg[0] === 'get') {
            const targetSupport = getTargetSupport(arg);
            if (!targetSupport.supported) return targetSupport;

            for (let j = i + 1; j < expr.length; j++) {
                const fallback = expr[j];
                if (fallback === null) continue;
                if (resolveBooleanExpressionValue(fallback, globalState) !== undefined) {
                    return {supported: true};
                }
                return getExpressionSupport(fallback, globalState, scope);
            }

            return {supported: true};
        }

        return getExpressionSupport(arg, globalState, scope);
    }

    return unsupported('MLT coalesce filters require at least one non-null boolean argument.');
}

function getStepExpressionSupport(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): MltFilterSupport {
    if (expr.length < 5 || expr.length % 2 !== 1) {
        return unsupported('MLT step expressions require an input, a default output, and stop/output pairs.');
    }

    const inputSupport = getScalarExpressionSupport(expr[1], globalState, scope);
    if (!inputSupport.supported) return inputSupport;

    const defaultSupport = getScalarExpressionSupport(expr[2], globalState, scope);
    if (!defaultSupport.supported) return defaultSupport;

    let previousStop = -Infinity;
    for (let i = 3; i < expr.length; i += 2) {
        const stop = expr[i];
        if (typeof stop !== 'number') {
            return unsupported('MLT step stop inputs must be literal numbers.');
        }
        if (stop <= previousStop) {
            return unsupported('MLT step stop inputs must be strictly ascending.');
        }
        previousStop = stop;

        const outputSupport = getScalarExpressionSupport(expr[i + 1], globalState, scope);
        if (!outputSupport.supported) return outputSupport;
    }

    return {supported: true};
}

function getInterpolateExpressionSupport(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): MltFilterSupport {
    if (expr.length < 7 || expr.length % 2 !== 1) {
        return unsupported('MLT interpolate expressions require an interpolation type, an input, and stop/output pairs.');
    }

    const interpolation = expr[1];
    if (!Array.isArray(interpolation) || interpolation.length === 0) {
        return unsupported('MLT interpolate expressions require an interpolation type expression.');
    }
    if (interpolation[0] === 'linear') {
        if (interpolation.length !== 1) {
            return unsupported('MLT linear interpolate expressions do not take arguments.');
        }
    } else if (interpolation[0] === 'exponential') {
        if (interpolation.length !== 2 || typeof interpolation[1] !== 'number') {
            return unsupported('MLT exponential interpolate expressions require a numeric base.');
        }
    } else {
        return unsupported(`Unsupported MLT interpolate type: ${String(interpolation[0])}`);
    }

    const inputSupport = getScalarExpressionSupport(expr[2], globalState, scope);
    if (!inputSupport.supported) return inputSupport;

    let previousStop = -Infinity;
    for (let i = 3; i < expr.length; i += 2) {
        const stop = expr[i];
        if (typeof stop !== 'number') {
            return unsupported('MLT interpolate stop inputs must be literal numbers.');
        }
        if (stop <= previousStop) {
            return unsupported('MLT interpolate stop inputs must be strictly ascending.');
        }
        previousStop = stop;

        const outputSupport = getScalarExpressionSupport(expr[i + 1], globalState, scope);
        if (!outputSupport.supported) return outputSupport;
    }

    return {supported: true};
}

function getScalarExpressionSupport(expr: unknown, globalState: Record<string, unknown> | undefined, scope: VariableScope = new Set()): MltFilterSupport {
    if (isLiteralValue(expr)) {
        return {supported: true};
    }
    if (!Array.isArray(expr)) {
        return unsupported(`Unsupported MLT scalar expression: ${String(expr)}`);
    }

    const op = expr[0] as string;
    if (op === 'zoom') {
        return expr.length === 1 ? {supported: true} : unsupported('MLT zoom expressions take no arguments.');
    }
    if (op === 'is-supported-script') {
        return expr.length === 2
            ? getScalarExpressionSupport(expr[1], globalState, scope)
            : unsupported('MLT is-supported-script expressions require one string argument.');
    }
    if (op === 'literal') {
        if (expr.length !== 2 || !isLiteralScalarExpressionValue(expr[1])) {
            return unsupported('MLT literal scalar expressions only support primitive values and primitive arrays.');
        }
        return {supported: true};
    }
    if (op === 'get' || op === 'id' || op === 'geometry-type') {
        return getTargetSupport(expr);
    }
    if (op === 'var') {
        if (expr.length !== 2 || typeof expr[1] !== 'string') {
            return unsupported('MLT var expressions require exactly one variable name.');
        }
        return scope.has(expr[1])
            ? {supported: true}
            : unsupported(`Unknown MLT variable: ${expr[1]}`);
    }
    if (op === 'let') {
        if (expr.length < 4 || expr.length % 2 !== 0) {
            return unsupported('MLT let expressions require one or more name/value bindings and a body expression.');
        }

        const extendedScope = new Set(scope);
        for (let i = 1; i < expr.length - 1; i += 2) {
            const name = expr[i];
            if (typeof name !== 'string') {
                return unsupported('MLT let binding names must be strings.');
            }

            const valueSupport = getScalarExpressionSupport(expr[i + 1], globalState, scope);
            if (!valueSupport.supported) return valueSupport;
            extendedScope.add(name);
        }

        return getScalarExpressionSupport(expr[expr.length - 1], globalState, extendedScope);
    }
    if (op === 'global-state') {
        return getGlobalStateValueSupport(expr, globalState);
    }
    if (op === 'feature-state') {
        return unsupported('MLT columnar filters do not support feature-state expressions; the style specification only supports feature-state in paint expressions.');
    }
    if (op === 'typeof') {
        if (expr.length !== 2) {
            return unsupported('MLT typeof expressions require exactly one argument.');
        }
        return getScalarExpressionSupport(expr[1], globalState, scope);
    }
    if (op === 'number' || op === 'string' || op === 'boolean') {
        if (expr.length < 2) {
            return unsupported(`MLT ${op} assertion expressions require at least one argument.`);
        }
        for (let i = 1; i < expr.length; i++) {
            const argSupport = getScalarExpressionSupport(expr[i], globalState, scope);
            if (!argSupport.supported) return argSupport;
        }
        return {supported: true};
    }
    if (op === 'to-number') {
        if (expr.length < 2) {
            return unsupported('MLT to-number expressions require at least one argument.');
        }
        for (let i = 1; i < expr.length; i++) {
            const argSupport = getScalarExpressionSupport(expr[i], globalState, scope);
            if (!argSupport.supported) return argSupport;
        }
        return {supported: true};
    }
    if (op === 'to-string' || op === 'to-boolean') {
        if (expr.length !== 2) {
            return unsupported(`MLT ${op} expressions require exactly one argument.`);
        }
        return getScalarExpressionSupport(expr[1], globalState, scope);
    }
    if (op === 'coalesce' || op === 'concat') {
        if (expr.length < 2) {
            return unsupported(`MLT scalar ${op} expressions require at least one argument.`);
        }
        for (let i = 1; i < expr.length; i++) {
            const argSupport = getScalarExpressionSupport(expr[i], globalState, scope);
            if (!argSupport.supported) return argSupport;
        }
        return {supported: true};
    }
    if (op === 'case') {
        return getScalarCaseSupport(expr, globalState, scope);
    }
    if (op === 'match') {
        return getScalarMatchSupport(expr, globalState, scope);
    }
    if (op === 'in') {
        return getDynamicMembershipSupport(expr, globalState, scope);
    }
    if (
        COMPARISON_OPERATORS.has(op) ||
        MEMBERSHIP_OPERATORS.has(op) ||
        EXISTENCE_OPERATORS.has(op) ||
        COMPOUND_OPERATORS.has(op) ||
        op === 'within' ||
        op === '!'
    ) {
        return getExpressionSupport(expr, globalState, scope);
    }
    if (op === 'step') {
        return getStepExpressionSupport(expr, globalState, scope);
    }
    if (op === 'interpolate') {
        return getInterpolateExpressionSupport(expr, globalState, scope);
    }
    if (NUMERIC_SCALAR_OPERATORS.has(op)) {
        if ((op === '/' || op === '%') && expr.length !== 3) {
            return unsupported(`MLT ${op} expressions require exactly two arguments.`);
        }
        if (op === '-' && expr.length !== 2 && expr.length !== 3) {
            return unsupported('MLT - expressions require one or two arguments.');
        }
        if ((op === '+' || op === '*' || op === 'min' || op === 'max') && expr.length < 2) {
            return unsupported(`MLT ${op} expressions require at least one argument.`);
        }
        for (let i = 1; i < expr.length; i++) {
            const argSupport = getScalarExpressionSupport(expr[i], globalState, scope);
            if (!argSupport.supported) return argSupport;
        }
        return {supported: true};
    }
    if (op === 'length') {
        if (expr.length !== 2) {
            return unsupported('MLT length expressions require exactly one argument.');
        }
        return getScalarExpressionSupport(expr[1], globalState, scope);
    }
    if (op === 'slice') {
        if (expr.length !== 3 && expr.length !== 4) {
            return unsupported('MLT slice expressions require two or three arguments.');
        }
        const inputSupport = getScalarExpressionSupport(expr[1], globalState, scope);
        if (!inputSupport.supported) return inputSupport;
        const startSupport = getScalarExpressionSupport(expr[2], globalState, scope);
        if (!startSupport.supported) return startSupport;
        return expr.length === 4 ? getScalarExpressionSupport(expr[3], globalState, scope) : {supported: true};
    }
    if (op === 'index-of') {
        if (expr.length !== 3 && expr.length !== 4) {
            return unsupported('MLT index-of expressions require two or three arguments.');
        }
        const needleSupport = getScalarExpressionSupport(expr[1], globalState, scope);
        if (!needleSupport.supported) return needleSupport;
        const haystackSupport = getScalarExpressionSupport(expr[2], globalState, scope);
        if (!haystackSupport.supported) return haystackSupport;
        return expr.length === 4 ? getScalarExpressionSupport(expr[3], globalState, scope) : {supported: true};
    }
    if (STRING_SCALAR_OPERATORS.has(op)) {
        if (expr.length !== 2) {
            return unsupported(`MLT ${op} expressions require exactly one argument.`);
        }
        return getScalarExpressionSupport(expr[1], globalState, scope);
    }

    return unsupported(`Unsupported MLT scalar expression operator: ${op}`);
}

function containsLegacyTarget(expr: unknown): boolean {
    if (!Array.isArray(expr)) return false;

    const op = expr[0] as string;
    if (MEMBERSHIP_OPERATORS.has(op) && isDynamicMembershipExpression(expr)) {
        return false;
    }
    if (COMPARISON_OPERATORS.has(op) || MEMBERSHIP_OPERATORS.has(op) || op === 'match') {
        return !Array.isArray(expr[1]);
    }
    if (EXISTENCE_OPERATORS.has(op)) {
        return false;
    }

    if (COMPOUND_OPERATORS.has(op) || op === '!' || op === 'case' || op === 'coalesce' || op === 'let') {
        for (let i = 1; i < expr.length; i++) {
            if (containsLegacyTarget(expr[i])) return true;
        }
    }

    return false;
}

function containsExpressionTarget(expr: unknown): boolean {
    if (!Array.isArray(expr)) return false;

    const op = expr[0] as string;
    if (MEMBERSHIP_OPERATORS.has(op) && isDynamicMembershipExpression(expr)) {
        return true;
    }
    if (op === 'get' || op === 'id' || op === 'geometry-type' || op === 'zoom' || op === 'is-supported-script') {
        return true;
    }

    if (COMPARISON_OPERATORS.has(op) || MEMBERSHIP_OPERATORS.has(op) || EXISTENCE_OPERATORS.has(op) || op === 'match') {
        return Array.isArray(expr[1]);
    }

    if (COMPOUND_OPERATORS.has(op) || op === '!' || op === 'case' || op === 'coalesce' || op === 'to-number' || op === 'to-string' || op === 'to-boolean' || op === 'concat' || op === 'length' || op === 'let' || op === 'literal' || op === 'typeof' || op === 'number' || op === 'string' || op === 'boolean' || op === 'step' || op === 'interpolate' || op === 'slice' || op === 'index-of' || STRING_SCALAR_OPERATORS.has(op) || NUMERIC_SCALAR_OPERATORS.has(op)) {
        for (let i = 1; i < expr.length; i++) {
            if (containsExpressionTarget(expr[i])) return true;
        }
    }

    return false;
}

function getExpressionSupport(expr: unknown, globalState: Record<string, unknown> | undefined, scope: VariableScope = new Set()): MltFilterSupport {
    if (typeof expr === 'boolean') {
        return {supported: true};
    }
    if (!Array.isArray(expr)) {
        return unsupported('MLT filters only support expression arrays.');
    }

    const op = expr[0] as string;

    if (op === 'within') {
        if (expr.length !== 2 || typeof expr[1] !== 'object' || expr[1] === null) {
            return unsupported('MLT within filters require exactly one GeoJSON polygon argument.');
        }
        return normalizeWithinGeometry(expr[1] as GeoJSON.GeoJSON)
            ? {supported: true}
            : unsupported('MLT within filters require valid Polygon or MultiPolygon GeoJSON.');
    }
    if (op === 'literal') {
        if (expr.length !== 2 || typeof expr[1] !== 'boolean') {
            return unsupported('MLT literal filter expressions must resolve to boolean values.');
        }
        return {supported: true};
    }
    if (op === 'boolean' || op === 'to-boolean' || op === 'is-supported-script') {
        return getScalarExpressionSupport(expr, globalState, scope);
    }
    if (op === 'global-state') {
        const valueSupport = getGlobalStateValueSupport(expr, globalState);
        if (!valueSupport.supported) return valueSupport;
        return typeof globalState?.[expr[1] as string] === 'boolean'
            ? {supported: true}
            : unsupported('MLT global-state filter expressions must resolve to boolean values.');
    }
    if (op === 'feature-state') {
        return unsupported('MLT columnar filters do not support feature-state expressions; the style specification only supports feature-state in paint expressions.');
    }

    if (op === 'let') {
        if (expr.length < 4 || expr.length % 2 !== 0) {
            return unsupported('MLT let expressions require one or more name/value bindings and a body expression.');
        }

        const extendedScope = new Set(scope);
        for (let i = 1; i < expr.length - 1; i += 2) {
            const name = expr[i];
            if (typeof name !== 'string') {
                return unsupported('MLT let binding names must be strings.');
            }

            const valueSupport = getScalarExpressionSupport(expr[i + 1], globalState, scope);
            if (!valueSupport.supported) return valueSupport;
            extendedScope.add(name);
        }

        return getExpressionSupport(expr[expr.length - 1], globalState, extendedScope);
    }

    if (op === 'var') {
        if (expr.length !== 2 || typeof expr[1] !== 'string') {
            return unsupported('MLT var expressions require exactly one variable name.');
        }
        return scope.has(expr[1])
            ? {supported: true}
            : unsupported(`Unknown MLT variable: ${expr[1]}`);
    }

    if (MEMBERSHIP_OPERATORS.has(op) && isDynamicMembershipExpression(expr)) {
        return getDynamicMembershipSupport(expr, globalState, scope);
    }

    if (COMPARISON_OPERATORS.has(op) || MEMBERSHIP_OPERATORS.has(op) || EXISTENCE_OPERATORS.has(op)) {
        if (COMPARISON_OPERATORS.has(op) && isComputedComparisonExpression(expr)) {
            if (expr.length !== 3) {
                return unsupported(`MLT ${op} filters require exactly one comparison value.`);
            }
            const leftSupport = getScalarExpressionSupport(expr[1], globalState, scope);
            if (!leftSupport.supported) return leftSupport;
            return getScalarExpressionSupport(expr[2], globalState, scope);
        }
        return getLeafSupport(expr, op, globalState);
    }

    if (COMPOUND_OPERATORS.has(op)) {
        for (let i = 1; i < expr.length; i++) {
            const childSupport = getExpressionSupport(expr[i], globalState, scope);
            if (!childSupport.supported) return childSupport;
        }
        if (containsLegacyTarget(expr) && containsExpressionTarget(expr)) {
            return unsupported('MLT compound filters require either legacy shorthand or expression-style accessors, not both.');
        }
        return {supported: true};
    }

    if (op === '!') {
        if (expr.length !== 2) {
            return unsupported('MLT ! filters require exactly one child expression.');
        }
        if (containsLegacyTarget(expr[1])) {
            return unsupported('MLT ! filters require expression-style accessors for parity with the legacy filter path.');
        }
        return getExpressionSupport(expr[1], globalState, scope);
    }

    if (op === 'match') {
        if (isSimpleMatchFilter(expr)) {
            return getBooleanMatchSupport(expr);
        }
        return getGeneralBooleanMatchSupport(expr, globalState, scope);
    }

    if (op === 'case') {
        if (isSimpleCaseFilter(expr)) {
            return getBooleanCaseSupport(expr, globalState, scope);
        }
        return getScalarCaseSupport(expr, globalState, scope);
    }

    if (op === 'coalesce') {
        return getCoalesceSupport(expr, globalState, scope);
    }

    return unsupported(`Unsupported MLT filter operator: ${op}`);
}

export function getMltFilterSupport(filter: FilterSpecification | void, globalState?: Record<string, unknown>): MltFilterSupport {
    if (!filter) return {supported: true};

    try {
        featureFilter(filter, 'MLT columnar filter', globalState);
    } catch (error) {
        return unsupported(`Invalid style filter: ${error instanceof Error ? error.message : String(error)}`);
    }

    return getExpressionSupport(filter, globalState);
}

/** Identifies what a filter expression targets: a named property, geometry type, or feature ID. */
type FilterTarget =
    | { kind: 'property'; name: string }
    | { kind: 'dynamic-property-name'; name: string }
    | { kind: 'geometry-type' }
    | { kind: 'id' };

type ScalarExpression =
    | { kind: 'literal'; value: unknown }
    | { kind: 'zoom' }
    | { kind: 'is-supported-script'; arg: ScalarExpression }
    | { kind: 'property'; name: string }
    | { kind: 'geometry-type' }
    | { kind: 'id' }
    | { kind: 'var'; name: string }
    | { kind: 'let'; bindings: ScalarBinding[]; body: ScalarExpression }
    | { kind: 'boolean-filter'; filter: NormalizedFilter }
    | { kind: 'dynamic-membership'; operator: 'in' | '!in'; needle: ScalarExpression; haystack: ScalarExpression }
    | { kind: 'case'; branches: Array<{condition: NormalizedFilter; output: ScalarExpression}>; fallback: ScalarExpression }
    | { kind: 'match'; input: ScalarExpression; branches: MatchBranch[]; fallback: ScalarExpression }
    | { kind: 'typeof'; arg: ScalarExpression }
    | { kind: 'assertion'; assertionType: 'number' | 'string' | 'boolean'; args: ScalarExpression[] }
    | { kind: 'to-number'; args: ScalarExpression[] }
    | { kind: 'to-string'; arg: ScalarExpression }
    | { kind: 'to-boolean'; arg: ScalarExpression }
    | { kind: 'coalesce'; args: ScalarExpression[] }
    | { kind: 'step'; input: ScalarExpression; stops: Array<{label: number; output: ScalarExpression}> }
    | { kind: 'interpolate'; interpolation: {kind: 'linear'} | {kind: 'exponential'; base: number}; input: ScalarExpression; stops: Array<{label: number; output: ScalarExpression}> }
    | { kind: 'numeric'; operator: string; args: ScalarExpression[] }
    | { kind: 'length'; arg: ScalarExpression }
    | { kind: 'slice'; input: ScalarExpression; start: ScalarExpression; end?: ScalarExpression }
    | { kind: 'index-of'; needle: ScalarExpression; haystack: ScalarExpression; fromIndex?: ScalarExpression }
    | { kind: 'string-case'; operator: 'upcase' | 'downcase'; arg: ScalarExpression }
    | { kind: 'concat'; args: ScalarExpression[] };

/** A normalized leaf filter that compares a single target against one or more values. */
type NormalizedLeafFilter = {
    operator: string;
    target: FilterTarget;
    values: unknown[];
};

type NormalizedComputedComparisonFilter = {
    operator: 'computed-comparison';
    comparisonOperator: string;
    left: ScalarExpression;
    right: ScalarExpression;
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

type NormalizedLetFilter = {
    operator: 'let';
    bindings: ScalarBinding[];
    body: NormalizedFilter;
};

type NormalizedWithinFilter = {
    operator: 'within';
    geometry: WithinGeometry;
};

type NormalizedFilter = NormalizedLeafFilter | NormalizedComputedComparisonFilter | NormalizedCompoundFilter | NormalizedConstantFilter | NormalizedLetFilter | NormalizedWithinFilter;

function isComplexFilter(filter: NormalizedFilter): boolean {
    const op = filter.operator;
    if (op === 'computed-comparison' || op === 'let' || op === 'within') {
        return true;
    }
    if (op === 'all' || op === 'any' || op === 'none') {
        return (filter as NormalizedCompoundFilter).children.some(isComplexFilter);
    }
    if (op === '==' || op === '!=' || op === 'in' || op === '!in' || op === '<' || op === '<=' || op === '>' || op === '>=') {
        const leaf = filter;
        if (leaf.values.includes(null)) {
            return true;
        }
    }
    return false;
}

const GEOMETRY_TYPE_POINT = SINGLE_PART_GEOMETRY_TYPE.POINT;
const GEOMETRY_TYPE_LINESTRING = SINGLE_PART_GEOMETRY_TYPE.LINESTRING;
const GEOMETRY_TYPE_POLYGON = SINGLE_PART_GEOMETRY_TYPE.POLYGON;
const EMPTY_UINT32 = new Uint32Array(0);
const EMPTY_SELECTION = new FlatSelectionVector(EMPTY_UINT32);

/**
 * Resolves a filter expression argument to a {@link FilterTarget}.
 *
 * Handles both legacy string shorthand (`"$type"`, `"$id"`, `"propName"`)
 * and expression-style accessors (`["get", "propName"]`, `["geometry-type"]`, `["id"]`).
 *
 * @param arg - The raw expression argument (string or accessor array)
 * @returns The resolved filter target
 * @throws If the accessor type is not recognized
 */
function normalizeTarget(arg: unknown): FilterTarget {
    if (!Array.isArray(arg)) {
        const name = arg as string;
        if (name !== '$type' && name !== 'geometry-type' && name !== '$id') {
            return {kind: 'property', name};
        }
        if (name === '$type' || name === 'geometry-type') {
            return {kind: 'geometry-type'};
        }
        return {kind: 'id'};
    }

    const accessor = arg[0] as string;
    if (accessor === 'get') return {kind: 'property', name: arg[1] as string};
    if (accessor === 'geometry-type') return {kind: 'geometry-type'};
    if (accessor === 'id') return {kind: 'id'};
    throw new Error(`Unsupported accessor: ${accessor}`);
}

function normalizeStepExpression(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): ScalarExpression {
    const stops = [{
        label: -Infinity,
        output: normalizeScalarExpression(expr[2], globalState, scope)
    }];
    for (let i = 3; i < expr.length; i += 2) {
        stops.push({
            label: expr[i] as number,
            output: normalizeScalarExpression(expr[i + 1], globalState, scope)
        });
    }

    return {
        kind: 'step',
        input: normalizeScalarExpression(expr[1], globalState, scope),
        stops
    };
}

function normalizeInterpolateExpression(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): ScalarExpression {
    const interpolation = expr[1] as unknown[];
    const stops = [];
    for (let i = 3; i < expr.length; i += 2) {
        stops.push({
            label: expr[i] as number,
            output: normalizeScalarExpression(expr[i + 1], globalState, scope)
        });
    }

    return {
        kind: 'interpolate',
        interpolation: interpolation[0] === 'exponential'
            ? {kind: 'exponential', base: interpolation[1] as number}
            : {kind: 'linear'},
        input: normalizeScalarExpression(expr[2], globalState, scope),
        stops
    };
}

function normalizeMatchLabels(label: unknown): unknown[] {
    return Array.isArray(label) ? label : [label];
}

function normalizeScalarMatchExpression(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): ScalarExpression {
    const branches: MatchBranch[] = [];
    for (let i = 2; i < expr.length - 1; i += 2) {
        branches.push({
            labels: normalizeMatchLabels(expr[i]),
            output: normalizeScalarExpression(expr[i + 1], globalState, scope)
        });
    }

    return {
        kind: 'match',
        input: normalizeScalarExpression(expr[1], globalState, scope),
        branches,
        fallback: normalizeScalarExpression(expr[expr.length - 1], globalState, scope)
    };
}

function normalizeScalarCaseExpression(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): ScalarExpression {
    const branches = [];
    for (let i = 1; i < expr.length - 1; i += 2) {
        branches.push({
            condition: normalizeExpression(expr[i] as ExpressionSpecification | boolean, globalState, scope),
            output: normalizeScalarExpression(expr[i + 1], globalState, scope)
        });
    }

    return {
        kind: 'case',
        branches,
        fallback: normalizeScalarExpression(expr[expr.length - 1], globalState, scope)
    };
}

function normalizeDynamicMembershipExpression(expr: unknown[], globalState: Record<string, unknown> | undefined, scope: VariableScope): ScalarExpression {
    return {
        kind: 'dynamic-membership',
        operator: expr[0] as 'in' | '!in',
        needle: normalizeScalarExpression(expr[1], globalState, scope),
        haystack: normalizeScalarExpression(expr[2], globalState, scope)
    };
}

function normalizeScalarExpression(expr: unknown, globalState?: Record<string, unknown>, scope: VariableScope = new Set()): ScalarExpression {
    if (isLiteralValue(expr)) {
        return {kind: 'literal', value: expr};
    }
    if (!Array.isArray(expr)) {
        throw new Error(`Unsupported scalar expression: ${String(expr)}`);
    }

    const op = expr[0] as string;
    if (op === 'zoom') {
        return {kind: 'zoom'};
    }
    if (op === 'is-supported-script') {
        return {kind: 'is-supported-script', arg: normalizeScalarExpression(expr[1], globalState, scope)};
    }
    if (op === 'literal') {
        return {kind: 'literal', value: expr[1]};
    }
    if (op === 'global-state') {
        return {kind: 'literal', value: resolveGlobalStateValue(expr, globalState)};
    }
    if (op === 'var') {
        if (expr.length !== 2 || typeof expr[1] !== 'string') {
            throw new Error('MLT var expressions require exactly one variable name.');
        }
        if (!scope.has(expr[1])) {
            throw new Error(`Unknown MLT variable: ${expr[1]}`);
        }
        return {kind: 'var', name: expr[1]};
    }
    if (op === 'let') {
        if (expr.length < 4 || expr.length % 2 !== 0) {
            throw new Error('MLT let expressions require one or more name/value bindings and a body expression.');
        }

        const extendedScope = new Set(scope);
        const bindings: ScalarBinding[] = [];
        for (let i = 1; i < expr.length - 1; i += 2) {
            const name = expr[i];
            if (typeof name !== 'string') {
                throw new Error('MLT let binding names must be strings.');
            }
            bindings.push({
                name,
                value: normalizeScalarExpression(expr[i + 1], globalState, scope)
            });
            extendedScope.add(name);
        }

        return {
            kind: 'let',
            bindings,
            body: normalizeScalarExpression(expr[expr.length - 1], globalState, extendedScope)
        };
    }
    if (op === 'case') {
        return normalizeScalarCaseExpression(expr, globalState, scope);
    }
    if (op === 'match') {
        return normalizeScalarMatchExpression(expr, globalState, scope);
    }
    if (op === 'in') {
        return normalizeDynamicMembershipExpression(expr, globalState, scope);
    }
    if (op === '!in' && isDynamicMembershipExpression(expr)) {
        return normalizeDynamicMembershipExpression(expr, globalState, scope);
    }
    if (
        COMPARISON_OPERATORS.has(op) ||
        MEMBERSHIP_OPERATORS.has(op) ||
        EXISTENCE_OPERATORS.has(op) ||
        COMPOUND_OPERATORS.has(op) ||
        op === 'within' ||
        op === '!'
    ) {
        return {
            kind: 'boolean-filter',
            filter: normalizeExpression(expr as ExpressionSpecification, globalState, scope)
        };
    }
    if (op === 'get') {
        if (expr.length !== 2 || typeof expr[1] !== 'string') {
            throw new Error('MLT scalar expressions only support ["get", string] property accessors.');
        }
        return {kind: 'property', name: expr[1]};
    }
    if (op === 'id') {
        if (expr.length !== 1) {
            throw new Error('MLT scalar expressions only support ["id"] without arguments.');
        }
        return {kind: 'id'};
    }
    if (op === 'geometry-type') {
        if (expr.length !== 1) {
            throw new Error('MLT scalar expressions only support ["geometry-type"] without arguments.');
        }
        return {kind: 'geometry-type'};
    }
    if (op === 'typeof') {
        return {kind: 'typeof', arg: normalizeScalarExpression(expr[1], globalState, scope)};
    }
    if (op === 'number' || op === 'string' || op === 'boolean') {
        return {
            kind: 'assertion',
            assertionType: op,
            args: expr.slice(1).map(arg => normalizeScalarExpression(arg, globalState, scope))
        };
    }
    if (op === 'to-number') {
        return {
            kind: 'to-number',
            args: expr.slice(1).map(arg => normalizeScalarExpression(arg, globalState, scope))
        };
    }
    if (op === 'to-string') {
        return {kind: 'to-string', arg: normalizeScalarExpression(expr[1], globalState, scope)};
    }
    if (op === 'to-boolean') {
        return {kind: 'to-boolean', arg: normalizeScalarExpression(expr[1], globalState, scope)};
    }
    if (op === 'coalesce') {
        return {
            kind: 'coalesce',
            args: expr.slice(1).map(arg => normalizeScalarExpression(arg, globalState, scope))
        };
    }
    if (op === 'step') {
        return normalizeStepExpression(expr, globalState, scope);
    }
    if (op === 'interpolate') {
        return normalizeInterpolateExpression(expr, globalState, scope);
    }
    if (NUMERIC_SCALAR_OPERATORS.has(op)) {
        return {
            kind: 'numeric',
            operator: op,
            args: expr.slice(1).map(arg => normalizeScalarExpression(arg, globalState, scope))
        };
    }
    if (op === 'length') {
        return {kind: 'length', arg: normalizeScalarExpression(expr[1], globalState, scope)};
    }
    if (op === 'slice') {
        return {
            kind: 'slice',
            input: normalizeScalarExpression(expr[1], globalState, scope),
            start: normalizeScalarExpression(expr[2], globalState, scope),
            end: expr.length === 4 ? normalizeScalarExpression(expr[3], globalState, scope) : undefined
        };
    }
    if (op === 'index-of') {
        return {
            kind: 'index-of',
            needle: normalizeScalarExpression(expr[1], globalState, scope),
            haystack: normalizeScalarExpression(expr[2], globalState, scope),
            fromIndex: expr.length === 4 ? normalizeScalarExpression(expr[3], globalState, scope) : undefined
        };
    }
    if (STRING_SCALAR_OPERATORS.has(op)) {
        return {
            kind: 'string-case',
            operator: op as 'upcase' | 'downcase',
            arg: normalizeScalarExpression(expr[1], globalState, scope)
        };
    }
    if (op === 'concat') {
        return {
            kind: 'concat',
            args: expr.slice(1).map(arg => normalizeScalarExpression(arg, globalState, scope))
        };
    }

    throw new Error(`Unsupported scalar expression operator: ${op}`);
}

function normalizeExistenceExpression(expr: ExpressionSpecification): NormalizedFilter {
    const op = expr[0] as string;
    const target = expr[1];

    if (typeof target === 'string') {
        if (target === '$type') {
            return {operator: 'constant', value: op === 'has'};
        }
        return {
            operator: op,
            target: normalizeTarget(target),
            values: [],
        };
    }

    if (!Array.isArray(target)) {
        throw new Error(`Unsupported non-string filter target: ${String(target)}`);
    }

    if (target[0] === 'literal' && target.length === 2 && typeof target[1] === 'string') {
        return {
            operator: op,
            target: {kind: 'property', name: target[1]},
            values: [],
        };
    }

    if (target[0] === 'get' && target.length === 2 && typeof target[1] === 'string') {
        if (op === '!has') {
            throw new Error('MLT dynamic !has filters require expression-style ["!", ["has", ["get", string]]].');
        }
        return {
            operator: op,
            target: {kind: 'dynamic-property-name', name: target[1]},
            values: [],
        };
    }

    throw new Error(`Unsupported MLT ${op} filter target expression: ${String(target[0])}`);
}

function isDynamicHasExpression(expr: unknown): expr is ExpressionSpecification {
    return Array.isArray(expr) &&
        expr[0] === 'has' &&
        Array.isArray(expr[1]) &&
        expr[1][0] === 'get' &&
        expr[1].length === 2 &&
        typeof expr[1][1] === 'string';
}

function normalizeDynamicNotHasExpression(expr: ExpressionSpecification): NormalizedLeafFilter {
    return {
        operator: '!has',
        target: {kind: 'dynamic-property-name', name: (expr[1] as unknown[])[1] as string},
        values: [],
    };
}

/**
 * Extracts the comparison value(s) from a filter expression.
 *
 * For comparison operators (`==`, `!=`, `>=`, `<=`, `>`, `<`) returns a
 * single-element array. For `has`/`!has` returns an empty array. For `in`/`!in`
 * handles both legacy variadic form and expression-style `["literal", [...]]`.
 *
 * @param expr - The full filter expression
 * @param op - The operator string
 * @returns Array of values to compare against
 */
function resolveGlobalStateValue(value: unknown, globalState: Record<string, unknown> | undefined): unknown {
    if (!Array.isArray(value) || value[0] !== 'global-state') {
        return value;
    }
    if (value.length !== 2 || typeof value[1] !== 'string') {
        throw new Error('MLT filters only support ["global-state", string] values.');
    }
    if (!globalState || !Object.hasOwn(globalState, value[1])) {
        throw new Error(`MLT global-state filter value "${value[1]}" is not available.`);
    }
    const resolved = globalState[value[1]];
    if (!isLiteralScalarExpressionValue(resolved)) {
        throw new Error('MLT global-state filter values must resolve to primitive values or primitive arrays.');
    }
    return resolved;
}

function normalizeValues(expr: ExpressionSpecification, op: string, globalState: Record<string, unknown> | undefined): unknown[] {
    if (
        op === '==' ||
        op === '!=' ||
        op === '>=' ||
        op === '<=' ||
        op === '>' ||
        op === '<'
    ) {
        return [resolveGlobalStateValue(expr[2], globalState)];
    }
    if (op === 'has' || op === '!has') return [];

    const isExpr = Array.isArray(expr[1]);
    if (isExpr) {
        const literalArg = expr[2] as unknown[];
        if (Array.isArray(literalArg) && literalArg[0] === 'literal') {
            return literalArg[1] as unknown[];
        }
        return [resolveGlobalStateValue(literalArg, globalState)];
    }

    const len = expr.length;
    const result = new Array(len - 2);
    for (let i = 2; i < len; i++) {
        result[i - 2] = resolveGlobalStateValue(expr[i], globalState);
    }
    return result;
}

/**
 * Normalizes a `match` expression into an equivalent `in` or `!in` leaf filter.
 *
 * Scans label/output pairs and collects labels that map to `true` vs `false`.
 * If the fallback is `true`, inverts to `!in` with false-labels; otherwise
 * uses `in` with true-labels.
 *
 * @param expr - A `["match", target, label1, output1, ..., fallback]` expression
 * @returns A normalized leaf filter equivalent to the match expression
 */
function normalizeMatch(expr: ExpressionSpecification): NormalizedLeafFilter {
    const target = normalizeTarget(expr[1]);
    const fallback = expr[expr.length - 1];
    const trueValues: unknown[] = [];
    const falseValues: unknown[] = [];

    for (let i = 2; i < expr.length - 1; i += 2) {
        const label = expr[i];
        const output = expr[i + 1];

        if (output === true) {
            if (Array.isArray(label)) {
                trueValues.push(...label);
            } else {
                trueValues.push(label);
            }
        } else if (output === false) {
            if (Array.isArray(label)) {
                falseValues.push(...label);
            } else {
                falseValues.push(label);
            }
        }
    }

    return {
        operator: fallback === true ? '!in' : 'in',
        target,
        values: fallback === true ? falseValues : trueValues,
    };
}

function normalizeCase(expr: ExpressionSpecification, globalState?: Record<string, unknown>, scope: VariableScope = new Set()): NormalizedFilter {
    const fallback = expr[expr.length - 1];
    if (typeof fallback !== 'boolean') {
        throw new Error('MLT case filters only support boolean outputs.');
    }

    const previousConditions: NormalizedFilter[] = [];
    const trueClauses: NormalizedFilter[] = [];

    for (let i = 1; i < expr.length - 1; i += 2) {
        const condition = normalizeExpression(expr[i] as ExpressionSpecification | boolean, globalState, scope);
        const output = expr[i + 1];
        if (typeof output !== 'boolean') {
            throw new Error('MLT case filters only support boolean outputs.');
        }

        if (output) {
            const clauseChildren = [
                ...previousConditions.map((condition) => ({operator: 'none' as const, children: [condition]})),
                condition,
            ];
            trueClauses.push(clauseChildren.length === 1 ? condition : {operator: 'all', children: clauseChildren});
        }

        previousConditions.push(condition);
    }

    if (fallback) {
        const fallbackClause = previousConditions.map((condition) => ({operator: 'none' as const, children: [condition]}));
        trueClauses.push(fallbackClause.length === 0 ? {operator: 'constant', value: true} : {operator: 'all', children: fallbackClause});
    }

    if (trueClauses.length === 0) {
        return {operator: 'constant', value: false};
    }
    return trueClauses.length === 1 ? trueClauses[0] : {operator: 'any', children: trueClauses};
}

function normalizeCoalesce(expr: ExpressionSpecification, globalState?: Record<string, unknown>, scope: VariableScope = new Set()): NormalizedFilter {
    for (let i = 1; i < expr.length; i++) {
        const arg = expr[i];
        if (arg === null) continue;

        if (Array.isArray(arg) && arg[0] === 'get') {
            const nullableAccessor = normalizeTarget(arg);
            for (let j = i + 1; j < expr.length; j++) {
                const fallback = expr[j];
                if (fallback === null) continue;
                const resolvedFallback = resolveBooleanExpressionValue(fallback, globalState);
                if (resolvedFallback === false) {
                    return {
                        operator: '==',
                        target: nullableAccessor,
                        values: [true],
                    };
                }
                if (resolvedFallback === true) {
                    return {
                        operator: '!=',
                        target: nullableAccessor,
                        values: [false],
                    };
                }
                return {
                    operator: 'computed-comparison',
                    comparisonOperator: '==',
                    left: normalizeScalarExpression(expr, globalState, scope),
                    right: {kind: 'literal', value: true},
                };
            }

            return {
                operator: '==',
                target: nullableAccessor,
                values: [true],
            };
        }

        return normalizeExpression(arg as ExpressionSpecification | boolean, globalState, scope);
    }

    throw new Error('MLT coalesce filters require at least one non-null boolean argument.');
}

/**
 * Recursively normalizes a MapLibre GL style filter expression into a
 * {@link NormalizedFilter} tree.
 *
 * Converts all supported expression forms (comparison, membership, existence,
 * compound, and `match`) into a uniform internal representation. The `!`
 * operator is mapped to `none`.
 *
 * @param expr - A MapLibre GL style expression
 * @returns The normalized filter tree
 * @throws If the operator is not supported
 */
function normalizeExpression(expr: ExpressionSpecification | boolean, globalState?: Record<string, unknown>, scope: VariableScope = new Set()): NormalizedFilter {
    if (typeof expr === 'boolean') {
        return {operator: 'constant', value: expr};
    }

    const op = expr[0] as string;

    if (op === 'within') {
        const geometry = normalizeWithinGeometry(expr[1] as GeoJSON.GeoJSON);
        if (!geometry) throw new Error('MLT within filters require valid Polygon or MultiPolygon GeoJSON.');
        return {operator: 'within', geometry};
    }

    if (op === 'literal') {
        return {operator: 'constant', value: expr[1] === true};
    }

    if (op === 'boolean' || op === 'to-boolean' || op === 'is-supported-script') {
        return {
            operator: 'computed-comparison',
            comparisonOperator: '==',
            left: normalizeScalarExpression(expr, globalState, scope),
            right: {kind: 'literal', value: true},
        };
    }

    if (op === 'global-state') {
        return {
            operator: 'constant',
            value: resolveGlobalStateValue(expr, globalState) === true,
        };
    }

    if (op === 'let') {
        if (expr.length < 4 || expr.length % 2 !== 0) {
            throw new Error('MLT let expressions require one or more name/value bindings and a body expression.');
        }

        const extendedScope = new Set(scope);
        const bindings: ScalarBinding[] = [];
        for (let i = 1; i < expr.length - 1; i += 2) {
            const name = expr[i];
            if (typeof name !== 'string') {
                throw new Error('MLT let binding names must be strings.');
            }
            bindings.push({
                name,
                value: normalizeScalarExpression(expr[i + 1], globalState, scope)
            });
            extendedScope.add(name);
        }

        return {
            operator: 'let',
            bindings,
            body: normalizeExpression(expr[expr.length - 1] as ExpressionSpecification | boolean, globalState, extendedScope)
        };
    }

    if (
        op === '==' ||
        op === '!=' ||
        op === '>=' ||
        op === '<=' ||
        op === '>' ||
        op === '<'
    ) {
        if (isComputedComparisonExpression(expr)) {
            return {
                operator: 'computed-comparison',
                comparisonOperator: op,
                left: normalizeScalarExpression(expr[1], globalState, scope),
                right: normalizeScalarExpression(expr[2], globalState, scope),
            };
        }

        return {
            operator: op,
            target: normalizeTarget(expr[1]),
            values: normalizeValues(expr, op, globalState),
        };
    }

    if ((op === 'in' || op === '!in') && isDynamicMembershipExpression(expr)) {
        return {
            operator: 'computed-comparison',
            comparisonOperator: '==',
            left: normalizeDynamicMembershipExpression(expr, globalState, scope),
            right: {kind: 'literal', value: true},
        };
    }

    if (op === 'in' || op === '!in') {
        return {
            operator: op,
            target: normalizeTarget(expr[1]),
            values: normalizeValues(expr, op, globalState),
        };
    }

    if (op === 'has' || op === '!has') return normalizeExistenceExpression(expr);

    if (op === '!' && expr.length === 2 && isDynamicHasExpression(expr[1])) {
        return normalizeDynamicNotHasExpression(expr[1]);
    }

    if (op === 'all' || op === 'any' || op === 'none' || op === '!') {
        const len = expr.length;
        const children = new Array<NormalizedFilter>(len - 1);
        for (let i = 1; i < len; i++) {
            children[i - 1] = normalizeExpression(
                expr[i] as ExpressionSpecification,
                globalState,
                scope,
            );
        }
        return {
            operator: op === '!' ? 'none' : op,
            children,
        };
    }

    if (op === 'match') {
        if (isSimpleMatchFilter(expr)) {
            return normalizeMatch(expr);
        }
        return {
            operator: 'computed-comparison',
            comparisonOperator: '==',
            left: normalizeScalarMatchExpression(expr, globalState, scope),
            right: {kind: 'literal', value: true},
        };
    }

    if (op === 'case') {
        if (isSimpleCaseFilter(expr)) {
            return normalizeCase(expr, globalState, scope);
        }
        return {
            operator: 'computed-comparison',
            comparisonOperator: '==',
            left: normalizeScalarCaseExpression(expr, globalState, scope),
            right: {kind: 'literal', value: true},
        };
    }

    if (op === 'coalesce') return normalizeCoalesce(expr, globalState, scope);

    if (op === 'var') {
        return {
            operator: 'computed-comparison',
            comparisonOperator: '==',
            left: normalizeScalarExpression(expr, globalState, scope),
            right: {kind: 'literal', value: true},
        };
    }

    throw new Error(`Unsupported filter operator: ${op}`);
}

/**
 * Maps a GeoJSON geometry type name to the corresponding {@link SINGLE_PART_GEOMETRY_TYPE} enum.
 *
 * Uses first-character dispatch for fast matching. Multi-part types
 * (`MultiPoint`, `MultiLineString`, `MultiPolygon`) are mapped to their
 * single-part equivalents.
 *
 * @param geometryType - GeoJSON geometry type name (e.g. `"Point"`, `"MultiPolygon"`)
 * @returns The matching single-part geometry type enum value
 * @throws If the geometry type name is not recognized
 */
function getSinglePartGeometryType(geometryType: string): SINGLE_PART_GEOMETRY_TYPE {
    const firstChar = geometryType.charCodeAt(0);

    if (firstChar === 80) {
        // 'P'
        return geometryType === 'Polygon'
            ? GEOMETRY_TYPE_POLYGON
            : GEOMETRY_TYPE_POINT;
    }
    if (firstChar === 77) {
        // 'M'
        const secondChar = geometryType.charCodeAt(5);
        return secondChar === 80
            ? GEOMETRY_TYPE_POINT
            : secondChar === 111
                ? GEOMETRY_TYPE_POLYGON
                : GEOMETRY_TYPE_LINESTRING;
    }
    if (firstChar === 76) {
        // 'L'
        return GEOMETRY_TYPE_LINESTRING;
    }

    throw new Error('Invalid geometry type');
}

/**
 * Filters features in a {@link FeatureTable} using a MapLibre GL style filter expression.
 *
 * Returns a {@link SelectionVector} containing the indices of all features
 * that match the expression. If no expression is provided, selects all features.
 *
 * Supported operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `!in`,
 * `has`, `!has`, `all`, `any`, `none`/`!`, `match`.
 * Special targets: `$type` / `geometry-type` for geometry filtering, `$id` for ID filtering.
 *
 * @param featureTable - The feature table to filter
 * @param expression - A MapLibre GL style filter expression
 * @returns A SelectionVector with matching feature indices
 */
class WithinEvaluationContext {
    private readonly evaluators = new WeakMap<WithinGeometry, ColumnarWithinEvaluator>();

    constructor(private readonly canonical: CanonicalWithinTileID) {}

    evaluate(featureTable: FeatureTable, featureIndex: number, geometry: WithinGeometry): boolean {
        let evaluator = this.evaluators.get(geometry);
        if (!evaluator) {
            evaluator = new ColumnarWithinEvaluator(geometry, this.canonical);
            this.evaluators.set(geometry, evaluator);
        }
        return evaluator.evaluate(featureTable, featureIndex);
    }
}

export type MltFilterEvaluator = {
    matches(featureTable: FeatureTable, featureIndex: number): boolean;
};

/** Shares tile geometry and runtime globals across rows, including nested let scopes. */
function createFilterEnvironment(canonical?: CanonicalWithinTileID, globals?: GlobalProperties): ScalarEnvironment | undefined {
    if (!canonical && !globals) return undefined;
    const environment = new Map<string | symbol, unknown>();
    if (canonical) environment.set(WITHIN_CONTEXT, new WithinEvaluationContext(canonical));
    if (globals) environment.set(GLOBALS_CONTEXT, globals);
    return environment;
}

/** Evaluates selected rows using the caller's effective zoom and script support callback. */
export function createMltFilterEvaluator(expression: ExpressionSpecification, globalState?: Record<string, unknown>, canonical?: CanonicalWithinTileID, globals?: GlobalProperties): MltFilterEvaluator {
    const normalized = normalizeExpression(expression, globalState);
    const environment = createFilterEnvironment(canonical, globals);

    return {
        matches(featureTable: FeatureTable, featureIndex: number): boolean {
            return featureMatchesFilter(featureTable, normalized, featureIndex, environment) === true;
        }
    };
}

/** Filters columns directly; runtime globals must use the effective zoom, not the canonical tile zoom. */
export default function filter(featureTable: FeatureTable, expression: ExpressionSpecification, globalState?: Record<string, unknown>, canonical?: CanonicalWithinTileID, globals?: GlobalProperties): SelectionVector {
    if (!expression) {
        return new SequenceSelectionVector(0, 1, featureTable.numFeatures);
    }
    const normalized = normalizeExpression(expression, globalState);
    const environment = createFilterEnvironment(canonical, globals);
    return executeFilter(featureTable, normalized, undefined, environment);
}

/**
 * Dispatches a normalized filter to the appropriate executor (compound or leaf).
 *
 * @param featureTable - The feature table to filter against
 * @param normalized - The normalized filter tree node
 * @param selectionVector - Optional pre-existing selection to narrow (used by `all`)
 * @returns A SelectionVector with matching feature indices
 */
function executeComplexFilter(featureTable: FeatureTable, normalized: NormalizedFilter, selectionVector?: SelectionVector, environment?: ScalarEnvironment): SelectionVector {
    if (selectionVector) {
        const selectionValues = selectionVector.selectionValues();
        const limit = selectionVector.limit;
        let writeIndex = 0;

        for (let i = 0; i < limit; i++) {
            const featureIndex = selectionValues[i];
            if (featureMatchesFilter(featureTable, normalized, featureIndex, environment) === true) {
                selectionVector.setIndex(writeIndex++, featureIndex);
            }
        }

        selectionVector.setLimit(writeIndex);
        return selectionVector;
    }

    const selection = new Uint32Array(featureTable.numFeatures);
    let writeIndex = 0;

    for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
        if (featureMatchesFilter(featureTable, normalized, featureIndex, environment) === true) {
            selection[writeIndex++] = featureIndex;
        }
    }

    return new FlatSelectionVector(selection, writeIndex);
}

function executeFilter(featureTable: FeatureTable, normalized: NormalizedFilter, selectionVector?: SelectionVector, environment?: ScalarEnvironment): SelectionVector {
    if (isComplexFilter(normalized)) {
        return executeComplexFilter(featureTable, normalized, selectionVector, environment);
    }

    const op = normalized.operator;

    if (op === 'constant') {
        return executeConstant(featureTable, normalized as NormalizedConstantFilter, selectionVector);
    }

    if (op === 'computed-comparison') {
        return executeComputedComparison(featureTable, normalized as NormalizedComputedComparisonFilter, selectionVector, environment);
    }

    if (op === 'let') {
        return executeLet(featureTable, normalized as NormalizedLetFilter, selectionVector, environment);
    }

    if (op === 'all' || op === 'any' || op === 'none') {
        return executeCompound(
            featureTable,
            normalized as NormalizedCompoundFilter,
            environment,
        );
    }

    return executeLeaf(
        featureTable,
        normalized as NormalizedLeafFilter,
        selectionVector,
    );
}

function executeConstant(featureTable: FeatureTable, normalized: NormalizedConstantFilter, selectionVector?: SelectionVector): SelectionVector {
    if (!normalized.value) {
        return EMPTY_SELECTION;
    }

    return selectionVector ?? new SequenceSelectionVector(0, 1, featureTable.numFeatures);
}

function geometryTypeName(featureTable: FeatureTable, featureIndex: number): string | null {
    const geometryType = featureTable.geometryVector.geometryType(featureIndex);
    switch (geometryType) {
        case GEOMETRY_TYPE.POINT:
        case GEOMETRY_TYPE.MULTIPOINT:
            return 'Point';
        case GEOMETRY_TYPE.LINESTRING:
        case GEOMETRY_TYPE.MULTILINESTRING:
            return 'LineString';
        case GEOMETRY_TYPE.POLYGON:
        case GEOMETRY_TYPE.MULTIPOLYGON:
            return 'Polygon';
        default:
            return null;
    }
}

function valueToString(value: unknown): string {
    if (value === null) {
        return '';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

function valueTypeName(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

function evaluateAssertionExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'assertion'}>, featureIndex: number, environment?: ScalarEnvironment): unknown {
    for (const arg of expression.args) {
        const value = evaluateScalarExpression(featureTable, arg, featureIndex, environment);
        if (isEvaluationError(value)) return value;
        if (typeof value === expression.assertionType) {
            return value;
        }
    }
    return EVALUATION_ERROR;
}

function evaluateNumberExpressionArgument(featureTable: FeatureTable, expression: ScalarExpression, featureIndex: number, environment?: ScalarEnvironment): number | EvaluationError {
    const value = evaluateScalarExpression(featureTable, expression, featureIndex, environment);
    if (isEvaluationError(value)) return value;
    return typeof value === 'number' ? value : EVALUATION_ERROR;
}

function evaluateNumericExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'numeric'}>, featureIndex: number, environment?: ScalarEnvironment): number | EvaluationError {
    const args = expression.args;
    switch (expression.operator) {
        case '+': {
            let result = 0;
            for (const arg of args) {
                const value = evaluateNumberExpressionArgument(featureTable, arg, featureIndex, environment);
                if (isEvaluationError(value)) return value;
                result += value;
            }
            return result;
        }
        case '*': {
            let result = 1;
            for (const arg of args) {
                const value = evaluateNumberExpressionArgument(featureTable, arg, featureIndex, environment);
                if (isEvaluationError(value)) return value;
                result *= value;
            }
            return result;
        }
        case '-': {
            const left = evaluateNumberExpressionArgument(featureTable, args[0], featureIndex, environment);
            if (isEvaluationError(left)) return left;
            if (args.length === 1) return -left;

            const right = evaluateNumberExpressionArgument(featureTable, args[1], featureIndex, environment);
            if (isEvaluationError(right)) return right;
            return left - right;
        }
        case '/': {
            const left = evaluateNumberExpressionArgument(featureTable, args[0], featureIndex, environment);
            const right = evaluateNumberExpressionArgument(featureTable, args[1], featureIndex, environment);
            if (isEvaluationError(left)) return left;
            if (isEvaluationError(right)) return right;
            return left / right;
        }
        case '%': {
            const left = evaluateNumberExpressionArgument(featureTable, args[0], featureIndex, environment);
            const right = evaluateNumberExpressionArgument(featureTable, args[1], featureIndex, environment);
            if (isEvaluationError(left)) return left;
            if (isEvaluationError(right)) return right;
            return left % right;
        }
        case 'min': {
            const values = new Array<number>(args.length);
            for (let i = 0; i < args.length; i++) {
                const value = evaluateNumberExpressionArgument(featureTable, args[i], featureIndex, environment);
                if (isEvaluationError(value)) return value;
                values[i] = value;
            }
            return Math.min(...values);
        }
        case 'max': {
            const values = new Array<number>(args.length);
            for (let i = 0; i < args.length; i++) {
                const value = evaluateNumberExpressionArgument(featureTable, args[i], featureIndex, environment);
                if (isEvaluationError(value)) return value;
                values[i] = value;
            }
            return Math.max(...values);
        }
        default:
            throw new Error(`Unsupported numeric scalar operator: ${expression.operator}`);
    }
}

function evaluateStepExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'step'}>, featureIndex: number, environment?: ScalarEnvironment): unknown {
    const input = evaluateScalarExpression(featureTable, expression.input, featureIndex, environment);
    if (typeof input !== 'number') return EVALUATION_ERROR;

    const stops = expression.stops;
    let output = stops[0].output;
    for (let i = 1; i < stops.length; i++) {
        if (input < stops[i].label) break;
        output = stops[i].output;
    }

    return evaluateScalarExpression(featureTable, output, featureIndex, environment);
}

function interpolationFactor(interpolation: Extract<ScalarExpression, {kind: 'interpolate'}>['interpolation'], input: number, lower: number, upper: number): number {
    if (upper === lower) return 0;
    if (interpolation.kind === 'linear' || interpolation.base === 1) {
        return (input - lower) / (upper - lower);
    }

    return (Math.pow(interpolation.base, input - lower) - 1) / (Math.pow(interpolation.base, upper - lower) - 1);
}

function evaluateInterpolateExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'interpolate'}>, featureIndex: number, environment?: ScalarEnvironment): unknown {
    const input = evaluateScalarExpression(featureTable, expression.input, featureIndex, environment);
    if (typeof input !== 'number') return EVALUATION_ERROR;

    const stops = expression.stops;
    if (input <= stops[0].label) {
        return evaluateScalarExpression(featureTable, stops[0].output, featureIndex, environment);
    }
    const lastStop = stops[stops.length - 1];
    if (input >= lastStop.label) {
        return evaluateScalarExpression(featureTable, lastStop.output, featureIndex, environment);
    }

    let lowerIndex = 0;
    for (let i = 1; i < stops.length; i++) {
        if (input < stops[i].label) break;
        lowerIndex = i;
    }

    const lower = stops[lowerIndex];
    const upper = stops[lowerIndex + 1];
    const lowerValue = evaluateScalarExpression(featureTable, lower.output, featureIndex, environment);
    const upperValue = evaluateScalarExpression(featureTable, upper.output, featureIndex, environment);
    if (typeof lowerValue !== 'number' || typeof upperValue !== 'number') return EVALUATION_ERROR;

    return lowerValue + (upperValue - lowerValue) * interpolationFactor(expression.interpolation, input, lower.label, upper.label);
}

function evaluateIntegerIndex(featureTable: FeatureTable, expression: ScalarExpression, featureIndex: number, environment?: ScalarEnvironment): number | null {
    const value = evaluateScalarExpression(featureTable, expression, featureIndex, environment);
    return typeof value === 'number' ? value : null;
}

function evaluateSliceExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'slice'}>, featureIndex: number, environment?: ScalarEnvironment): unknown {
    const input = evaluateScalarExpression(featureTable, expression.input, featureIndex, environment);
    const start = evaluateIntegerIndex(featureTable, expression.start, featureIndex, environment);
    const end = expression.end ? evaluateIntegerIndex(featureTable, expression.end, featureIndex, environment) : undefined;
    if (typeof input !== 'string' || start === null || (expression.end && end === null)) {
        return EVALUATION_ERROR;
    }

    return [...input].slice(start, end).join('');
}

function evaluateIndexOfExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'index-of'}>, featureIndex: number, environment?: ScalarEnvironment): unknown {
    const needle = evaluateScalarExpression(featureTable, expression.needle, featureIndex, environment);
    const haystack = evaluateScalarExpression(featureTable, expression.haystack, featureIndex, environment);
    const fromIndex = expression.fromIndex ? evaluateIntegerIndex(featureTable, expression.fromIndex, featureIndex, environment) : undefined;
    if (
        (needle !== null && typeof needle !== 'string' && typeof needle !== 'number' && typeof needle !== 'boolean') ||
        typeof haystack !== 'string' ||
        (expression.fromIndex && fromIndex === null)
    ) {
        return EVALUATION_ERROR;
    }

    const rawIndex = haystack.indexOf(String(needle), fromIndex ?? 0);
    return rawIndex === -1 ? -1 : [...haystack.slice(0, rawIndex)].length;
}

function evaluateLetBindings(featureTable: FeatureTable, bindings: ScalarBinding[], featureIndex: number, environment?: ScalarEnvironment): ScalarEnvironment {
    const childEnvironment = new Map(environment);
    for (const binding of bindings) {
        childEnvironment.set(binding.name, evaluateScalarExpression(featureTable, binding.value, featureIndex, environment));
    }
    return childEnvironment;
}

function evaluateDynamicMembershipExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'dynamic-membership'}>, featureIndex: number, environment?: ScalarEnvironment): unknown {
    const needle = evaluateScalarExpression(featureTable, expression.needle, featureIndex, environment);
    const haystack = evaluateScalarExpression(featureTable, expression.haystack, featureIndex, environment);
    if (isEvaluationError(needle) || isEvaluationError(haystack)) return EVALUATION_ERROR;

    let matches = false;
    if (typeof haystack === 'string') {
        matches = typeof needle === 'string' && haystack.includes(needle);
    } else if (Array.isArray(haystack)) {
        matches = haystack.some(candidate => candidate === needle);
    } else {
        matches = false;
    }

    return expression.operator === 'in' ? matches : !matches;
}

function evaluateScalarCaseExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'case'}>, featureIndex: number, environment?: ScalarEnvironment): unknown {
    for (const branch of expression.branches) {
        const conditionResult = featureMatchesFilter(featureTable, branch.condition, featureIndex, environment);
        if (isEvaluationError(conditionResult)) {
            return conditionResult;
        }
        if (conditionResult === true) {
            return evaluateScalarExpression(featureTable, branch.output, featureIndex, environment);
        }
    }

    return evaluateScalarExpression(featureTable, expression.fallback, featureIndex, environment);
}

function evaluateScalarMatchExpression(featureTable: FeatureTable, expression: Extract<ScalarExpression, {kind: 'match'}>, featureIndex: number, environment?: ScalarEnvironment): unknown {
    const input = evaluateScalarExpression(featureTable, expression.input, featureIndex, environment);
    if (isEvaluationError(input)) return input;

    for (const branch of expression.branches) {
        if (branch.labels.some(label => label === input)) {
            return evaluateScalarExpression(featureTable, branch.output, featureIndex, environment);
        }
    }

    return evaluateScalarExpression(featureTable, expression.fallback, featureIndex, environment);
}

function evaluateScalarExpression(featureTable: FeatureTable, expression: ScalarExpression, featureIndex: number, environment?: ScalarEnvironment): unknown {
    switch (expression.kind) {
        case 'literal':
            return expression.value;
        case 'zoom':
            return (environment?.get(GLOBALS_CONTEXT) as GlobalProperties | undefined)?.zoom;
        case 'is-supported-script': {
            const callback = (environment?.get(GLOBALS_CONTEXT) as GlobalProperties | undefined)?.isSupportedScript;
            if (!callback) return true;
            const value = evaluateScalarExpression(featureTable, expression.arg, featureIndex, environment);
            return typeof value === 'string' ? callback(value) : EVALUATION_ERROR;
        }
        case 'property': {
            const propertyVector = featureTable.getPropertyVector(expression.name);
            return propertyVector?.has(featureIndex)
                ? propertyVector.getValue(featureIndex)
                : null;
        }
        case 'id':
            return featureTable.idVector?.has(featureIndex)
                ? featureTable.idVector.getValue(featureIndex)
                : null;
        case 'geometry-type':
            return geometryTypeName(featureTable, featureIndex);
        case 'var':
            if (!environment?.has(expression.name)) {
                throw new Error(`Unknown MLT variable: ${expression.name}`);
            }
            return environment.get(expression.name);
        case 'let':
            return evaluateScalarExpression(
                featureTable,
                expression.body,
                featureIndex,
                evaluateLetBindings(featureTable, expression.bindings, featureIndex, environment),
            );
        case 'boolean-filter':
            return featureMatchesFilter(featureTable, expression.filter, featureIndex, environment);
        case 'dynamic-membership':
            return evaluateDynamicMembershipExpression(featureTable, expression, featureIndex, environment);
        case 'case':
            return evaluateScalarCaseExpression(featureTable, expression, featureIndex, environment);
        case 'match':
            return evaluateScalarMatchExpression(featureTable, expression, featureIndex, environment);
        case 'typeof': {
            const value = evaluateScalarExpression(featureTable, expression.arg, featureIndex, environment);
            return isEvaluationError(value) ? value : valueTypeName(value);
        }
        case 'assertion':
            return evaluateAssertionExpression(featureTable, expression, featureIndex, environment);
        case 'to-number': {
            let value: unknown = null;
            for (const arg of expression.args) {
                value = evaluateScalarExpression(featureTable, arg, featureIndex, environment);
                if (isEvaluationError(value)) return value;
                if (value === null) return 0;
                const numberValue = Number(value);
                if (!Number.isNaN(numberValue)) {
                    return numberValue;
                }
            }
            return null;
        }
        case 'to-string':
        {
            const value = evaluateScalarExpression(featureTable, expression.arg, featureIndex, environment);
            return isEvaluationError(value) ? value : valueToString(value);
        }
        case 'to-boolean':
        {
            const value = evaluateScalarExpression(featureTable, expression.arg, featureIndex, environment);
            return isEvaluationError(value) ? value : Boolean(value);
        }
        case 'coalesce':
            for (const arg of expression.args) {
                const value = evaluateScalarExpression(featureTable, arg, featureIndex, environment);
                if (isEvaluationError(value)) return value;
                if (value !== null) {
                    return value;
                }
            }
            return null;
        case 'step':
            return evaluateStepExpression(featureTable, expression, featureIndex, environment);
        case 'interpolate':
            return evaluateInterpolateExpression(featureTable, expression, featureIndex, environment);
        case 'numeric':
            return evaluateNumericExpression(featureTable, expression, featureIndex, environment);
        case 'length': {
            const value = evaluateScalarExpression(featureTable, expression.arg, featureIndex, environment);
            if (isEvaluationError(value)) return value;
            return typeof value === 'string' ? [...value].length : null;
        }
        case 'slice':
            return evaluateSliceExpression(featureTable, expression, featureIndex, environment);
        case 'index-of':
            return evaluateIndexOfExpression(featureTable, expression, featureIndex, environment);
        case 'string-case': {
            const value = evaluateScalarExpression(featureTable, expression.arg, featureIndex, environment);
            if (typeof value !== 'string') return EVALUATION_ERROR;
            return expression.operator === 'upcase' ? value.toLocaleUpperCase() : value.toLocaleLowerCase();
        }
        case 'concat':
        {
            const values = new Array<string>(expression.args.length);
            for (let i = 0; i < expression.args.length; i++) {
                const value = evaluateScalarExpression(featureTable, expression.args[i], featureIndex, environment);
                if (isEvaluationError(value)) return value;
                values[i] = valueToString(value);
            }
            return values.join('');
        }
    }
}

function compareScalarValues(left: unknown, right: unknown, operator: string): boolean {
    if (isEvaluationError(left) || isEvaluationError(right)) {
        return false;
    }

    switch (operator) {
        case '==':
            return left === right;
        case '!=':
            return left !== right;
        case '<':
            return left !== null && right !== null && typeof left === typeof right && left < right;
        case '<=':
            return left !== null && right !== null && typeof left === typeof right && left <= right;
        case '>':
            return left !== null && right !== null && typeof left === typeof right && left > right;
        case '>=':
            return left !== null && right !== null && typeof left === typeof right && left >= right;
        default:
            throw new Error(`Operator ${operator} not supported for computed comparisons.`);
    }
}

function executeComputedComparison(featureTable: FeatureTable, normalized: NormalizedComputedComparisonFilter, selectionVector?: SelectionVector, environment?: ScalarEnvironment): SelectionVector {
    if (selectionVector) {
        const selectionValues = selectionVector.selectionValues();
        const limit = selectionVector.limit;
        let writeIndex = 0;

        for (let i = 0; i < limit; i++) {
            const featureIndex = selectionValues[i];
            const left = evaluateScalarExpression(featureTable, normalized.left, featureIndex, environment);
            const right = evaluateScalarExpression(featureTable, normalized.right, featureIndex, environment);
            if (compareScalarValues(left, right, normalized.comparisonOperator)) {
                selectionVector.setIndex(writeIndex++, featureIndex);
            }
        }

        selectionVector.setLimit(writeIndex);
        return selectionVector;
    }

    const selection = new Uint32Array(featureTable.numFeatures);
    let writeIndex = 0;

    for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
        const left = evaluateScalarExpression(featureTable, normalized.left, featureIndex, environment);
        const right = evaluateScalarExpression(featureTable, normalized.right, featureIndex, environment);
        if (compareScalarValues(left, right, normalized.comparisonOperator)) {
            selection[writeIndex++] = featureIndex;
        }
    }

    return new FlatSelectionVector(selection, writeIndex);
}

function featureMatchesLeaf(featureTable: FeatureTable, leaf: NormalizedLeafFilter, featureIndex: number): boolean {
    const target = leaf.target;
    if (target.kind === 'dynamic-property-name') {
        if (leaf.operator === 'has' || leaf.operator === '!has') {
            const sourceVector = featureTable.getPropertyVector(target.name);
            return sourceVector ? hasDynamicPropertyName(featureTable, sourceVector, featureIndex, leaf.operator) : false;
        }
        throw new Error(`Operator ${leaf.operator} not supported for dynamic property-name filters.`);
    }

    let exists = false;
    let value: unknown = null;
    if (target.kind === 'geometry-type') {
        value = geometryTypeName(featureTable, featureIndex);
        exists = value !== null;
    } else if (target.kind === 'id') {
        exists = featureTable.idVector?.has(featureIndex) === true;
        value = exists ? featureTable.idVector.getValue(featureIndex) : null;
    } else {
        const propertyVector = featureTable.getPropertyVector(target.name);
        exists = propertyVector?.has(featureIndex) === true;
        value = exists ? propertyVector.getValue(featureIndex) : null;
    }

    const resolvedValue = exists ? value : null;

    switch (leaf.operator) {
        case 'has':
            return exists;
        case '!has':
            return !exists;
        case '==':
            return resolvedValue === leaf.values[0];
        case '!=':
            return resolvedValue !== leaf.values[0];
        case 'in':
            return leaf.values.some(candidate => resolvedValue === candidate);
        case '!in':
            return !leaf.values.some(candidate => resolvedValue === candidate);
        case '<':
        case '<=':
        case '>':
        case '>=':
            return compareScalarValues(resolvedValue, leaf.values[0], leaf.operator);
        default:
            throw new Error(`Operator ${leaf.operator} not supported.`);
    }
}

// EVALUATION_ERROR is a truthy Symbol; callers must test matches with `=== true`.
function featureMatchesFilter(featureTable: FeatureTable, normalized: NormalizedFilter, featureIndex: number, environment?: ScalarEnvironment): boolean | EvaluationError {
    const op = normalized.operator;
    if (op === 'within') {
        const withinContext = environment?.get(WITHIN_CONTEXT);
        if (!(withinContext instanceof WithinEvaluationContext)) {
            throw new Error('MLT within filter evaluation requires a canonical tile ID.');
        }
        return withinContext.evaluate(featureTable, featureIndex, (normalized as NormalizedWithinFilter).geometry);
    }
    if (op === 'constant') {
        return (normalized as NormalizedConstantFilter).value;
    }
    if (op === 'computed-comparison') {
        const comparison = normalized as NormalizedComputedComparisonFilter;
        const left = evaluateScalarExpression(featureTable, comparison.left, featureIndex, environment);
        const right = evaluateScalarExpression(featureTable, comparison.right, featureIndex, environment);
        if (isEvaluationError(left) || isEvaluationError(right)) {
            return EVALUATION_ERROR;
        }
        return compareScalarValues(left, right, comparison.comparisonOperator);
    }
    if (op === 'let') {
        const letFilter = normalized as NormalizedLetFilter;
        return featureMatchesFilter(
            featureTable,
            letFilter.body,
            featureIndex,
            evaluateLetBindings(featureTable, letFilter.bindings, featureIndex, environment),
        );
    }
    if (op === 'all') {
        let hasError = false;
        for (const child of (normalized as NormalizedCompoundFilter).children) {
            const res = featureMatchesFilter(featureTable, child, featureIndex, environment);
            if (isEvaluationError(res)) {
                hasError = true;
            } else if (res === false) {
                return false;
            }
        }
        return hasError ? EVALUATION_ERROR : true;
    }
    if (op === 'any') {
        let hasError = false;
        for (const child of (normalized as NormalizedCompoundFilter).children) {
            const res = featureMatchesFilter(featureTable, child, featureIndex, environment);
            if (isEvaluationError(res)) {
                hasError = true;
            } else if (res === true) {
                return true;
            }
        }
        return hasError ? EVALUATION_ERROR : false;
    }
    if (op === 'none') {
        let hasError = false;
        for (const child of (normalized as NormalizedCompoundFilter).children) {
            const res = featureMatchesFilter(featureTable, child, featureIndex, environment);
            if (isEvaluationError(res)) {
                hasError = true;
            } else if (res === true) {
                return false;
            }
        }
        return hasError ? EVALUATION_ERROR : true;
    }
    return featureMatchesLeaf(featureTable, normalized as NormalizedLeafFilter, featureIndex);
}

function executeLet(featureTable: FeatureTable, normalized: NormalizedLetFilter, selectionVector?: SelectionVector, environment?: ScalarEnvironment): SelectionVector {
    if (selectionVector) {
        const selectionValues = selectionVector.selectionValues();
        const limit = selectionVector.limit;
        let writeIndex = 0;

        for (let i = 0; i < limit; i++) {
            const featureIndex = selectionValues[i];
            const childEnvironment = evaluateLetBindings(featureTable, normalized.bindings, featureIndex, environment);
            if (featureMatchesFilter(featureTable, normalized.body, featureIndex, childEnvironment) === true) {
                selectionVector.setIndex(writeIndex++, featureIndex);
            }
        }

        selectionVector.setLimit(writeIndex);
        return selectionVector;
    }

    const selection = new Uint32Array(featureTable.numFeatures);
    let writeIndex = 0;

    for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
        const childEnvironment = evaluateLetBindings(featureTable, normalized.bindings, featureIndex, environment);
        if (featureMatchesFilter(featureTable, normalized.body, featureIndex, childEnvironment) === true) {
            selection[writeIndex++] = featureIndex;
        }
    }

    return new FlatSelectionVector(selection, writeIndex);
}

/**
 * Routes a compound filter to the correct logical executor (`all`, `any`, or `none`).
 *
 * @param featureTable - The feature table to filter against
 * @param compound - The compound filter with its children
 * @returns A SelectionVector with matching feature indices
 */
function executeCompound(featureTable: FeatureTable, compound: NormalizedCompoundFilter, environment?: ScalarEnvironment): SelectionVector {
    const op = compound.operator;
    if (op === 'all') return executeAll(featureTable, compound.children, environment);
    if (op === 'any') return executeAny(featureTable, compound.children, environment);
    return executeNone(featureTable, compound.children, environment);
}

/**
 * Executes an `all` (AND) compound filter.
 *
 * Processes children sequentially, progressively narrowing the selection.
 * Leaf children use the `selectionVector` parameter for in-place filtering;
 * compound children are intersected with the running result. Short-circuits
 * on empty selection. Converts {@link ConstSelectionVector} to
 * {@link FlatSelectionVector} when further narrowing is needed.
 *
 * @param featureTable - The feature table to filter against
 * @param children - The child filters to AND together
 * @returns A SelectionVector with indices matching all children
 */
function executeAll(featureTable: FeatureTable, children: NormalizedFilter[], environment?: ScalarEnvironment): SelectionVector {
    let selectionVector: SelectionVector | undefined;
    const len = children.length;

    if (len === 0) {
        return new SequenceSelectionVector(0, 1, featureTable.numFeatures);
    }

    for (let i = 0; i < len; i++) {
        const child = children[i];
        const childOp = child.operator;

        if (childOp === 'constant') {
            selectionVector = executeConstant(
                featureTable,
                child as NormalizedConstantFilter,
                selectionVector,
            );
        } else if (childOp === 'computed-comparison') {
            selectionVector = executeComputedComparison(
                featureTable,
                child as NormalizedComputedComparisonFilter,
                selectionVector,
                environment,
            );
        } else if (childOp === 'let') {
            selectionVector = executeLet(
                featureTable,
                child as NormalizedLetFilter,
                selectionVector,
                environment,
            );
        } else if (childOp === 'all' || childOp === 'any' || childOp === 'none') {
            const childResult = executeCompound(
                featureTable,
                child as NormalizedCompoundFilter,
                environment,
            );
            selectionVector = selectionVector
                ? intersectSelectionVectors(selectionVector, childResult)
                : childResult;
        } else {
            selectionVector = executeLeaf(
                featureTable,
                child as NormalizedLeafFilter,
                selectionVector,
            );
        }

        if (selectionVector.limit === 0) return selectionVector;

        if (i < len - 1 && selectionVector instanceof ConstSelectionVector) {
            selectionVector = selectionVector.limit === selectionVector.capacity
                ? new SequenceSelectionVector(0, 1, selectionVector.limit)
                : new FlatSelectionVector(selectionVector.selectionValues());
        }
    }

    return selectionVector;
}

/**
 * Executes an `any` (OR) compound filter.
 *
 * Evaluates each child independently and unions non-empty results using
 * {@link unionSelectionVectors}. Short-circuits to direct execution for
 * single-child expressions.
 *
 * @param featureTable - The feature table to filter against
 * @param children - The child filters to OR together
 * @returns A SelectionVector with indices matching at least one child
 */
function executeAny(featureTable: FeatureTable, children: NormalizedFilter[], environment?: ScalarEnvironment): SelectionVector {
    const len = children.length;
    if (len === 1) return executeFilter(featureTable, children[0], undefined, environment);

    const results: SelectionVector[] = [];
    for (let i = 0; i < len; i++) {
        const result = executeFilter(featureTable, children[i], undefined, environment);
        if (result.limit > 0) results.push(result);
    }

    if (results.length === 0) return EMPTY_SELECTION;
    return unionSelectionVectors(results, featureTable.numFeatures);
}

/**
 * Executes a `none` (NOT-ANY) compound filter.
 *
 * Computes the `any` union of all children, then inverts the result using
 * {@link invertSelectionVector} to select features matching none of the children.
 *
 * @param featureTable - The feature table to filter against
 * @param children - The child filters to negate
 * @returns A SelectionVector with indices matching none of the children
 */
function executeNone(featureTable: FeatureTable, children: NormalizedFilter[], environment?: ScalarEnvironment): SelectionVector {
    const anyResult = executeAny(featureTable, children, environment);
    return invertSelectionVector(anyResult, featureTable.numFeatures);
}

/**
 * Dispatches a leaf filter to the appropriate specialized executor based on
 * the target kind (geometry type, feature ID, or property).
 *
 * @param featureTable - The feature table to filter against
 * @param leaf - The normalized leaf filter
 * @param selectionVector - Optional pre-existing selection to narrow
 * @returns A SelectionVector with matching feature indices
 */
function executeLeaf(featureTable: FeatureTable, leaf: NormalizedLeafFilter, selectionVector?: SelectionVector): SelectionVector {
    const targetKind = leaf.target.kind;

    if (targetKind === 'geometry-type') {
        return executeGeometryTypeFilter(
            featureTable,
            leaf.operator,
            leaf.values as string[],
            selectionVector,
        );
    }

    if (targetKind === 'id') {
        return executeIdFilter(
            featureTable,
            leaf.operator,
            leaf.values,
            selectionVector,
        );
    }

    if (targetKind === 'dynamic-property-name') {
        return executeDynamicPropertyNameFilter(
            featureTable,
            leaf.operator,
            leaf.target.name,
            selectionVector,
        );
    }

    return executePropertyFilter(
        featureTable,
        leaf.operator,
        leaf.target.name,
        leaf.values,
        selectionVector,
    );
}

function hasDynamicPropertyName(featureTable: FeatureTable, sourceVector: Vector, index: number, operator: string): boolean {
    if (!sourceVector.has(index)) return false;

    const propertyName = sourceVector.getValue(index);
    if (typeof propertyName !== 'string') return false;

    const hasProperty = featureTable.getPropertyVector(propertyName)?.has(index) === true;
    return operator === 'has' ? hasProperty : !hasProperty;
}

function executeDynamicPropertyNameFilter(featureTable: FeatureTable, operator: string, columnName: string, selectionVector?: SelectionVector): SelectionVector {
    if (operator !== 'has' && operator !== '!has') {
        throw new Error(`Operator ${operator} not supported for dynamic property-name filters.`);
    }

    const sourceVector = featureTable.getPropertyVector(columnName);
    if (!sourceVector) {
        if (selectionVector) {
            selectionVector.setLimit(0);
            return selectionVector;
        }
        return EMPTY_SELECTION;
    }

    if (selectionVector) {
        const selectionValues = selectionVector.selectionValues();
        const limit = selectionVector.limit;
        let writeIndex = 0;

        for (let i = 0; i < limit; i++) {
            const idx = selectionValues[i];
            if (hasDynamicPropertyName(featureTable, sourceVector, idx, operator)) {
                selectionVector.setIndex(writeIndex++, idx);
            }
        }

        selectionVector.setLimit(writeIndex);
        return selectionVector;
    }

    const selection = new Uint32Array(featureTable.numFeatures);
    let writeIndex = 0;

    for (let i = 0; i < featureTable.numFeatures; i++) {
        if (hasDynamicPropertyName(featureTable, sourceVector, i, operator)) {
            selection[writeIndex++] = i;
        }
    }

    return new FlatSelectionVector(selection, writeIndex);
}

/**
 * Filters features by geometry type (`$type` / `geometry-type`).
 *
 * Supports `==`, `in`, and `!=` operators. For `!=`, computes matching
 * features and inverts. For `in` with multiple types, unions individual
 * type matches. Intersects with an existing selection vector when provided.
 *
 * @param featureTable - The feature table to filter against
 * @param operator - The comparison operator (`==`, `!=`, or `in`)
 * @param geometryTypeNames - GeoJSON geometry type names to match
 * @param selectionVector - Optional pre-existing selection to narrow
 * @returns A SelectionVector with matching feature indices
 * @throws If the operator is not supported on geometry type
 */
function executeGeometryTypeFilter(featureTable: FeatureTable, operator: string, geometryTypeNames: string[], selectionVector?: SelectionVector): SelectionVector {
    const geometryVector = featureTable.geometryVector;

    if (operator === '!=' || operator === '!in') {
        if (operator === '!in' && geometryTypeNames.length > 1) {
            const matchingTypes = new Array<SelectionVector>(geometryTypeNames.length);
            for (let i = 0; i < geometryTypeNames.length; i++) {
                matchingTypes[i] = geometryVector.filter(getSinglePartGeometryType(geometryTypeNames[i]));
            }
            const invertedUnion = invertSelectionVector(
                unionSelectionVectors(matchingTypes, featureTable.numFeatures),
                featureTable.numFeatures,
            );
            return selectionVector
                ? intersectSelectionVectors(selectionVector, invertedUnion)
                : invertedUnion;
        }
        const geometryType = getSinglePartGeometryType(geometryTypeNames[0]);
        const matching = geometryVector.filter(geometryType);
        const inverted = invertSelectionVector(
            matching,
            featureTable.numFeatures,
        );
        return selectionVector
            ? intersectSelectionVectors(selectionVector, inverted)
            : inverted;
    }

    if (operator !== '==' && operator !== 'in') {
        throw new Error(
            `Operator ${operator} not supported on geometry type.`,
        );
    }

    const len = geometryTypeNames.length;
    const typeSet = new Set<SINGLE_PART_GEOMETRY_TYPE>();
    for (let i = 0; i < len; i++) {
        typeSet.add(getSinglePartGeometryType(geometryTypeNames[i]));
    }

    const uniqueTypes = Array.from(typeSet);

    if (uniqueTypes.length === 1) {
        if (selectionVector) {
            geometryVector.filterSelected(uniqueTypes[0], selectionVector);
            return selectionVector;
        }
        return geometryVector.filter(uniqueTypes[0]);
    }

    const results = new Array<SelectionVector>(uniqueTypes.length);
    for (let i = 0; i < uniqueTypes.length; i++) {
        results[i] = geometryVector.filter(uniqueTypes[i]);
    }
    const union = unionSelectionVectors(results, featureTable.numFeatures);
    return selectionVector
        ? intersectSelectionVectors(selectionVector, union)
        : union;
}

/**
 * Filters features by their ID (`$id`).
 *
 * If no ID vector is present on the feature table, negated operators (`!=`, `!in`, `!has`)
 * return all features (or the existing selection), while positive operators return empty.
 * Otherwise delegates to {@link executeVectorOperation}.
 *
 * @param featureTable - The feature table to filter against
 * @param operator - The filter operator
 * @param values - The value(s) to compare against
 * @param selectionVector - Optional pre-existing selection to narrow
 * @returns A SelectionVector with matching feature indices
 */
function executeIdFilter(featureTable: FeatureTable, operator: string, values: unknown[], selectionVector?: SelectionVector): SelectionVector {
    const idVector = featureTable.idVector;

    if (!idVector) {
        if (operator === '!=' || operator === '!in' || operator === '!has') {
            return (
                selectionVector ??
                new SequenceSelectionVector(0, 1, featureTable.numFeatures)
            );
        }
        return EMPTY_SELECTION;
    }

    return executeVectorOperation(
        idVector,
        operator,
        values,
        selectionVector,
    );
}

/**
 * Filters features by a named property column.
 *
 * If the property does not exist on the feature table, negated operators (`!=`, `!in`, `!has`)
 * return all features (or the existing selection), while positive operators return empty.
 * Otherwise delegates to {@link executeVectorOperation}.
 *
 * @param featureTable - The feature table to filter against
 * @param operator - The filter operator
 * @param columnName - The property column name
 * @param values - The value(s) to compare against
 * @param selectionVector - Optional pre-existing selection to narrow
 * @returns A SelectionVector with matching feature indices
 */
function executePropertyFilter(featureTable: FeatureTable, operator: string, columnName: string, values: unknown[], selectionVector?: SelectionVector): SelectionVector {
    const propertyVector = featureTable.getPropertyVector(columnName);

    if (!propertyVector) {
        if (operator === '!=' || operator === '!in' || operator === '!has') {
            return (
                selectionVector ??
                new SequenceSelectionVector(0, 1, featureTable.numFeatures)
            );
        }
        return EMPTY_SELECTION;
    }

    return executeVectorOperation(
        propertyVector,
        operator,
        values,
        selectionVector,
    );
}

/**
 * Executes a filter operator against a vector, dispatching to the appropriate
 * type-specific handler from {@link getVectorTypeHandlers}.
 *
 * When a `selectionVector` is provided, uses in-place `*Selected` variants
 * that narrow the existing selection. Otherwise creates a new SelectionVector.
 *
 * @param vector - The data vector to filter
 * @param operator - The filter operator (`==`, `!=`, `in`, `!in`, `>=`, `<=`, `>`, `<`, `has`, `!has`)
 * @param values - The value(s) to compare against
 * @param selectionVector - Optional pre-existing selection to narrow
 * @returns A SelectionVector with matching feature indices
 * @throws If the operator is not recognized
 */
function executeVectorOperation(vector: Vector, operator: string, values: unknown[], selectionVector?: SelectionVector): SelectionVector {
    const handlers = getVectorTypeHandlers(vector);
    const hasSelection = selectionVector !== undefined;
    const value = values[0];

    switch (operator) {
        case '==':
            if (hasSelection) {
                handlers.filterSelected(vector, value, selectionVector);
                return selectionVector;
            }
            return handlers.filter(vector, value);

        case 'in':
            if (hasSelection) {
                handlers.matchSelected(vector, values, selectionVector);
                return selectionVector;
            }
            return handlers.match(vector, values);

        case '!=':
            if (hasSelection) {
                handlers.filterNotEqualSelected(
                    vector,
                    value,
                    selectionVector,
                );
                return selectionVector;
            }
            return handlers.filterNotEqual(vector, value);

        case '!in':
            if (hasSelection) {
                handlers.noneMatchSelected(vector, values, selectionVector);
                return selectionVector;
            }
            return handlers.noneMatch(vector, values);

        case '>=':
            if (isBooleanVector(vector)) throw new Error('Comparison operators (>=, <=, >, <) are not supported for boolean vectors.');
            if (hasSelection) {
                executeNonStrictComparisonSelected(vector, value, selectionVector, true);
                return selectionVector;
            }
            return executeNonStrictComparison(vector, value, true);

        case '<=':
            if (isBooleanVector(vector)) throw new Error('Comparison operators (>=, <=, >, <) are not supported for boolean vectors.');
            if (hasSelection) {
                executeNonStrictComparisonSelected(vector, value, selectionVector, false);
                return selectionVector;
            }
            return executeNonStrictComparison(vector, value, false);

        case '>':
            if (hasSelection) {
                executeStrictComparisonSelected(
                    vector,
                    value,
                    selectionVector,
                    true,
                );
                return selectionVector;
            }
            return executeStrictComparison(vector, value, true);

        case '<':
            if (hasSelection) {
                executeStrictComparisonSelected(
                    vector,
                    value,
                    selectionVector,
                    false,
                );
                return selectionVector;
            }
            return executeStrictComparison(vector, value, false);

        case 'has':
            if (hasSelection) {
                filterNonNullSelected(vector, selectionVector);
                return selectionVector;
            }
            return createNonNullSelectionVector(vector);

        case '!has':
            if (hasSelection) {
                filterNullSelected(vector, selectionVector);
                return selectionVector;
            }
            return nullableValues(vector);

        default:
            throw new Error(`Operator ${operator} not supported.`);
    }
}

/** Indexed views preserve the scalar type of their source without copying its nullability or values. */
function isBooleanVector(vector: Vector): boolean {
    while (vector instanceof IndexedVector) vector = vector.source;
    return vector instanceof BooleanFlatVector;
}

/**
 * Single-pass strict comparison (`>` or `<`) across all vector elements.
 *
 * Scans every non-null value in the vector and selects indices where the
 * comparison holds. Avoids the two-pass approach of `>=`/`<=` + exclude-equal.
 *
 * @param vector - The data vector to compare
 * @param value - The threshold value
 * @param isGreater - `true` for `>`, `false` for `<`
 * @returns A FlatSelectionVector with matching indices
 */
function executeStrictComparison(vector: Vector, value: unknown, isGreater: boolean): SelectionVector {
    const selectionVector = new Uint32Array(vector.size);
    let index = 0;

    for (let i = 0; i < vector.size; i++) {
        if (vector.has(i)) {
            const v = vector.getValue(i);
            const matches = isGreater ? v > value : v < value;
            if (matches) {
                selectionVector[index++] = i;
            }
        }
    }

    return new FlatSelectionVector(selectionVector, index);
}

/**
 * Single-pass strict comparison (`>` or `<`) within an existing selection.
 *
 * Narrows the selection vector in-place, keeping only indices where the
 * comparison holds.
 *
 * @param vector - The data vector to compare
 * @param value - The threshold value
 * @param selectionVector - The selection to narrow (modified in-place)
 * @param isGreater - `true` for `>`, `false` for `<`
 */
function executeStrictComparisonSelected(vector: Vector, value: unknown, selectionVector: SelectionVector, isGreater: boolean): void {
    const selectionValues = selectionVector.selectionValues();
    const limit = selectionVector.limit;
    let writeIndex = 0;

    for (let i = 0; i < limit; i++) {
        const idx = selectionValues[i];
        if (vector.has(idx)) {
            const v = vector.getValue(idx);
            const matches = isGreater ? v > value : v < value;
            if (matches) {
                selectionVector.setIndex(writeIndex++, idx);
            }
        }
    }
    selectionVector.setLimit(writeIndex);
}

function executeNonStrictComparison(vector: Vector, value: unknown, isGreater: boolean): SelectionVector {
    const selectionVector = new Uint32Array(vector.size);
    let index = 0;

    for (let i = 0; i < vector.size; i++) {
        if (vector.has(i)) {
            const v = vector.getValue(i);
            const matches = isGreater ? v >= value : v <= value;
            if (matches) selectionVector[index++] = i;
        }
    }

    return new FlatSelectionVector(selectionVector, index);
}

function executeNonStrictComparisonSelected(vector: Vector, value: unknown, selectionVector: SelectionVector, isGreater: boolean): void {
    const selectionValues = selectionVector.selectionValues();
    const limit = selectionVector.limit;
    let writeIndex = 0;

    for (let i = 0; i < limit; i++) {
        const idx = selectionValues[i];
        if (vector.has(idx)) {
            const v = vector.getValue(idx);
            const matches = isGreater ? v >= value : v <= value;
            if (matches) selectionVector.setIndex(writeIndex++, idx);
        }
    }
    selectionVector.setLimit(writeIndex);
}
