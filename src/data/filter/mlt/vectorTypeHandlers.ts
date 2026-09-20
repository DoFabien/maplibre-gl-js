import {
    type Vector,
    type SelectionVector,
    StringDictionaryVector,
    StringFlatVector,
    StringFsstDictionaryVector,
    BooleanFlatVector,
} from '@maplibre/mlt';
import {
    filterByValue,
    filterSelected,
    filterNotEqual,
    filterNotEqualSelected,
    match,
    matchSelected,
    noneMatch,
    noneMatchSelected,
} from './utils/filterUtils';
import {
    filterStringDictionaryByValue,
    filterStringDictionarySelected,
    filterStringDictionaryNotEqual,
    filterStringDictionaryNotEqualSelected,
    matchStringDictionary,
    matchStringDictionarySelected,
    noneMatchStringDictionary,
    noneMatchStringDictionarySelected,
} from './utils/stringDictionaryUtils';
import {
    filterStringFlatByValue,
    filterStringFlatSelected,
    filterStringFlatNotEqual,
    filterStringFlatNotEqualSelected,
    matchStringFlat,
    matchStringFlatSelected,
    noneMatchStringFlat,
    noneMatchStringFlatSelected,
} from './utils/stringFlatVectorUtils';
import {
    filterStringFsstDictionaryByValue,
    filterStringFsstDictionarySelected,
    filterStringFsstDictionaryNotEqual,
    filterStringFsstDictionaryNotEqualSelected,
    matchStringFsstDictionary,
    matchStringFsstDictionarySelected,
    noneMatchStringFsstDictionary,
    noneMatchStringFsstDictionarySelected,
} from './utils/stringFsstDictionaryUtils';

export type FilterFn = (vector: Vector, value: unknown) => SelectionVector;
export type FilterSelectedFn = (vector: Vector, value: unknown, sv: SelectionVector) => void;
export type MatchFn = (vector: Vector, values: unknown[]) => SelectionVector;
export type MatchSelectedFn = (vector: Vector, values: unknown[], sv: SelectionVector) => void;

export type VectorTypeHandlers = {
    filter: FilterFn;
    filterSelected: FilterSelectedFn;
    filterNotEqual: FilterFn;
    filterNotEqualSelected: FilterSelectedFn;
    match: MatchFn;
    matchSelected: MatchSelectedFn;
    noneMatch: MatchFn;
    noneMatchSelected: MatchSelectedFn;
};

const throwComparisonError = (): never => {
    throw new Error('Comparison operators (>=, <=, >, <) are not supported for boolean vectors.');
};

// Pre-allocated handler objects
const boolHandlers: VectorTypeHandlers = {
    filter: (v, val) => filterByValue(v, val),
    filterSelected: (v, val, sv) => filterSelected(v, val, sv),
    filterNotEqual: (v, val) => filterNotEqual(v, val),
    filterNotEqualSelected: (v, val, sv) => filterNotEqualSelected(v, val, sv),
    match: (v, vals) => match(v, vals),
    matchSelected: (v, vals, sv) => matchSelected(v, vals, sv),
    noneMatch: (v, vals) => noneMatch(v, vals, true),
    noneMatchSelected: (v, vals, sv) => noneMatchSelected(v, vals, sv, true)
};

const stringDictHandlers: VectorTypeHandlers = {
    filter: (v, val) => filterStringDictionaryByValue(v as StringDictionaryVector, val as string),
    filterSelected: (v, val, sv) => filterStringDictionarySelected(v as StringDictionaryVector, val as string, sv),
    filterNotEqual: (v, val) => filterStringDictionaryNotEqual(v as StringDictionaryVector, val as string),
    filterNotEqualSelected: (v, val, sv) => filterStringDictionaryNotEqualSelected(v as StringDictionaryVector, val as string, sv),
    match: (v, vals) => matchStringDictionary(v as StringDictionaryVector, vals as string[]),
    matchSelected: (v, vals, sv) => matchStringDictionarySelected(v as StringDictionaryVector, vals as string[], sv),
    noneMatch: (v, vals) => noneMatchStringDictionary(v as StringDictionaryVector, vals as string[]),
    noneMatchSelected: (v, vals, sv) => noneMatchStringDictionarySelected(v as StringDictionaryVector, vals as string[], sv)
};

const stringFlatHandlers: VectorTypeHandlers = {
    filter: (v, val) => filterStringFlatByValue(v as StringFlatVector, val as string),
    filterSelected: (v, val, sv) => filterStringFlatSelected(v as StringFlatVector, val as string, sv),
    filterNotEqual: (v, val) => filterStringFlatNotEqual(v as StringFlatVector, val as string),
    filterNotEqualSelected: (v, val, sv) => filterStringFlatNotEqualSelected(v as StringFlatVector, val as string, sv),
    match: (v, vals) => matchStringFlat(v as StringFlatVector, vals as string[]),
    matchSelected: (v, vals, sv) => matchStringFlatSelected(v as StringFlatVector, vals as string[], sv),
    noneMatch: (v, vals) => noneMatchStringFlat(v as StringFlatVector, vals as string[]),
    noneMatchSelected: (v, vals, sv) => noneMatchStringFlatSelected(v as StringFlatVector, vals as string[], sv)
};

const stringFsstHandlers: VectorTypeHandlers = {
    filter: (v, val) => filterStringFsstDictionaryByValue(v as StringFsstDictionaryVector, val as string),
    filterSelected: (v, val, sv) => filterStringFsstDictionarySelected(v as StringFsstDictionaryVector, val as string, sv),
    filterNotEqual: (v, val) => filterStringFsstDictionaryNotEqual(v as StringFsstDictionaryVector, val as string),
    filterNotEqualSelected: (v, val, sv) => filterStringFsstDictionaryNotEqualSelected(v as StringFsstDictionaryVector, val as string, sv),
    match: (v, vals) => matchStringFsstDictionary(v as StringFsstDictionaryVector, vals as string[]),
    matchSelected: (v, vals, sv) => matchStringFsstDictionarySelected(v as StringFsstDictionaryVector, vals as string[], sv),
    noneMatch: (v, vals) => noneMatchStringFsstDictionary(v as StringFsstDictionaryVector, vals as string[]),
    noneMatchSelected: (v, vals, sv) => noneMatchStringFsstDictionarySelected(v as StringFsstDictionaryVector, vals as string[], sv)
};

const genericHandlers: VectorTypeHandlers = {
    filter: (v, val) => filterByValue(v, val),
    filterSelected: (v, val, sv) => filterSelected(v, val, sv),
    filterNotEqual: (v, val) => filterNotEqual(v, val),
    filterNotEqualSelected: (v, val, sv) => filterNotEqualSelected(v, val, sv),
    match: (v, vals) => match(v, vals),
    matchSelected: (v, vals, sv) => matchSelected(v, vals, sv),
    noneMatch: (v, vals) => noneMatch(v, vals, true),
    noneMatchSelected: (v, vals, sv) => noneMatchSelected(v, vals, sv, true)
};

const handlerCache = new WeakMap<Vector, VectorTypeHandlers>();

export function getVectorTypeHandlers(vector: Vector): VectorTypeHandlers {
    let handlers = handlerCache.get(vector);
    if (handlers) return handlers;

    if (vector instanceof BooleanFlatVector) {
        handlers = boolHandlers;
    } else if (vector instanceof StringDictionaryVector) {
        handlers = stringDictHandlers;
    } else if (vector instanceof StringFlatVector) {
        handlers = stringFlatHandlers;
    } else if (vector instanceof StringFsstDictionaryVector) {
        handlers = stringFsstHandlers;
    } else {
        handlers = genericHandlers;
    }

    handlerCache.set(vector, handlers);
    return handlers;
}
