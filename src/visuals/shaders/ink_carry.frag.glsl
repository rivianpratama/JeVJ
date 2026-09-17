// The ink, carried from one pair of density targets to the next.
//
// The feedback loop has no source but itself: a fresh target is a black frame,
// and the field takes seconds to build back out of the ambient wash — tens of
// seconds on a page the browser has throttled to a frame or two a second. So a
// resize resamples the densities into the new buffers rather than starting
// again, and the commonest resize by far is the pixel-ratio governor stepping
// down, where the aspect has not changed at all and the resample is exact up
// to a filter tap.
//
// A straight texture read, deliberately: the densities are linear physical
// quantities, not colour, and anything that encodes or tone-maps on the way
// through would change the field it is supposed to preserve.

varying vec2 vUv;

uniform sampler2D uPrev;

void main() {
  gl_FragColor = texture2D(uPrev, vUv);
}
