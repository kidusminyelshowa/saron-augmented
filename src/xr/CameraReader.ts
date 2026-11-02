/**
 * CameraReader
 *
 * Copies the WebXR camera image (raw camera access) into a small canvas so the
 * mural detector can look at it. The camera texture is only valid during the
 * XR frame, so it is drawn into an offscreen framebuffer at reduced size and
 * read back right away.
 */

import type { WebGLRenderer } from 'three';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uCamera;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(uCamera, vUv).rgb, 1.0);
}`;

export class CameraReader {
  /** Last image read, rows top-first as read (see `flipped`). */
  public readonly canvas: HTMLCanvasElement;
  public width = 0;
  public height = 0;

  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly renderer: WebGLRenderer;
  private readonly ctx2d: CanvasRenderingContext2D;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private target: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private pixels: Uint8Array = new Uint8Array(0);
  private imageData: ImageData | null = null;
  private readonly maxSize: number;

  constructor(renderer: WebGLRenderer, maxSize = 640) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.maxSize = maxSize;
    this.canvas = document.createElement('canvas');
    this.ctx2d = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  private init(): boolean {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.program = p;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    return true;
  }

  private resize(w: number, h: number): void {
    const gl = this.gl;
    if (this.target) gl.deleteTexture(this.target);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.pixels = new Uint8Array(w * h * 4);
    this.imageData = this.ctx2d.createImageData(w, h);
  }

  /**
   * Read the camera image for this frame into `canvas`.
   * @param flipY reverse the row order (the camera texture's orientation is
   *              not specified, so the caller tries both until the mural is found).
   */
  read(cameraTexture: WebGLTexture, camWidth: number, camHeight: number, flipY: boolean): boolean {
    const gl = this.gl;
    // In XR, three.js renders into the session's framebuffer via a render target;
    // keep it so it can be restored after the raw GL calls below.
    const renderTarget = this.renderer.getRenderTarget();
    try {
      if (!this.program && !this.init()) return false;
      const s = Math.min(1, this.maxSize / Math.max(camWidth, camHeight));
      const w = Math.max(1, Math.round(camWidth * s));
      const h = Math.max(1, Math.round(camHeight * s));
      if (w !== this.width || h !== this.height) this.resize(w, h);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
      gl.uniform1i(gl.getUniformLocation(this.program!, 'uCamera'), 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    } finally {
      // Hand the context back to three.js in a known state.
      this.renderer.resetState();
      this.renderer.setRenderTarget(renderTarget);
    }

    // readPixels returns rows bottom-first. Store top-first unless flipped.
    const out = this.imageData!.data;
    const row = w4(this.width);
    for (let y = 0; y < this.height; y++) {
      const srcRow = flipY ? y : this.height - 1 - y;
      out.set(this.pixels.subarray(srcRow * row, srcRow * row + row), y * row);
    }
    this.ctx2d.putImageData(this.imageData!, 0, 0);
    return true;
  }

  /** RGBA pixels of the last read image (rows top-first). */
  get data(): Uint8ClampedArray {
    return this.imageData!.data;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.target) gl.deleteTexture(this.target);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
  }
}

const w4 = (w: number) => w * 4;
