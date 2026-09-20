import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const lineCases = [
    {
        id: 'class-eq',
        color: '#0057ff',
        offset: -30,
        filter: ['==', ['get', 'class'], 'path']
    },
    {
        id: 'match-type',
        color: '#00a36c',
        offset: -20,
        filter: ['match', ['get', 'type'], ['footway', 'cycleway'], true, false]
    },
    {
        id: 'has-not-eq',
        color: '#9a4dff',
        offset: -10,
        filter: ['all', ['has', ['literal', 'class']], ['!=', ['get', 'class'], 'service']]
    },
    {
        id: 'coalesce-number',
        color: '#ff7a00',
        offset: 0,
        filter: ['>', ['coalesce', ['to-number', ['get', 'osm_id']], 0], 100000000]
    },
    {
        id: 'modulo',
        color: '#c90024',
        offset: 10,
        filter: ['==', ['%', ['to-number', ['get', 'osm_id']], 3], 0]
    },
    {
        id: 'concat-length',
        color: '#006d8f',
        offset: 20,
        filter: ['all', ['==', ['concat', ['get', 'class'], '-', ['get', 'type']], 'path-footway'], ['==', ['length', ['get', 'type']], 7]]
    },
    {
        id: 'property-property',
        color: '#8b6b00',
        offset: 30,
        filter: ['==', ['get', 'class'], ['get', 'type']]
    },
    {
        id: 'let-var',
        color: '#d100a7',
        offset: 40,
        filter: ['let', 'kind', ['get', 'class'], ['==', ['var', 'kind'], 'main']]
    },
    {
        id: 'step',
        color: '#6f8f00',
        offset: 50,
        filter: ['==', ['step', ['to-number', ['get', 'osm_id']], 0, 100000000, 1], 1]
    },
    {
        id: 'interpolate',
        color: '#ff4f81',
        offset: 60,
        filter: ['>', ['interpolate', ['linear'], ['to-number', ['get', 'osm_id']], 0, 0, 100000000, 100], 50]
    },
    {
        id: 'typeof-number',
        color: '#3a7d44',
        offset: 70,
        filter: ['all', ['==', ['typeof', ['get', 'oneway']], 'number'], ['==', ['number', ['get', 'oneway'], 0], 1]]
    },
    {
        id: 'string-slice-case',
        color: '#7a4b00',
        offset: 80,
        filter: ['==', ['slice', ['upcase', ['get', 'type']], 0, 4], 'FOOT']
    },
    {
        id: 'index-downcase',
        color: '#007f9f',
        offset: 90,
        filter: ['>=', ['index-of', 'way', ['downcase', ['get', 'type']]], 0]
    },
    {
        id: 'scalar-case',
        color: '#3346a8',
        offset: 100,
        filter: ['==', ['case', ['in', 'way', ['downcase', ['get', 'type']]], 'way', ['==', ['get', 'class'], 'path'], 'path', 'other'], 'way']
    },
    {
        id: 'scalar-match',
        color: '#d04b2f',
        offset: 110,
        filter: ['==', ['match', ['get', 'type'], ['footway', 'cycleway'], 'active', 'other'], 'active']
    },
    {
        id: 'dynamic-in',
        color: '#00724f',
        offset: 120,
        filter: ['case', ['in', ['literal', 'way'], ['downcase', ['get', 'type']]], true, false]
    }
];

const complexLineCases = [
    {
        id: 'complex-logic-match-case',
        color: '#7f00ff',
        offset: 0,
        filter: ['let', 'is_path', ['==', ['get', 'class'], 'path'], ['case', ['var', 'is_path'], ['match', ['get', 'type'], ['footway', 'cycleway'], true, false], false]]
    }
];

function source(encoding) {
    if (encoding === 'mlt') {
        return {
            type: 'vector',
            maxzoom: 14,
            tiles: ['local://tiles/mlt/gl-js/{z}-{x}-{y}.mlt'],
            encoding: 'mlt'
        };
    }
    return {
        type: 'vector',
        maxzoom: 14,
        tiles: ['local://tiles/{z}-{x}-{y}.mvt']
    };
}

function lineFilter(filter) {
    return ['all', ['==', ['geometry-type'], 'LineString'], filter];
}

function lineLayer(testCase) {
    return {
        id: `road-${testCase.id}`,
        type: 'line',
        source: 'maplibre',
        'source-layer': 'road',
        filter: lineFilter(testCase.filter),
        paint: {
            'line-width': 4,
            'line-offset': testCase.offset,
            'line-color': testCase.color,
            'line-opacity': 0.95
        }
    };
}

function style(encoding, cases = lineCases) {
    return {
        version: 8,
        metadata: {
            test: {
                height: 256
            }
        },
        center: [13.418056, 52.499167],
        zoom: 14,
        sources: {
            maplibre: source(encoding)
        },
        layers: [
            {
                id: 'background',
                type: 'background',
                paint: {
                    'background-color': '#f8f7ef'
                }
            },
            {
                id: 'road-context',
                type: 'line',
                source: 'maplibre',
                'source-layer': 'road',
                filter: ['==', ['geometry-type'], 'LineString'],
                paint: {
                    'line-width': 1,
                    'line-color': '#b9c1c7',
                    'line-opacity': 0.55
                }
            },
            ...cases.map(lineLayer)
        ]
    };
}

function writeStyle(name, encoding, cases) {
    const directory = path.join(__dirname, name);
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'style.json'), `${JSON.stringify(style(encoding, cases), null, 4)}\n`);
}

writeStyle('mvt-line-filter-matrix', 'mvt');
writeStyle('mlt-line-filter-matrix', 'mlt');
writeStyle('mvt-line-filter-complex-expressions', 'mvt', complexLineCases);
writeStyle('mlt-line-filter-complex-expressions', 'mlt', complexLineCases);
