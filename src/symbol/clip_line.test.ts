import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {clipGeometry, clipLine, clipLineFlat, clipLineStreaming} from './clip_line.ts';

describe('clipLines', () => {

    const minX = -300;
    const maxX = 300;
    const minY = -200;
    const maxY = 200;

    const clipLineTest = (lines) => {
        return clipLine(lines, minX, minY, maxX, maxY);
    };

    test('Single line fully inside', () => {
        const line = [
            new Point(-100, -100),
            new Point(-40, -100),
            new Point(200, 0),
            new Point(-80, 195)
        ];

        expect(clipLineTest([line])).toEqual([line]);
    });

    test('Multiline fully inside', () => {
        const line0 = [
            new Point(-250, -150),
            new Point(-250, 150),
            new Point(-10, 150),
            new Point(-10, -150)
        ];

        const line1 = [
            new Point(250, -150),
            new Point(250, 150),
            new Point(10, 150),
            new Point(10, -150)
        ];

        const lines = [line0, line1];

        expect(clipLineTest(lines)).toEqual(lines);
    });

    test('Lines fully outside', () => {
        const line0 = [
            new Point(-400, -300),
            new Point(-350, 0),
            new Point(-300, 300)
        ];

        const line1 = [
            new Point(1000, 210),
            new Point(10000, 500)
        ];

        expect(clipLineTest([line0, line1])).toEqual([]);
    });

    test('Intersect with single border', () => {
        const line0 = [
            new Point(-400, 0),
            new Point(0, 0)
        ];

        const result0 = [
            new Point(minX, 0),
            new Point(0, 0)
        ];

        const line1 = [
            new Point(250, -50),
            new Point(350, 50)
        ];

        const result1 = [
            new Point(250, -50),
            new Point(maxX, 0)
        ];

        expect(clipLineTest([line0, line1])).toEqual([result0, result1]);
    });

    test('Intersect with multiple borders', () => {
        const line0 = [
            new Point(-350, -100),
            new Point(-200, -250)
        ];

        const line1 = [
            new Point(-100, 250),
            new Point(0, 150),
            new Point(100, 250)
        ];

        const result0 = [
            new Point(minX, -150),
            new Point(-250, minY)
        ];

        const result1 = [
            new Point(-50, maxY),
            new Point(0, 150),
            new Point(50, maxY)
        ];

        expect(clipLineTest([line0, line1])).toEqual([result0, result1]);
    });

    test('Single line can be split into multiple segments', () => {
        const line = [
            new Point(-80, 150),
            new Point(-80, 350),
            new Point(120, 1000),
            new Point(120, 0)
        ];

        const result0 = [
            new Point(-80, 150),
            new Point(-80, maxY),
        ];

        const result1 = [
            new Point(120, maxY),
            new Point(120, 0),
        ];

        expect(clipLineTest([line])).toEqual([result0, result1]);
    });

    test('Non-clipped points are bit exact', () => {
        const line = [
            new Point(-500, -200),
            new Point(131.2356763, 0.956732)
        ];

        expect(clipLineTest([line])[1]).toEqual(line[0][1]);
    });

    test('Clipped points are rounded to the nearest integer', () => {
        const line = [
            new Point(310, 2.9),
            new Point(290, 2.5)
        ];

        const result = [
            new Point(maxX, 3),
            new Point(290, 2.5)
        ];

        expect(clipLineTest([line])).toEqual([result]);
    });

    test('flattened lines match Point geometry clipping', () => {
        const lines = [
            [new Point(-350, -100), new Point(-200, -250)],
            [new Point(-100, 250), new Point(0, 150), new Point(100, 250)],
            [new Point(-80, 150), new Point(-80, 350), new Point(120, 1000), new Point(120, 0)]
        ];

        for (const line of lines) {
            const flattened = line.flatMap(point => [point.x, point.y]);
            const expected = clipLineTest([line]).map(part => part.flatMap(point => [point.x, point.y]));
            expect(clipLineFlat(flattened, minX, minY, maxX, maxY)).toEqual(expected);
        }
    });

    const clipStreaming = (line: number[]) => {
        let offset = 0;
        const clipped: number[][] = [];
        clipLineStreaming({
            x: 0,
            y: 0,
            next() {
                if (offset >= line.length) return false;
                this.x = line[offset++];
                this.y = line[offset++];
                return true;
            }
        }, minX, minY, maxX, maxY, part => clipped.push(part));
        return clipped;
    };

    test.each([
        {
            name: 'inside',
            line: [-250, -150, -20, 170, 250, -150]
        },
        {
            name: 'outside',
            line: [-500, -300, -450, -250, -400, -300]
        },
        {
            name: 'all four borders',
            line: [-400, 0, 0, -300, 400, 0, 0, 300, -400, 0]
        },
        {
            name: 'rounded intersections',
            line: [310, 2.9, 290, 2.5, -310, -3.4]
        },
        {
            name: 'repeated vertices',
            line: [-100, 0, -100, 0, 100, 0, 100, 0]
        },
        {
            name: 'degenerate segments',
            line: [-400, 0, -400, 0, 0, 0, 0, 0, 400, 0]
        },
        {
            name: 'split and re-enter',
            line: [-80, 150, -80, 350, 120, 1000, 120, 0]
        }
    ])('streaming clipping is differential-equivalent for $name', ({line}) => {
        const points = [];
        for (let i = 0; i < line.length; i += 2) points.push(new Point(line[i], line[i + 1]));
        const expected = clipLineTest([points]).map(part => part.flatMap(point => [point.x, point.y]));
        expect(clipStreaming(line)).toEqual(expected);
    });

    test('streaming clipping preserves multipart boundaries', () => {
        const parts = [
            [-400, 0, 0, 0],
            [0, -300, 0, 300],
            [400, 300, 450, 350]
        ];
        const actual = parts.map(clipStreaming);
        const expected = parts.map(line => {
            const points = [];
            for (let i = 0; i < line.length; i += 2) points.push(new Point(line[i], line[i + 1]));
            return clipLineTest([points]).map(part => part.flatMap(point => [point.x, point.y]));
        });
        expect(actual).toEqual(expected);
    });
});

describe('clipGeometry', () => {

    test('Empty geometry', () => {
        expect(clipGeometry([], 2, -300, -200, 300, 200)).toEqual([]);
    });

    test('unknown geometry type', () => {
        expect(clipGeometry([], 0, -300, -200, 300, 200)).toEqual([]);
    });

    test('point fully inside', () => {
        const point = [
            new Point(100, 100)
        ];

        expect(clipGeometry([point], 1, -300, -200, 300, 200)).toEqual([point]);
    });

    test('point fully outside', () => {
        const point = [
            new Point(400, 100)
        ];

        expect(clipGeometry([point], 1, -300, -200, 300, 200)).toEqual([]);
    });

    test('Line fully inside', () => {
        const line = [
            new Point(-100, -100),
            new Point(-40, -100),
            new Point(200, 0),
            new Point(-80, 195)
        ];

        expect(clipGeometry([line], 2, -300, -200, 300, 200)).toEqual([line]);
    });

    test('Line fully outside', () => {
        const line = [
            new Point(-400, 0),
            new Point(-350, 0),
            new Point(-300, 0)
        ];

        expect(clipGeometry([line], 2, -299, -200, 300, 200)).toEqual([]);
    });

    test('Intersect with borders', () => {
        const line = [
            new Point(-400, 0),
            new Point(0, 0),
            new Point(400, 0)
        ];

        const result = [
            [
                new Point(-300, 0),
                new Point(0, 0),
                new Point(300, 0)
            ]
        ];

        expect(clipGeometry([line], 2, -300, -200, 300, 200)).toEqual(result);
    });

    test('Line can be split into multiple segments', () => {
        const line = [
            new Point(-80, 150),
            new Point(-80, 350),
            new Point(120, 1000),
            new Point(120, 0)
        ];

        const result = [
            [
                new Point(-80, 150),
                new Point(-80, 200),
            ],
            [
                new Point(120, 200),
                new Point(120, 0),
            ]
        ];

        expect(clipGeometry([line], 2, -300, -200, 300, 200)).toEqual(result);
    });

    test('Polygon fully inside', () => {
        const polygon = [
            new Point(-100, -100),
            new Point(100, -100),
            new Point(100, 100),
            new Point(-100, 100),
            new Point(-100, -100)
        ];

        expect(clipGeometry([polygon], 3, -300, -200, 300, 200)).toEqual([polygon]);
    });

    test('Polygon fully outside', () => {
        const polygon = [
            new Point(-400, -300),
            new Point(-350, -300),
            new Point(-350, -250),
            new Point(-400, -250),
            new Point(-400, -300)
        ];

        expect(clipGeometry([polygon], 3, -300, -200, 300, 200)).toEqual([]);
    });

    test('Intersect polygon with borders', () => {
        const polygon = [
            new Point(-400, -400),
            new Point(400, -400),
            new Point(400, 400),
            new Point(-400, 400),
            new Point(-400, -400)
        ];

        const result = [
            [
                new Point(200, -200),
                new Point(200, 200),
                new Point(-200, 200),
                new Point(-200, -200),
                new Point(200, -200)
            ]
        ];
        expect(clipGeometry([polygon], 3, -200, -200, 200, 200)).toEqual(result);
    });
});
