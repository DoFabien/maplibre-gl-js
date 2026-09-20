// NOTE ON EXTRUDE SCALE:
// scale the extrusion vector so that the normal length is this value.
// contains the "texture" normals (-1..1). this is distinct from the extrude
// normals for line joins, because the x-value remains 0 for the texture
// normal array, while the extrude normal actually moves the vertex to create
// the acute/bevelled line join.
export const EXTRUDE_SCALE: number = 63;

/*
 * Sharp corners cause dashed lines to tilt because the distance along the line
 * is the same at both the inner and outer corners. To improve the appearance of
 * dashed lines we add extra points near sharp corners so that a smaller part
 * of the line is tilted.
 *
 * COS_HALF_SHARP_CORNER controls how sharp a corner has to be for us to add an
 * extra vertex. The default is 75 degrees.
 *
 * The newly created vertices are placed SHARP_CORNER_OFFSET pixels from the corner.
 */
export const COS_HALF_SHARP_CORNER: number = Math.cos(75 / 2 * (Math.PI / 180));
export const SHARP_CORNER_OFFSET: number = 15;

// Angle per triangle for approximating round line joins.
export const DEG_PER_TRIANGLE: number = 20;

// The number of bits that is used to store the line distance in the buffer.
export const LINE_DISTANCE_BUFFER_BITS: number = 15;

// We don't have enough bits for the line distance as we'd like to have, so
// use this value to scale the line distance (in tile units) down to a smaller
// value. This lets us store longer distances while sacrificing precision.
export const LINE_DISTANCE_SCALE: number = 1 / 2;

// The maximum line distance, in tile units, that fits in the buffer.
export const MAX_LINE_DISTANCE: number = Math.pow(2, LINE_DISTANCE_BUFFER_BITS - 1) / LINE_DISTANCE_SCALE;
