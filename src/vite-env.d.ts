/// <reference types="vite/client" />

declare module '*.glsl?raw' {
  const s: string;
  export default s;
}
