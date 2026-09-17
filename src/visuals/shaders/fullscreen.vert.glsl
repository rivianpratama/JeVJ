// The only vertex shader in the app: a screen-filling quad, uv straight
// through. Every scene and every pass draws exactly this.

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
