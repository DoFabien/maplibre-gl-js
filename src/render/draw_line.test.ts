import {describe, test, expect, vi} from 'vitest';
import {mat4} from 'gl-matrix';
import {OverscaledTileID} from '../tile/tile_id';
import {TileManager} from '../tile/tile_manager';
import {Tile} from '../tile/tile';
import {Painter} from './painter';
import {createRenderContext} from './render_context.ts';
import {Program} from '../webgl/program';
import {LineStyleLayer} from '../style/style_layer/line_style_layer';
import {drawLine} from '../webgl/draw/draw_line';
import {createIdentityMat4f32} from '../util/util';

import type {ZoomHistory} from '../style/zoom_history';
import type {EvaluationParameters} from '../style/evaluation_parameters';
import type {Style} from '../style/style';
import type {ProgramConfiguration, ProgramConfigurationSet} from '../data/program_configuration';
import type {ProjectionData} from '../geo/projection/projection_data';
import type {IReadonlyTransform} from '../geo/transform_interface';

vi.mock(import('./painter'));
vi.mock(import('../webgl/program'));
vi.mock(import('../tile/tile_manager'));
vi.mock(import('../tile/tile'));

describe('drawLine', () => {
    test('uses the lineGradient program and passes layoutVertexBuffer2 for clipped columnar buckets', () => {
        const painterMock = constructMockPainter();
        const layer = constructMockLayer();
        const programMock = new Program(null, null, null, null, null, null, null, null);
        (vi.mocked(painterMock.useProgram)).mockReturnValue(programMock);

        const tile = constructMockTile(layer);
        const tileManagerMock = new TileManager(null, null, null);
        (vi.mocked(tileManagerMock.getTile)).mockReturnValue(tile);
        tileManagerMock.map = {showCollisionBoxes: false} as any;

        const renderOptions = createRenderContext(painterMock.transform, undefined, null);
        renderOptions.currentPass = 'translucent';
        drawLine(painterMock, tileManagerMock, layer, [tile.tileID], renderOptions);

        expect(painterMock.useProgram).toHaveBeenCalledWith('lineGradient', expect.any(Object));
        expect(programMock.draw).toHaveBeenCalledTimes(1);

        const drawArgs = (vi.mocked(programMock.draw)).mock.calls[0];
        const bucket = tile.getBucket(layer) as any;
        expect(drawArgs[10]).toBe(bucket.layoutVertexBuffer);
        expect(drawArgs[16]).toBe(bucket.layoutVertexBuffer2);
    });

    function constructMockLayer(): LineStyleLayer {
        const layer = new LineStyleLayer({
            id: 'mock-line-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'line',
            paint: {
                'line-width': 1,
                'line-gradient': [
                    'interpolate',
                    ['linear'],
                    ['line-progress'],
                    0,
                    '#000000',
                    1,
                    '#ffffff'
                ]
            }
        }, {});
        layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        return layer;
    }

    function constructMockPainter(): Painter {
        const painterMock = new Painter(null, null);
        painterMock.context = {
            gl: {
                TEXTURE0: 0,
                LINEAR: 9729,
                NEAREST: 9728,
                CLAMP_TO_EDGE: 33071,
            },
            activeTexture: {
                set: vi.fn()
            },
            program: {
                get: vi.fn(() => null)
            }
        } as any;
        painterMock.transform = {
            pitch: 0,
            labelPlaneMatrix: mat4.create(),
            zoom: 0,
            tileZoom: 0,
            pixelsToGLUnits: [1, 1],
            getPixelScale: () => 1,
            getProjectionData(_canonical, fallback): ProjectionData {
                return {
                    mainMatrix: fallback,
                    tileMercatorCoords: [0, 0, 1, 1],
                    clippingPlane: [0, 0, 0, 0],
                    projectionTransition: 0.0,
                    fallbackMatrix: fallback,
                    clipAntimeridian: false,
                };
            },
        } as any as IReadonlyTransform;
        painterMock.style = {
            map: {
                terrain: null
            }
        } as any as Style;
        painterMock.colorModeForRenderPass = vi.fn(() => ({} as any));
        painterMock.getDepthModeForSublayer = vi.fn(() => ({} as any));
        painterMock.stencilModeForClipping = vi.fn(() => ({} as any));
        return painterMock;
    }

    function constructMockTile(layer: LineStyleLayer): Tile {
        const tileId = new OverscaledTileID(1, 0, 1, 0, 0);
        tileId.terrainRttPosMatrix32f = createIdentityMat4f32();

        const tile = new Tile(tileId, 256);
        tile.tileID = tileId;
        tile.tileSize = 512;

        const bucket = {
            gradients: {
                [layer.id]: {
                    texture: {
                        bind: vi.fn()
                    },
                    version: layer.gradientVersion
                }
            },
            lineClipsArray: [{start: 0.25, end: 0.75}],
            layoutVertexBuffer: {},
            layoutVertexBuffer2: {},
            indexBuffer: {},
            segments: {},
            layerIds: [layer.id],
            gradientsVersion: layer.gradientVersion,
            programConfigurations: {
                get: () => ({
                    updatePaintBuffers: vi.fn()
                } as any as ProgramConfiguration)
            } as any as ProgramConfigurationSet<LineStyleLayer>
        };

        (vi.mocked(tile.getBucket)).mockReturnValue(bucket as any);
        return tile;
    }
});
