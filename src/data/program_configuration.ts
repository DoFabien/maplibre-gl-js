import {packUint8ToFloat} from '../shaders/encode_attribute.ts';
import {Color, expressions as styleExpressionDefinitions, supportsPropertyExpression, type Color as StyleColor} from '@maplibre/maplibre-gl-style-spec';
import {register} from '../util/web_worker_transfer.ts';
import {PossiblyEvaluatedPropertyValue} from '../style/properties.ts';
import {StructArrayLayout1f4, StructArrayLayout2f8, StructArrayLayout4f16, PatternLayoutArray, DashLayoutArray} from './array_types.g.ts';
import {clamp} from '../util/util.ts';
import {patternAttributes} from './bucket/pattern_attributes.ts';
import {dashAttributes} from './bucket/dash_attributes.ts';
import {EvaluationParameters} from '../style/evaluation_parameters.ts';
import {FeaturePositionMap} from './feature_position_map.ts';
import {type Uniform, Uniform1f, UniformColor, Uniform4f} from '../webgl/uniform_binding.ts';
import {collectExpressionPropertyDependencies} from './bucket/columnar/property_dependencies.ts';
import {ColumnarFeatureStateData, type ColumnarFeatureIdResolver} from './bucket/columnar/columnar_feature_state_data.ts';

import type {UniformLocations} from '../webgl/uniform_binding.ts';
import type {CanonicalTileID} from '../tile/tile_id.ts';
import type {Context} from '../webgl/context.ts';
import type {TypedStyleLayer} from '../style/style_layer/typed_style_layer.ts';
import type {CrossfadeParameters} from '../style/evaluation_parameters.ts';
import type {StructArray, StructArrayMember} from '../util/struct_array.ts';
import type {VertexBuffer} from '../webgl/vertex_buffer.ts';
import type {ImagePosition} from '../render/image_atlas.ts';
import type {
    Feature,
    FeatureState,
    GlobalProperties,
    SourceExpression,
    CompositeExpression,
    FormattedSection
} from '@maplibre/maplibre-gl-style-spec';
import type {FeatureStates} from '../source/source_state.ts';
import type {DashEntry} from '../render/line_atlas.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';
import type {FeatureTable} from '@maplibre/mlt';

export type BinderUniform = {
    name: string;
    property: string;
    binding: Uniform<any>;
};

function packColor(color: StyleColor): [number, number] {
    return [
        packUint8ToFloat(255 * color.r, 255 * color.g),
        packUint8ToFloat(255 * color.b, 255 * color.a)
    ];
}

type PaintOptions = {
    imagePositions: {
        [_: string]: ImagePosition;
    };
    dashPositions?: {
        [_: string]: DashEntry;
    };
    canonical?: CanonicalTileID;
    formattedSection?: FormattedSection;
    globalState?: Record<string, any>;
};
type PaintFeatureProvider = (index: number) => Feature;
type ColumnarPaintColumn = {getValue: (index: number) => unknown};
export type ColumnarPaintColumnProvider = (name: string) => ColumnarPaintColumn | undefined;
type ColumnarExpressionEvaluator = {
    propertyNames: string[];
    evaluate: (featureIndex: number, getColumn: ColumnarPaintColumnProvider) => unknown;
};

type ColumnarBooleanEvaluator = {
    propertyNames: string[];
    evaluate: (featureIndex: number, getColumn: ColumnarPaintColumnProvider) => boolean;
};

function normalizeColumnarPaintValue(value: unknown): unknown {
    return typeof value === 'bigint' ? Number(value) : value;
}

function convertColumnarPaintOutput(value: unknown, type: string): unknown {
    return type === 'color' && typeof value === 'string' ? Color.parse(value) : value;
}

function literalValue(expression: any): unknown {
    return expression && Object.hasOwn(expression, 'value') ? expression.value : undefined;
}

function uniquePropertyNames(evaluators: Array<{propertyNames: string[]}>): string[] {
    return Array.from(new Set(evaluators.flatMap(evaluator => evaluator.propertyNames)));
}

function readColumnValue(column: ColumnarPaintColumn | undefined, featureIndex: number): unknown {
    if (!column) return undefined;
    if (typeof (column as any).has === 'function' && !(column as any).has(featureIndex)) {
        return undefined;
    }
    const value = column.getValue(featureIndex);
    return value === null ? undefined : normalizeColumnarPaintValue(value);
}

function compileSerializedColumnarChildren(expressions: unknown[], type: string): ColumnarExpressionEvaluator[] | null {
    const children = expressions.map(expression => compileSerializedColumnarExpression(expression, type));
    return children.some(child => !child) ? null : children;
}

function columnarValueToString(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
}

function isAssertionValue(operator: unknown, value: unknown): boolean {
    switch (operator) {
        case 'number': return typeof value === 'number';
        case 'string': return typeof value === 'string';
        case 'boolean': return typeof value === 'boolean';
        case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
        default: return false;
    }
}

function compileSerializedColumnarExpression(expression: unknown, type: string): ColumnarExpressionEvaluator | null {
    if (!Array.isArray(expression)) {
        const value = convertColumnarPaintOutput(expression, type);
        return {propertyNames: [], evaluate: () => value};
    }

    const operator = expression[0];
    if (operator === 'literal') {
        const value = convertColumnarPaintOutput(expression[1], type);
        return {propertyNames: [], evaluate: () => value};
    }

    if (operator === 'get' && expression.length === 2 && typeof expression[1] === 'string') {
        const propertyName = expression[1];
        return {
            propertyNames: [propertyName],
            evaluate: (featureIndex, getColumn) => readColumnValue(getColumn(propertyName), featureIndex)
        };
    }

    if ((operator === 'number' || operator === 'string' || operator === 'boolean' || operator === 'object') && expression.length >= 2) {
        const children = compileSerializedColumnarChildren(expression.slice(1), 'value');
        if (!children) return null;
        return {
            propertyNames: uniquePropertyNames(children),
            evaluate: (featureIndex, getColumn) => {
                for (const child of children) {
                    const value = child.evaluate(featureIndex, getColumn);
                    if (isAssertionValue(operator, value)) return value;
                }
                return undefined;
            }
        };
    }

    if ((operator === 'to-number' || operator === 'to-color') && expression.length >= 2) {
        const children = compileSerializedColumnarChildren(expression.slice(1), 'value');
        if (!children) return null;
        return {
            propertyNames: uniquePropertyNames(children),
            evaluate: (featureIndex, getColumn) => {
                for (const child of children) {
                    const value = child.evaluate(featureIndex, getColumn);
                    if (operator === 'to-number') {
                        if (value === null || value === undefined) return 0;
                        const number = Number(value);
                        if (!Number.isNaN(number)) return number;
                    } else if (value instanceof Color) {
                        return value;
                    } else if (typeof value === 'string') {
                        const color = Color.parse(value);
                        if (color) return color;
                    }
                }
                return undefined;
            }
        };
    }

    if ((operator === 'to-string' || operator === 'to-boolean') && expression.length === 2) {
        const child = compileSerializedColumnarExpression(expression[1], 'value');
        if (!child) return null;
        return {
            propertyNames: child.propertyNames,
            evaluate: (featureIndex, getColumn) => {
                const value = child.evaluate(featureIndex, getColumn);
                return operator === 'to-string' ? columnarValueToString(value) : Boolean(value);
            }
        };
    }

    if (operator === 'coalesce' && expression.length >= 2) {
        const children = compileSerializedColumnarChildren(expression.slice(1), type);
        if (!children) return null;
        return {
            propertyNames: uniquePropertyNames(children),
            evaluate: (featureIndex, getColumn) => {
                for (const child of children) {
                    const value = child.evaluate(featureIndex, getColumn);
                    if (value !== null && value !== undefined) return value;
                }
                return null;
            }
        };
    }

    if ((operator === '+' || operator === '*') && expression.length >= 2) {
        const children = compileSerializedColumnarChildren(expression.slice(1), 'number');
        if (!children) return null;
        return {
            propertyNames: uniquePropertyNames(children),
            evaluate: (featureIndex, getColumn) => {
                let value = operator === '+' ? 0 : 1;
                for (const child of children) {
                    const childValue = Number(child.evaluate(featureIndex, getColumn));
                    value = operator === '+' ? value + childValue : value * childValue;
                }
                return value;
            }
        };
    }

    if ((operator === '-' && (expression.length === 2 || expression.length === 3)) ||
        ((operator === '/' || operator === '%' || operator === '^') && expression.length === 3)) {
        const children = compileSerializedColumnarChildren(expression.slice(1), 'number');
        if (!children) return null;
        return {
            propertyNames: uniquePropertyNames(children),
            evaluate: (featureIndex, getColumn) => {
                const left = Number(children[0].evaluate(featureIndex, getColumn));
                if (operator === '-' && children.length === 1) return -left;
                const right = Number(children[1].evaluate(featureIndex, getColumn));
                if (operator === '-') return left - right;
                if (operator === '/') return left / right;
                if (operator === '%') return left % right;
                return Math.pow(left, right);
            }
        };
    }

    if ((operator === 'min' || operator === 'max') && expression.length >= 2) {
        const children = compileSerializedColumnarChildren(expression.slice(1), 'number');
        if (!children) return null;
        return {
            propertyNames: uniquePropertyNames(children),
            evaluate: (featureIndex, getColumn) => {
                let value = operator === 'min' ? Infinity : -Infinity;
                for (const child of children) {
                    const childValue = Number(child.evaluate(featureIndex, getColumn));
                    value = operator === 'min' ? Math.min(value, childValue) : Math.max(value, childValue);
                }
                return value;
            }
        };
    }

    if (['abs', 'ceil', 'floor', 'round', 'sqrt', 'ln', 'log2', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan'].includes(operator as string) && expression.length === 2) {
        const child = compileSerializedColumnarExpression(expression[1], 'number');
        if (!child) return null;
        return {
            propertyNames: child.propertyNames,
            evaluate: (featureIndex, getColumn) => {
                const value = Number(child.evaluate(featureIndex, getColumn));
                switch (operator) {
                    case 'abs': return Math.abs(value);
                    case 'ceil': return Math.ceil(value);
                    case 'floor': return Math.floor(value);
                    case 'round': return value < 0 ? -Math.round(-value) : Math.round(value);
                    case 'sqrt': return Math.sqrt(value);
                    case 'ln': return Math.log(value);
                    case 'log2': return Math.log2(value);
                    case 'log10': return Math.log10(value);
                    case 'sin': return Math.sin(value);
                    case 'cos': return Math.cos(value);
                    case 'tan': return Math.tan(value);
                    case 'asin': return Math.asin(value);
                    case 'acos': return Math.acos(value);
                    case 'atan': return Math.atan(value);
                    default: return value;
                }
            }
        };
    }

    if ((operator === 'concat' || operator === 'upcase' || operator === 'downcase') && expression.length >= 2) {
        const children = compileSerializedColumnarChildren(expression.slice(1), 'value');
        if (!children || ((operator === 'upcase' || operator === 'downcase') && children.length !== 1)) return null;
        return {
            propertyNames: uniquePropertyNames(children),
            evaluate: (featureIndex, getColumn) => {
                let value = '';
                for (const child of children) value += columnarValueToString(child.evaluate(featureIndex, getColumn));
                return operator === 'upcase' ? value.toUpperCase() : operator === 'downcase' ? value.toLowerCase() : value;
            }
        };
    }

    if (operator === 'match' && expression.length >= 5) {
        const input = compileSerializedColumnarExpression(expression[1], 'value');
        if (!input) return null;

        const branches: Array<{labels: Set<unknown>; output: ColumnarExpressionEvaluator}> = [];
        for (let i = 2; i < expression.length - 1; i += 2) {
            const label = expression[i];
            const output = compileSerializedColumnarExpression(expression[i + 1], type);
            if (!output) return null;
            branches.push({
                labels: new Set(Array.isArray(label) ? label : [label]),
                output
            });
        }

        const fallback = compileSerializedColumnarExpression(expression[expression.length - 1], type);
        if (!fallback) return null;

        return {
            propertyNames: uniquePropertyNames([input, fallback, ...branches.map(branch => branch.output)]),
            evaluate: (featureIndex, getColumn) => {
                const value = input.evaluate(featureIndex, getColumn);
                for (const branch of branches) {
                    if (branch.labels.has(value)) {
                        return branch.output.evaluate(featureIndex, getColumn);
                    }
                }
                return fallback.evaluate(featureIndex, getColumn);
            }
        };
    }

    if (operator === 'case' && expression.length >= 4) {
        const branches: Array<{condition: ColumnarBooleanEvaluator; output: ColumnarExpressionEvaluator}> = [];
        for (let i = 1; i < expression.length - 1; i += 2) {
            const condition = compileSerializedColumnarBooleanExpression(expression[i]);
            const output = compileSerializedColumnarExpression(expression[i + 1], type);
            if (!condition || !output) return null;
            branches.push({condition, output});
        }

        const fallback = compileSerializedColumnarExpression(expression[expression.length - 1], type);
        if (!fallback) return null;

        return {
            propertyNames: uniquePropertyNames([fallback, ...branches.flatMap(branch => [branch.condition, branch.output])]),
            evaluate: (featureIndex, getColumn) => {
                for (const branch of branches) {
                    if (branch.condition.evaluate(featureIndex, getColumn)) {
                        return branch.output.evaluate(featureIndex, getColumn);
                    }
                }
                return fallback.evaluate(featureIndex, getColumn);
            }
        };
    }

    return null;
}

function compileSerializedColumnarBooleanExpression(expression: unknown): ColumnarBooleanEvaluator | null {
    if (typeof expression === 'boolean') {
        return {propertyNames: [], evaluate: () => expression};
    }
    if (!Array.isArray(expression)) return null;

    const operator = expression[0];
    if (operator === 'has' && expression.length === 2 && typeof expression[1] === 'string') {
        const propertyName = expression[1];
        return {
            propertyNames: [propertyName],
            evaluate: (featureIndex, getColumn) => readColumnValue(getColumn(propertyName), featureIndex) !== undefined
        };
    }

    if (operator === '!' && expression.length === 2) {
        const child = compileSerializedColumnarBooleanExpression(expression[1]);
        if (!child) return null;
        return {
            propertyNames: child.propertyNames,
            evaluate: (featureIndex, getColumn) => !child.evaluate(featureIndex, getColumn)
        };
    }

    if (operator === 'in' && expression.length === 3) {
        const needle = compileSerializedColumnarExpression(expression[1], 'value');
        const haystack = compileSerializedColumnarExpression(expression[2], 'value');
        if (!needle || !haystack) return null;
        return {
            propertyNames: uniquePropertyNames([needle, haystack]),
            evaluate: (featureIndex, getColumn) => {
                const needleValue = needle.evaluate(featureIndex, getColumn);
                const haystackValue = haystack.evaluate(featureIndex, getColumn);
                return typeof haystackValue === 'string'
                    ? haystackValue.includes(String(needleValue))
                    : Array.isArray(haystackValue) && haystackValue.includes(needleValue);
            }
        };
    }

    if ((operator === '==' || operator === '!=' || operator === '>' || operator === '>=' || operator === '<' || operator === '<=') && expression.length === 3) {
        const left = compileSerializedColumnarExpression(expression[1], 'value');
        const right = compileSerializedColumnarExpression(expression[2], 'value');
        if (!left || !right) return null;
        return {
            propertyNames: uniquePropertyNames([left, right]),
            evaluate: (featureIndex, getColumn) => {
                const leftValue = left.evaluate(featureIndex, getColumn);
                const rightValue = right.evaluate(featureIndex, getColumn);
                switch (operator) {
                    case '==': return leftValue === rightValue;
                    case '!=': return leftValue !== rightValue;
                    case '>': return (leftValue as any) > (rightValue as any);
                    case '>=': return (leftValue as any) >= (rightValue as any);
                    case '<': return (leftValue as any) < (rightValue as any);
                    case '<=': return (leftValue as any) <= (rightValue as any);
                    default: return false;
                }
            }
        };
    }

    if ((operator === 'all' || operator === 'any') && expression.length > 1) {
        const children = expression.slice(1).map(compileSerializedColumnarBooleanExpression);
        if (children.some(child => !child)) return null;
        return {
            propertyNames: uniquePropertyNames(children),
            evaluate: (featureIndex, getColumn) => operator === 'all'
                ? (children).every(child => child.evaluate(featureIndex, getColumn))
                : (children).some(child => child.evaluate(featureIndex, getColumn))
        };
    }

    return null;
}

const unsupportedStyleExpressionNode = Symbol('unsupportedStyleExpressionNode');

function serializeStyleExpressionNode(expression: any): unknown | typeof unsupportedStyleExpressionNode {
    if (!expression || typeof expression !== 'object') return expression;
    if (Object.hasOwn(expression, 'value')) {
        return Array.isArray(expression.value) ? ['literal', expression.value] : expression.value;
    }

    const serializeChildren = (children: any[]): unknown[] | typeof unsupportedStyleExpressionNode => {
        const serialized: unknown[] = [];
        for (const child of children) {
            const value = serializeStyleExpressionNode(child);
            if (value === unsupportedStyleExpressionNode) return unsupportedStyleExpressionNode;
            serialized.push(value);
        }
        return serialized;
    };

    if (expression.name && Array.isArray(expression.args)) {
        const args = serializeChildren(expression.args);
        return args === unsupportedStyleExpressionNode ? args : [expression.name, ...args];
    }

    for (const operator of ['==', '!=', '>', '>=', '<', '<='] as const) {
        const Comparison = (styleExpressionDefinitions as any)[operator];
        if (typeof Comparison !== 'function' || !(expression instanceof Comparison)) continue;
        if (!expression.lhs || !expression.rhs || expression.collator) return unsupportedStyleExpressionNode;
        const left = serializeStyleExpressionNode(expression.lhs);
        const right = serializeStyleExpressionNode(expression.rhs);
        return left === unsupportedStyleExpressionNode || right === unsupportedStyleExpressionNode
            ? unsupportedStyleExpressionNode
            : [operator, left, right];
    }

    const constructorName = expression.constructor?.name;
    if ((constructorName === 'Assertion' || constructorName === 'Coercion' || constructorName === 'Coalesce') && Array.isArray(expression.args)) {
        const args = serializeChildren(expression.args);
        if (args === unsupportedStyleExpressionNode) return args;
        const operator = constructorName === 'Coalesce'
            ? 'coalesce'
            : constructorName === 'Coercion'
                ? `to-${expression.type?.kind}`
                : expression.type?.kind;
        return typeof operator === 'string' ? [operator, ...args] : unsupportedStyleExpressionNode;
    }

    if (constructorName === 'Case' && Array.isArray(expression.branches) && expression.otherwise) {
        const serialized: unknown[] = ['case'];
        for (const branch of expression.branches) {
            if (!Array.isArray(branch) || branch.length !== 2) return unsupportedStyleExpressionNode;
            const condition = serializeStyleExpressionNode(branch[0]);
            const output = serializeStyleExpressionNode(branch[1]);
            if (condition === unsupportedStyleExpressionNode || output === unsupportedStyleExpressionNode) return unsupportedStyleExpressionNode;
            serialized.push(condition, output);
        }
        const fallback = serializeStyleExpressionNode(expression.otherwise);
        if (fallback === unsupportedStyleExpressionNode) return fallback;
        serialized.push(fallback);
        return serialized;
    }

    if (constructorName === 'Match' && expression.input && expression.cases && Array.isArray(expression.outputs) && expression.otherwise) {
        const input = serializeStyleExpressionNode(expression.input);
        const outputs = serializeChildren(expression.outputs);
        const fallback = serializeStyleExpressionNode(expression.otherwise);
        if (input === unsupportedStyleExpressionNode || outputs === unsupportedStyleExpressionNode || fallback === unsupportedStyleExpressionNode) {
            return unsupportedStyleExpressionNode;
        }

        const labelsByOutput = Array.from({length: outputs.length}, () => [] as Array<string | number>);
        for (const [label, outputIndex] of Object.entries(expression.cases)) {
            const normalizedLabel = expression.inputType?.kind === 'number' ? Number(label) : label;
            labelsByOutput[outputIndex as number]?.push(normalizedLabel);
        }
        const serialized: unknown[] = ['match', input];
        for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
            const labels = labelsByOutput[outputIndex];
            serialized.push(labels.length === 1 ? labels[0] : labels, outputs[outputIndex]);
        }
        serialized.push(fallback);
        return serialized;
    }

    if (constructorName === 'In' && expression.needle && expression.haystack) {
        const needle = serializeStyleExpressionNode(expression.needle);
        const haystack = serializeStyleExpressionNode(expression.haystack);
        return needle === unsupportedStyleExpressionNode || haystack === unsupportedStyleExpressionNode
            ? unsupportedStyleExpressionNode
            : ['in', needle, haystack];
    }

    return unsupportedStyleExpressionNode;
}

function compileStyleExpressionNode(expression: any, type: string): ColumnarExpressionEvaluator | null {
    const serializedExpression = serializeStyleExpressionNode(expression);
    if (serializedExpression !== unsupportedStyleExpressionNode) {
        const evaluator = compileSerializedColumnarExpression(serializedExpression, type);
        if (evaluator) return evaluator;
    }

    if (!expression || typeof expression !== 'object') {
        return {propertyNames: [], evaluate: () => expression};
    }

    if (Object.hasOwn(expression, 'value')) {
        const value = convertColumnarPaintOutput(expression.value, type);
        return {propertyNames: [], evaluate: () => value};
    }

    if (!expression.name && Array.isArray(expression.args) && expression.args.length === 1) {
        const child = compileStyleExpressionNode(expression.args[0], type);
        if (!child) return null;
        return {
            propertyNames: child.propertyNames,
            evaluate: (featureIndex, getColumn) => {
                const value = child.evaluate(featureIndex, getColumn);
                return expression.type?.kind === 'number' ? Number(value) : value;
            }
        };
    }

    if (expression.name === 'get' && expression.args?.length === 1) {
        const propertyName = literalValue(expression.args[0]);
        if (typeof propertyName !== 'string') return null;
        return {
            propertyNames: [propertyName],
            evaluate: (featureIndex, getColumn) => {
                return readColumnValue(getColumn(propertyName), featureIndex);
            }
        };
    }

    if (expression.name === '/' && expression.args?.length === 2) {
        const left = compileStyleExpressionNode(expression.args[0], 'number');
        const right = compileStyleExpressionNode(expression.args[1], 'number');
        if (!left || !right) return null;
        return {
            propertyNames: [...left.propertyNames, ...right.propertyNames],
            evaluate: (featureIndex, getColumn) => Number(left.evaluate(featureIndex, getColumn)) / Number(right.evaluate(featureIndex, getColumn))
        };
    }

    if (expression.input && expression.cases && Array.isArray(expression.outputs) && expression.otherwise) {
        const input = compileStyleExpressionNode(expression.input, 'value');
        if (!input) return null;

        const outputs = expression.outputs.map((output) => compileStyleExpressionNode(output, type));
        if (outputs.some(output => !output)) return null;

        const fallback = compileStyleExpressionNode(expression.otherwise, type);
        if (!fallback) return null;

        return {
            propertyNames: uniquePropertyNames([input, fallback, ...(outputs as ColumnarExpressionEvaluator[])]),
            evaluate: (featureIndex, getColumn) => {
                const value = input.evaluate(featureIndex, getColumn);
                const outputIndex = expression.cases[String(value)];
                const output = outputIndex !== undefined ? outputs[outputIndex] : fallback;
                return output.evaluate(featureIndex, getColumn);
            }
        };
    }

    return null;
}

function compileColumnarExpressionEvaluator(expression: SourceExpression, type: string): ColumnarExpressionEvaluator | null {
    const parameters = (expression as any)._parameters;
    if (parameters?.property) {
        return null;
    }

    if (typeof (expression as any).serialize === 'function') {
        const serializedEvaluator = compileSerializedColumnarExpression((expression as any).serialize(), type);
        if (serializedEvaluator) {
            return serializedEvaluator;
        }
    }

    return compileStyleExpressionNode((expression as any)._styleExpression?.expression, type);
}

function collectStyleExpressionNodePropertyDependencies(expression: any, neededProperties: Set<string>): boolean {
    if (!expression || typeof expression !== 'object') return true;
    if (Object.hasOwn(expression, 'value')) return true;
    if (expression.name === 'properties') return false;
    if (expression.name === 'get' || expression.name === 'has') {
        const propertyName = literalValue(expression.args?.[0]);
        if (typeof propertyName !== 'string') return false;
        neededProperties.add(propertyName);
    }

    if (Array.isArray(expression)) {
        for (const child of expression) {
            if (!collectStyleExpressionNodePropertyDependencies(child, neededProperties)) return false;
        }
        return true;
    }

    for (const [key, child] of Object.entries(expression)) {
        if (key === 'type' || key === 'name' || key === 'key' || key === '_evaluate') continue;
        if (!collectStyleExpressionNodePropertyDependencies(child, neededProperties)) return false;
    }
    return true;
}

/**
 *  `Binder` is the interface definition for the strategies for constructing,
 *  uploading, and binding paint property data as GLSL attributes. Most style-
 *  spec properties have a 1:1 relationship to shader attribute/uniforms, but
 *  some require multiple values per feature to be passed to the GPU, and in
 *  those cases we bind multiple attributes/uniforms.
 *
 *  It has three implementations, one for each of the three strategies we use:
 *
 *  * For _constant_ properties -- those whose value is a constant, or the constant
 *    result of evaluating a camera expression at a particular camera position -- we
 *    don't need a vertex attribute buffer, and instead use a uniform.
 *  * For data expressions, we use a vertex buffer with a single attribute value,
 *    the evaluated result of the source function for the given feature.
 *  * For composite expressions, we use a vertex buffer with two attributes: min and
 *    max values covering the range of zooms at which we expect the tile to be
 *    displayed. These values are calculated by evaluating the composite expression for
 *    the given feature at strategically chosen zoom levels. In addition to this
 *    attribute data, we also use a uniform value which the shader uses to interpolate
 *    between the min and max value at the final displayed zoom level. The use of a
 *    uniform allows us to cheaply update the value on every frame.
 *
 *  Note that the shader source varies depending on whether we're using a uniform or
 *  attribute. We dynamically compile shaders at runtime to accommodate this.
 */
interface AttributeBinder {
    populatePaintArray(
        length: number,
        feature: Feature,
        options: PaintOptions
    ): void;
    updatePaintArray(
        start: number,
        length: number,
        feature: Feature,
        featureState: FeatureState,
        options: PaintOptions
    ): void;
    upload(a: Context): void;
    destroy(): void;
}

interface UniformBinder {
    uniformNames: string[];
    setUniform(
        uniform: Uniform<any>,
        globals: GlobalProperties,
        currentValue: PossiblyEvaluatedPropertyValue<any>,
        uniformName: string
    ): void;
    getBinding(context: Context, location: WebGLUniformLocation, name: string): Partial<Uniform<any>>;
}

class ConstantBinder implements UniformBinder {
    value: unknown;
    type: string;
    uniformNames: string[];

    constructor(value: unknown, names: string[], type: string) {
        this.value = value;
        this.uniformNames = names.map(name => `u_${name}`);
        this.type = type;
    }

    setUniform(
        uniform: Uniform<any>,
        globals: GlobalProperties,
        currentValue: PossiblyEvaluatedPropertyValue<unknown>
    ): void {
        uniform.set(currentValue.constantOr(this.value));
    }

    getBinding(context: Context, location: WebGLUniformLocation, _: string): Partial<Uniform<any>> {
        return (this.type === 'color') ?
            new UniformColor(context, location) :
            new Uniform1f(context, location);
    }
}

class CrossFadedConstantBinder implements UniformBinder {
    uniformNames: string[];
    patternFrom: number[];
    patternTo: number[];
    dashFrom: number[];
    dashTo: number[];
    pixelRatioFrom: number;
    pixelRatioTo: number;

    constructor(value: unknown, names: string[]) {
        this.uniformNames = names.map(name => `u_${name}`);
        this.patternFrom = null;
        this.patternTo = null;
        this.pixelRatioFrom = 1.0;
        this.pixelRatioTo = 1.0;
    }

    setConstantPatternPositions(posTo: ImagePosition, posFrom: ImagePosition) {
        this.pixelRatioFrom = posFrom.pixelRatio;
        this.pixelRatioTo = posTo.pixelRatio;
        this.patternFrom = posFrom.tlbr;
        this.patternTo = posTo.tlbr;
    }

    setConstantDashPositions(dashTo: DashEntry, dashFrom: DashEntry) {
        this.dashTo = [0, dashTo.y, dashTo.height, dashTo.width];
        this.dashFrom = [0, dashFrom.y, dashFrom.height, dashFrom.width];
    }

    setUniform(uniform: Uniform<any>, globals: GlobalProperties, currentValue: PossiblyEvaluatedPropertyValue<unknown>, uniformName: string) {
        let value = null;

        if (uniformName === 'u_pattern_to') {
            value = this.patternTo;
        } else if (uniformName === 'u_pattern_from') {
            value = this.patternFrom;
        } else if (uniformName === 'u_dasharray_to') {
            value = this.dashTo;
        } else if (uniformName === 'u_dasharray_from') {
            value = this.dashFrom;
        } else if (uniformName === 'u_pixel_ratio_to') {
            value = this.pixelRatioTo;
        } else if (uniformName === 'u_pixel_ratio_from') {
            value = this.pixelRatioFrom;
        }

        if (value !== null) {
            uniform.set(value);
        }
    }

    getBinding(context: Context, location: WebGLUniformLocation, name: string): Partial<Uniform<any>> {
        return (name.startsWith('u_pattern') || name.startsWith('u_dasharray_')) ?
            new Uniform4f(context, location) :
            new Uniform1f(context, location);
    }
}

class SourceExpressionBinder implements AttributeBinder {
    expression: SourceExpression;
    type: string;
    maxValue: number;
    columnarEvaluator: ColumnarExpressionEvaluator | null;

    paintVertexArray: StructArray;
    paintVertexAttributes: StructArrayMember[];
    paintVertexBuffer: VertexBuffer;

    constructor(expression: SourceExpression, names: string[], type: string, PaintVertexArray: {
        new (...args: any): StructArray;
    }) {
        this.expression = expression;
        this.type = type;
        this.maxValue = 0;
        this.columnarEvaluator = expression.isStateDependent ? null : compileColumnarExpressionEvaluator(expression, type);
        this.paintVertexAttributes = names.map((name) => ({
            name: `a_${name}`,
            type: 'Float32',
            components: type === 'color' ? 2 : 1,
            offset: 0
        }));
        this.paintVertexArray = new PaintVertexArray();
    }

    populatePaintArray(newLength: number, feature: Feature, options: PaintOptions) {
        const start = this.paintVertexArray.length;
        const value = this.expression.evaluate(new EvaluationParameters(0, options), feature, {}, options.canonical, [], options.formattedSection);
        this.paintVertexArray.resize(newLength);
        this._setPaintValue(start, newLength, value);
    }

    canPopulateColumnarPaintArray(getColumn: ColumnarPaintColumnProvider): boolean {
        return !!this.columnarEvaluator && this.columnarEvaluator.propertyNames.every(propertyName => !!getColumn(propertyName));
    }

    populateColumnarPaintArray(newLength: number, featureIndex: number, getColumn: ColumnarPaintColumnProvider): void {
        const start = this.paintVertexArray.length;
        const value = this.columnarEvaluator.evaluate(featureIndex, getColumn);
        this.paintVertexArray.resize(newLength);
        this._setPaintValue(start, newLength, value);
    }

    updatePaintArray(start: number, end: number, feature: Feature, featureState: FeatureState, options: PaintOptions) {
        const value = this.expression.evaluate(new EvaluationParameters(0, options), feature, featureState);
        this._setPaintValue(start, end, value);
    }

    _setPaintValue(start, end, value) {
        if (this.type === 'color') {
            const color = packColor(value);
            for (let i = start; i < end; i++) {
                this.paintVertexArray.emplace(i, color[0], color[1]);
            }
        } else {
            for (let i = start; i < end; i++) {
                this.paintVertexArray.emplace(i, value);
            }
            this.maxValue = Math.max(this.maxValue, Math.abs(value));
        }
    }

    upload(context: Context) {
        if (this.paintVertexArray?.arrayBuffer.byteLength) {
            if (this.paintVertexBuffer?.buffer) {
                this.paintVertexBuffer.updateData(this.paintVertexArray);
            } else {
                this.paintVertexBuffer = context.createVertexBuffer(this.paintVertexArray, this.paintVertexAttributes, this.expression.isStateDependent);
            }
        }
    }

    destroy() {
        if (this.paintVertexBuffer) {
            this.paintVertexBuffer.destroy();
        }
    }
}

class CompositeExpressionBinder implements AttributeBinder, UniformBinder {
    expression: CompositeExpression;
    uniformNames: string[];
    type: string;
    useIntegerZoom: boolean;
    zoom: number;
    maxValue: number;

    paintVertexArray: StructArray;
    paintVertexAttributes: StructArrayMember[];
    paintVertexBuffer: VertexBuffer;

    constructor(expression: CompositeExpression, names: string[], type: string, useIntegerZoom: boolean, zoom: number, PaintVertexArray: {
        new (...args: any): StructArray;
    }) {
        this.expression = expression;
        this.uniformNames = names.map(name => `u_${name}_t`);
        this.type = type;
        this.useIntegerZoom = useIntegerZoom;
        this.zoom = zoom;
        this.maxValue = 0;
        this.paintVertexAttributes = names.map((name) => ({
            name: `a_${name}`,
            type: 'Float32',
            components: type === 'color' ? 4 : 2,
            offset: 0
        }));
        this.paintVertexArray = new PaintVertexArray();
    }

    populatePaintArray(newLength: number, feature: Feature, options: PaintOptions) {
        const min = this.expression.evaluate(new EvaluationParameters(this.zoom, options), feature, {}, options.canonical, [], options.formattedSection);
        const max = this.expression.evaluate(new EvaluationParameters(this.zoom + 1, options), feature, {}, options.canonical, [], options.formattedSection);
        const start = this.paintVertexArray.length;
        this.paintVertexArray.resize(newLength);
        this._setPaintValue(start, newLength, min, max);
    }

    updatePaintArray(start: number, end: number, feature: Feature, featureState: FeatureState, options: PaintOptions) {
        const min = this.expression.evaluate(new EvaluationParameters(this.zoom, options), feature, featureState);
        const max = this.expression.evaluate(new EvaluationParameters(this.zoom + 1, options), feature, featureState);
        this._setPaintValue(start, end, min, max);
    }

    _setPaintValue(start, end, min, max) {
        if (this.type === 'color') {
            const minColor = packColor(min);
            const maxColor = packColor(max);
            for (let i = start; i < end; i++) {
                this.paintVertexArray.emplace(i, minColor[0], minColor[1], maxColor[0], maxColor[1]);
            }
        } else {
            for (let i = start; i < end; i++) {
                this.paintVertexArray.emplace(i, min, max);
            }
            this.maxValue = Math.max(this.maxValue, Math.abs(min), Math.abs(max));
        }
    }

    upload(context: Context) {
        if (this.paintVertexArray?.arrayBuffer.byteLength) {
            if (this.paintVertexBuffer?.buffer) {
                this.paintVertexBuffer.updateData(this.paintVertexArray);
            } else {
                this.paintVertexBuffer = context.createVertexBuffer(this.paintVertexArray, this.paintVertexAttributes, this.expression.isStateDependent);
            }
        }
    }

    destroy() {
        if (this.paintVertexBuffer) {
            this.paintVertexBuffer.destroy();
        }
    }

    setUniform(uniform: Uniform<any>, globals: GlobalProperties): void {
        const currentZoom = this.useIntegerZoom ? Math.floor(globals.zoom) : globals.zoom;
        const factor = clamp(this.expression.interpolationFactor(currentZoom, this.zoom, this.zoom + 1), 0, 1);
        uniform.set(factor);
    }

    getBinding(context: Context, location: WebGLUniformLocation, _: string): Uniform1f {
        return new Uniform1f(context, location);
    }
}

abstract class CrossFadedBinder<T> implements AttributeBinder {
    expression: CompositeExpression;
    type: string;
    useIntegerZoom: boolean;
    zoom: number;
    layerId: string;

    zoomInPaintVertexArray: StructArray;
    zoomOutPaintVertexArray: StructArray;
    zoomInPaintVertexBuffer: VertexBuffer;
    zoomOutPaintVertexBuffer: VertexBuffer;
    paintVertexAttributes: StructArrayMember[];

    constructor(expression: CompositeExpression, type: string, useIntegerZoom: boolean, zoom: number, PaintVertexArray: {
        new (...args: any): StructArray;
    }, layerId: string) {
        this.expression = expression;
        this.type = type;
        this.useIntegerZoom = useIntegerZoom;
        this.zoom = zoom;
        this.layerId = layerId;

        this.zoomInPaintVertexArray = new PaintVertexArray();
        this.zoomOutPaintVertexArray = new PaintVertexArray();
    }

    populatePaintArray(length: number, feature: Feature, options: PaintOptions) {
        const start = this.zoomInPaintVertexArray.length;
        this.zoomInPaintVertexArray.resize(length);
        this.zoomOutPaintVertexArray.resize(length);
        this._setPaintValues(start, length, this.getPositionIds(feature), options);
    }

    updatePaintArray(start: number, end: number, feature: Feature, featureState: FeatureState, options: PaintOptions) {
        this._setPaintValues(start, end, this.getPositionIds(feature), options);
    }

    abstract getVertexAttributes(): StructArrayMember[];

    protected abstract getPositionIds(feature: Feature): {min: string; mid: string; max: string};
    protected abstract getPositions(options: PaintOptions): {[_: string]: T};
    protected abstract emplace(array: StructArray, index: number, fromPos: T, toPos: T): void;

    protected _setPaintValues(start: number, end: number, positionIds: {min: string; mid: string; max: string}, options: PaintOptions) {
        const positions = this.getPositions(options);
        if (!positions || !positionIds) return;
        const min = positions[positionIds.min];
        const mid = positions[positionIds.mid];
        const max = positions[positionIds.max];
        if (!min || !mid || !max) return;

        // We populate two paint arrays because, for cross-faded properties, we don't know which direction
        // we're cross-fading to at layout time. In order to keep vertex attributes to a minimum and not pass
        // unnecessary vertex data to the shaders, we determine which to upload at draw time.
        //
        // The crossfade `from` vertex is the value at the previous integer zoom (min when zooming in,
        // max when zooming out) and `to` is the value at the current integer zoom (mid). This matches the
        // convention used by CrossFadedConstantBinder, where `u_dasharray_to` / `u_pattern_to` carry the
        // current zoom's value and the crossfade `t` blends from the previous value to it.
        for (let i = start; i < end; i++) {
            this.emplace(this.zoomInPaintVertexArray, i, min, mid);
            this.emplace(this.zoomOutPaintVertexArray, i, max, mid);
        }
    }

    upload(context: Context) {
        if (this.zoomInPaintVertexArray?.arrayBuffer.byteLength && this.zoomOutPaintVertexArray?.arrayBuffer.byteLength) {
            const attributes = this.getVertexAttributes();
            this.zoomInPaintVertexBuffer = context.createVertexBuffer(this.zoomInPaintVertexArray, attributes, this.expression.isStateDependent);
            this.zoomOutPaintVertexBuffer = context.createVertexBuffer(this.zoomOutPaintVertexArray, attributes, this.expression.isStateDependent);
        }
    }

    destroy() {
        if (this.zoomOutPaintVertexBuffer) this.zoomOutPaintVertexBuffer.destroy();
        if (this.zoomInPaintVertexBuffer) this.zoomInPaintVertexBuffer.destroy();
    }
}

class CrossFadedPatternBinder extends CrossFadedBinder<ImagePosition> {
    protected getPositions(options: PaintOptions): {[_: string]: ImagePosition} {
        return options.imagePositions;
    }

    protected getPositionIds(feature: Feature) {
        return feature.patterns?.[this.layerId];
    }

    getVertexAttributes(): StructArrayMember[] {
        return patternAttributes.members;
    }

    protected emplace(array: StructArray, index: number, fromPos: ImagePosition, toPos: ImagePosition): void {
        array.emplace(index,
            fromPos.tlbr[0], fromPos.tlbr[1], fromPos.tlbr[2], fromPos.tlbr[3],
            toPos.tlbr[0], toPos.tlbr[1], toPos.tlbr[2], toPos.tlbr[3],
            fromPos.pixelRatio,
            toPos.pixelRatio,
        );
    }
}

class CrossFadedDasharrayBinder extends CrossFadedBinder<DashEntry> {
    protected getPositions(options: PaintOptions): {[_: string]: DashEntry} {
        return options.dashPositions;
    }

    protected getPositionIds(feature: Feature) {
        return feature.dashes?.[this.layerId];
    }

    getVertexAttributes(): StructArrayMember[] {
        return dashAttributes.members;
    }

    protected emplace(array: StructArray, index: number, fromPos: DashEntry, toPos: DashEntry): void {
        array.emplace(index,
            0, fromPos.y, fromPos.height, fromPos.width,
            0, toPos.y, toPos.height, toPos.width,
        );
    }
}

/**
 * @internal
 * ProgramConfiguration contains the logic for binding style layer properties and tile
 * layer feature data into GL program uniforms and vertex attributes.
 *
 * Non-data-driven property values are bound to shader uniforms. Data-driven property
 * values are bound to vertex attributes. In order to support a uniform GLSL syntax over
 * both, the [shaders](../shaders/README.md) define a `#pragma` abstraction, which
 * ProgramConfiguration is responsible for implementing. At runtime,
 * it examines the attributes of a particular layer, combines this with fixed knowledge
 * about how layers of the particular type are implemented, and determines which uniforms
 * and vertex attributes will be required. It can then substitute the appropriate text
 * into the shader source code, create and link a program, and bind the uniforms and
 * vertex attributes in preparation for drawing.
 *
 * When a vector tile is parsed, this same configuration information is used to
 * populate the attribute buffers needed for data-driven styling using the zoom
 * level and feature property data.
 */
export class ProgramConfiguration {
    binders: {[_: string]: AttributeBinder | UniformBinder};
    cacheKey: string;

    _buffers: VertexBuffer[];

    constructor(layer: TypedStyleLayer, zoom: number, filterProperties: (_: string) => boolean) {
        this.binders = {};
        this._buffers = [];

        const keys = [];

        for (const property in layer.paint._values) {
            if (!filterProperties(property)) continue;
            const value = (layer.paint as any).get(property);
            if (!(value instanceof PossiblyEvaluatedPropertyValue) || !supportsPropertyExpression(value.property.specification)) {
                continue;
            }
            const names = paintAttributeNames(property, layer.type);
            const expression = value.value;
            const type = value.property.specification.type;
            const useIntegerZoom = (value.property as any).useIntegerZoom;
            const propType = value.property.specification['property-type'];
            const isCrossFaded = propType === 'cross-faded' || propType === 'cross-faded-data-driven';

            if (expression.kind === 'constant') {
                this.binders[property] = isCrossFaded ?
                    new CrossFadedConstantBinder(expression.value, names) :
                    new ConstantBinder(expression.value, names, type);
                keys.push(`/u_${property}`);

            } else if (expression.kind === 'source' || isCrossFaded) {
                const StructArrayLayout = layoutType(property, type, 'source');
                this.binders[property] = isCrossFaded ?
                    property === 'line-dasharray' ?
                        new CrossFadedDasharrayBinder(expression as CompositeExpression, type, useIntegerZoom, zoom, StructArrayLayout, layer.id) :
                        new CrossFadedPatternBinder(expression as CompositeExpression, type, useIntegerZoom, zoom, StructArrayLayout, layer.id) :
                    new SourceExpressionBinder(expression as SourceExpression, names, type, StructArrayLayout);
                keys.push(`/a_${property}`);

            } else {
                const StructArrayLayout = layoutType(property, type, 'composite');
                this.binders[property] = new CompositeExpressionBinder(expression, names, type, useIntegerZoom, zoom, StructArrayLayout);
                keys.push(`/z_${property}`);
            }
        }

        this.cacheKey = keys.sort().join('');
    }

    getMaxValue(property: string): number {
        const binder = this.binders[property];
        return binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder ? binder.maxValue : 0;
    }

    populatePaintArrays(newLength: number, feature: Feature, options: PaintOptions): void {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedBinder)
                binder.populatePaintArray(newLength, feature, options);
        }
    }

    canPopulateColumnarPaintArrays(getColumn: ColumnarPaintColumnProvider): boolean {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder) {
                if (!binder.canPopulateColumnarPaintArray(getColumn)) return false;
            } else if (binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedBinder) {
                return false;
            }
        }

        return true;
    }

    populateColumnarPaintArrays(newLength: number, featureIndex: number, getColumn: ColumnarPaintColumnProvider): void {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder) {
                binder.populateColumnarPaintArray(newLength, featureIndex, getColumn);
            }
        }
    }

    setConstantPatternPositions(posTo: ImagePosition, posFrom: ImagePosition): void {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof CrossFadedConstantBinder)
                binder.setConstantPatternPositions(posTo, posFrom);
        }
    }

    setConstantDashPositions(dashTo: DashEntry, dashFrom: DashEntry): void {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof CrossFadedConstantBinder)
                binder.setConstantDashPositions(dashTo, dashFrom);
        }
    }

    updatePaintArrays(
        featureStates: FeatureStates,
        featureMap: FeaturePositionMap,
        vtLayer: VectorTileLayerLike | undefined,
        layer: TypedStyleLayer,
        options: PaintOptions,
        featureProvider?: PaintFeatureProvider
    ): boolean {
        let dirty: boolean = false;
        for (const fs of featureStates) {
            const positions = featureMap.getPositions(fs.id);

            for (const pos of positions) {
                const feature = featureProvider ? featureProvider(pos.index) : vtLayer?.feature(pos.index);
                if (!feature) {
                    throw new Error('Feature-state paint update requires a feature provider or vector tile layer');
                }

                for (const property in this.binders) {
                    const binder = this.binders[property];
                    if ((binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder ||
                         binder instanceof CrossFadedBinder) && binder.expression.isStateDependent === true) {
                        //AHM: Remove after https://github.com/mapbox/mapbox-gl-js/issues/6255
                        const value = (layer.paint as any).get(property);
                        binder.expression = value.value;
                        binder.updatePaintArray(pos.start, pos.end, feature, fs.state, options);
                        dirty = true;
                    }
                }
            }
        }
        return dirty;
    }

    collectStateDependentPropertyDependencies(neededProperties: Set<string>): {hasStateDependentBinder: boolean; complete: boolean} {
        let hasStateDependentBinder = false;
        for (const binder of Object.values(this.binders)) {
            if (!(binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedBinder)) continue;
            if (!binder.expression.isStateDependent) continue;
            hasStateDependentBinder = true;
            const serializedExpression = typeof (binder.expression as any).serialize === 'function'
                ? (binder.expression as any).serialize()
                : undefined;
            const complete = serializedExpression !== undefined
                ? collectExpressionPropertyDependencies(serializedExpression, neededProperties)
                : collectStyleExpressionNodePropertyDependencies((binder.expression as any)._styleExpression?.expression, neededProperties);
            if (!complete) {
                return {hasStateDependentBinder, complete: false};
            }
        }
        return {hasStateDependentBinder, complete: true};
    }

    defines(): string[] {
        const result = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof ConstantBinder || binder instanceof CrossFadedConstantBinder) {
                result.push(...binder.uniformNames.map(name => `#define HAS_UNIFORM_${name}`));
            }
        }
        return result;
    }

    getBinderAttributes(): string[] {
        const result = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder) {
                for (const attribute of binder.paintVertexAttributes) {
                    result.push(attribute.name);
                }
            } else if (binder instanceof CrossFadedBinder) {
                const attributes = binder.getVertexAttributes();
                for (const attribute of attributes) {
                    result.push(attribute.name);
                }
            }
        }
        return result;
    }

    getBinderUniforms(): string[] {
        const uniforms = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof ConstantBinder || binder instanceof CrossFadedConstantBinder || binder instanceof CompositeExpressionBinder) {
                for (const uniformName of binder.uniformNames) {
                    uniforms.push(uniformName);
                }
            }
        }
        return uniforms;
    }

    getPaintVertexBuffers(): VertexBuffer[] {
        return this._buffers || [];
    }

    getUniforms(context: Context, locations: UniformLocations): BinderUniform[] {
        const uniforms = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof ConstantBinder || binder instanceof CrossFadedConstantBinder || binder instanceof CompositeExpressionBinder) {
                for (const name of binder.uniformNames) {
                    if (locations[name]) {
                        const binding = binder.getBinding(context, locations[name], name);
                        uniforms.push({name, property, binding});
                    }
                }
            }
        }
        return uniforms;
    }

    setUniforms(
        context: Context,
        binderUniforms: BinderUniform[],
        properties: any,
        globals: GlobalProperties
    ): void {
        // Uniform state bindings are owned by the Program, but we set them
        // from within the ProgramConfiguration's binder members.
        for (const {name, property, binding} of binderUniforms) {
            (this.binders[property] as any).setUniform(binding, globals, properties.get(property), name);
        }
    }

    updatePaintBuffers(crossfade?: CrossfadeParameters): void {
        this._buffers = [];

        for (const property in this.binders) {
            const binder = this.binders[property];
            if (crossfade && binder instanceof CrossFadedBinder) {
                const patternVertexBuffer = crossfade.fromScale === 2 ? binder.zoomInPaintVertexBuffer : binder.zoomOutPaintVertexBuffer;
                if (patternVertexBuffer) this._buffers.push(patternVertexBuffer);

            } else if ((binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder) && binder.paintVertexBuffer) {
                this._buffers.push(binder.paintVertexBuffer);
            }
        }
    }

    upload(context: Context): void {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedBinder)
                binder.upload(context);
        }
        this.updatePaintBuffers();
    }

    destroy(): void {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedBinder)
                binder.destroy();
        }
    }
}

export class ProgramConfigurationSet<Layer extends TypedStyleLayer> {
    programConfigurations: {[_: string]: ProgramConfiguration};
    needsUpload: boolean;
    _featureMap: FeaturePositionMap;
    _bufferOffset: number;
    columnarFeatureStateData?: ColumnarFeatureStateData;

    constructor(layers: readonly Layer[], zoom: number, filterProperties: (_: string) => boolean = () => true) {
        this.programConfigurations = {};
        for (const layer of layers) {
            this.programConfigurations[layer.id] = new ProgramConfiguration(layer, zoom, filterProperties);
        }
        this.needsUpload = false;
        this._featureMap = new FeaturePositionMap();
        this._bufferOffset = 0;
    }

    populatePaintArrays(length: number, feature: Feature, index: number, options: PaintOptions): void {
        for (const key in this.programConfigurations) {
            this.programConfigurations[key].populatePaintArrays(length, feature, options);
        }

        if (feature.id !== undefined) {
            this._featureMap.add(feature.id, index, this._bufferOffset, length);
        }
        this._bufferOffset = length;

        this.needsUpload = true;
    }

    canPopulateColumnarPaintArrays(getColumn: ColumnarPaintColumnProvider): boolean {
        for (const key in this.programConfigurations) {
            if (!this.programConfigurations[key].canPopulateColumnarPaintArrays(getColumn)) {
                return false;
            }
        }

        return true;
    }

    populateColumnarPaintArrays(length: number, featureIndex: number, featureId: number | string | undefined, getColumn: ColumnarPaintColumnProvider): void {
        for (const key in this.programConfigurations) {
            this.programConfigurations[key].populateColumnarPaintArrays(length, featureIndex, getColumn);
        }

        if (featureId !== undefined) {
            this._featureMap.add(featureId, featureIndex, this._bufferOffset, length);
        }
        this._bufferOffset = length;

        this.needsUpload = true;
    }

    getFeaturePropertyDependencies(): Set<string> | null {
        const needed = new Set<string>();

        for (const cfg of Object.values(this.programConfigurations)) {
            for (const binder of Object.values(cfg.binders)) {
                if (binder instanceof SourceExpressionBinder) {
                    if (!binder.columnarEvaluator) return null;
                    for (const propertyName of binder.columnarEvaluator.propertyNames) {
                        needed.add(propertyName);
                    }
                } else if (binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedBinder) {
                    return null;
                }
            }
        }

        return needed;
    }

    prepareColumnarFeatureStateData(featureTable: FeatureTable, resolveId: ColumnarFeatureIdResolver): void {
        const neededProperties = new Set<string>();
        let hasStateDependentBinder = false;
        let complete = true;
        for (const configuration of Object.values(this.programConfigurations)) {
            const dependencies = configuration.collectStateDependentPropertyDependencies(neededProperties);
            hasStateDependentBinder ||= dependencies.hasStateDependentBinder;
            complete &&= dependencies.complete;
        }
        if (!hasStateDependentBinder) return;

        this.columnarFeatureStateData = ColumnarFeatureStateData.create(
            featureTable,
            this._featureMap,
            complete ? neededProperties : null,
            resolveId,
        );
    }

    canUpdatePaintArraysWithoutVtLayer(): boolean {
        for (const configuration of Object.values(this.programConfigurations)) {
            const dependencies = configuration.collectStateDependentPropertyDependencies(new Set());
            if (dependencies.hasStateDependentBinder && !this.columnarFeatureStateData) return false;
        }
        return true;
    }

    updatePaintArrays(featureStates: FeatureStates, vtLayer: VectorTileLayerLike | undefined, layers: readonly TypedStyleLayer[], options: PaintOptions, featureProvider?: PaintFeatureProvider): void {
        const stateData = this.columnarFeatureStateData;
        const paintFeatureProvider = featureProvider ?? stateData?.getFeatureProvider();
        const featureMap = stateData?.featureMap ?? this._featureMap;
        for (const layer of layers) {
            this.needsUpload = this.programConfigurations[layer.id].updatePaintArrays(featureStates, featureMap, vtLayer, layer, options, paintFeatureProvider) || this.needsUpload;
        }
    }

    get(layerId: string): ProgramConfiguration {
        return this.programConfigurations[layerId];
    }

    upload(context: Context): void {
        if (!this.needsUpload) return;
        for (const layerId in this.programConfigurations) {
            this.programConfigurations[layerId].upload(context);
        }
        this.needsUpload = false;
    }

    destroy(): void {
        for (const layerId in this.programConfigurations) {
            this.programConfigurations[layerId].destroy();
        }
    }
}

function paintAttributeNames(property: string, type: string) {
    const attributeNameExceptions = {
        'text-opacity': ['opacity'],
        'icon-opacity': ['opacity'],
        'text-color': ['fill_color'],
        'icon-color': ['fill_color'],
        'text-halo-color': ['halo_color'],
        'icon-halo-color': ['halo_color'],
        'text-halo-blur': ['halo_blur'],
        'icon-halo-blur': ['halo_blur'],
        'text-halo-width': ['halo_width'],
        'icon-halo-width': ['halo_width'],
        'line-gap-width': ['gapwidth'],
        'line-dasharray': ['dasharray_to', 'dasharray_from'],
        'line-pattern': ['pattern_to', 'pattern_from', 'pixel_ratio_to', 'pixel_ratio_from'],
        'fill-pattern': ['pattern_to', 'pattern_from', 'pixel_ratio_to', 'pixel_ratio_from'],
        'fill-extrusion-pattern': ['pattern_to', 'pattern_from', 'pixel_ratio_to', 'pixel_ratio_from'],
    };

    return attributeNameExceptions[property] || [property.replace(`${type}-`, '').replace(/-/g, '_')];
}

function getLayoutException(property: string) {
    const propertyExceptions = {
        'line-pattern': {
            'source': PatternLayoutArray,
            'composite': PatternLayoutArray
        },
        'fill-pattern': {
            'source': PatternLayoutArray,
            'composite': PatternLayoutArray
        },
        'fill-extrusion-pattern': {
            'source': PatternLayoutArray,
            'composite': PatternLayoutArray
        },
        'line-dasharray': {
            'source': DashLayoutArray,
            'composite': DashLayoutArray
        },
    };

    return propertyExceptions[property];
}

function layoutType(property: string, type: string, binderType: string) {
    const defaultLayouts = {
        'color': {
            'source': StructArrayLayout2f8,
            'composite': StructArrayLayout4f16
        },
        'number': {
            'source': StructArrayLayout1f4,
            'composite': StructArrayLayout2f8
        }
    };

    const layoutException = getLayoutException(property);
    return  layoutException?.[binderType] || defaultLayouts[type][binderType];
}

register('ConstantBinder', ConstantBinder);
register('CrossFadedConstantBinder', CrossFadedConstantBinder);
register('SourceExpressionBinder', SourceExpressionBinder, {omit: ['columnarEvaluator']});
register('CrossFadedPatternBinder', CrossFadedPatternBinder);
register('CrossFadedDasharrayBinder', CrossFadedDasharrayBinder);
register('CompositeExpressionBinder', CompositeExpressionBinder);
register('ProgramConfiguration', ProgramConfiguration, {omit: ['_buffers']});
register('ProgramConfigurationSet', ProgramConfigurationSet);
