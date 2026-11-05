// The basemap: a printed chart on warm paper. OpenFreeMap's OpenMapTiles
// vector tiles, styled here so the land, sea and borders recede and the
// traffic (the only saturated colour on the page) carries the picture.

import type { StyleSpecification } from 'maplibre-gl';

export const PAPER = {
  bg: '#f2efea',
  land: '#f2efea',
  water: '#e3e0da',
  waterLine: '#d2cdc5',
  border: '#bdb5aa',
  ink: '#2a2724',
  label: '#8f8982',
  labelHalo: '#f2efea',
  road: '#e6e1d9',
  runway: '#cfc8bd',
};

const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

export function paperStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'Watchfloor paper',
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sky: {
      // The globe floats on the page: space is the paper, the atmosphere a
      // faint warm haze at the limb.
      'sky-color': PAPER.bg,
      'horizon-color': '#ebe6df',
      'fog-color': PAPER.bg,
      'sky-horizon-blend': 0.5,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.9,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.35, 5, 0.15, 7, 0],
    },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      relief: {
        type: 'raster',
        tiles: ['https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 6,
        attribution: 'Natural Earth',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': PAPER.land } },
      {
        // Shaded relief, washed out to a pencil texture.
        id: 'relief', type: 'raster', source: 'relief', maxzoom: 9,
        paint: {
          'raster-saturation': -1,
          'raster-contrast': 0.05,
          'raster-brightness-min': 0.62,
          'raster-brightness-max': 1,
          'raster-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 6, 0.35, 9, 0],
        },
      },
      {
        id: 'landcover-ice', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['in', ['get', 'subclass'], ['literal', ['glacier', 'ice_shelf']]],
        paint: { 'fill-color': '#f7f5f1', 'fill-opacity': 0.7 },
      },
      {
        id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': PAPER.water, 'fill-antialias': true },
      },
      {
        id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'line-color': PAPER.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.3, 8, 0.7] },
      },
      {
        id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 6,
        paint: { 'line-color': PAPER.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.5] },
      },
      {
        id: 'urban', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 7,
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'industrial', 'commercial']]],
        paint: { 'fill-color': '#ebe7e1', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 9, 0.8] },
      },
      {
        id: 'roads', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 7,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
        paint: {
          'line-color': PAPER.road,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 7, 0.5, 14, 4],
        },
      },
      {
        id: 'aeroway-area', type: 'fill', source: 'omt', 'source-layer': 'aeroway', minzoom: 10,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#e9e4dc' },
      },
      {
        id: 'runway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 9,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'runway']],
        paint: { 'line-color': PAPER.runway, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 9, 1, 15, 40] },
      },
      {
        id: 'taxiway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 12,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'taxiway']],
        paint: { 'line-color': '#ddd6cb', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 0.5, 15, 6] },
      },
      {
        id: 'boundary-state', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 4,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': PAPER.border, 'line-width': 0.4, 'line-dasharray': [2, 3], 'line-opacity': 0.6 },
      },
      {
        id: 'boundary-country', type: 'line', source: 'omt', 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: {
          'line-color': PAPER.border,
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 0.9],
          'line-dasharray': ['step', ['get', 'disputed'], ['literal', [1, 0]], 1, ['literal', [2, 2]]],
        },
      },
      {
        id: 'water-label', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']],
          'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 6, 12],
          'text-letter-spacing': 0.15,
          'text-max-width': 6,
        },
        paint: { 'text-color': '#a9a39b', 'text-halo-color': PAPER.water, 'text-halo-width': 1 },
      },
      {
        id: 'place-city', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 4,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']],
          'text-font': FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 13],
          'symbol-sort-key': ['get', 'rank'],
          'text-max-width': 8,
        },
        paint: { 'text-color': PAPER.label, 'text-halo-color': PAPER.labelHalo, 'text-halo-width': 1.4 },
      },
      {
        id: 'place-country', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 1.5, maxzoom: 7,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': ['upcase', ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']]],
          'text-font': FONT_BOLD,
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 8.5, 6, 12],
          'text-letter-spacing': 0.18,
          'text-max-width': 7,
          'symbol-sort-key': ['get', 'rank'],
        },
        paint: { 'text-color': '#b2aba2', 'text-halo-color': PAPER.labelHalo, 'text-halo-width': 1.2 },
      },
    ],
  };
}

export const LABEL_FONT = FONT;
export const LABEL_FONT_BOLD = FONT_BOLD;
