import { createOffscreenCanvas } from "../canvas-utils";

let gl: WebGLRenderingContext | null = null;
let webglCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
const programCache = new Map<string, WebGLProgram>();

export function getWebGLContext({
	width,
	height,
}: {
	width: number;
	height: number;
}): {
	context: WebGLRenderingContext;
	programCache: Map<string, WebGLProgram>;
} {
	// A NaN/negative size (bad upstream transform) would throw on canvas
	// resize and kill the render loop — clamp to a sane integer instead.
	width = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
	height = Number.isFinite(height) ? Math.max(1, Math.round(height)) : 1;

	// A lost context (GPU memory pressure, driver reset) never recovers by
	// itself — rebuild the canvas + context and drop the now-invalid programs
	// so playback resumes instead of freezing forever.
	if (gl?.isContextLost()) {
		console.warn("[webgl] context lost — rebuilding");
		gl = null;
		webglCanvas = null;
		programCache.clear();
	}
	if (!webglCanvas) {
		webglCanvas = createOffscreenCanvas({ width, height });
		gl = (webglCanvas.getContext("webgl2", {
			premultipliedAlpha: false,
		}) || webglCanvas.getContext("webgl", {
			premultipliedAlpha: false,
		})) as WebGLRenderingContext | null;
		if (!gl) throw new Error("WebGL/WebGL2 not supported");
	}
	if (webglCanvas.width !== width || webglCanvas.height !== height) {
		webglCanvas.width = width;
		webglCanvas.height = height;
	}
	if (!gl) throw new Error("WebGL context lost");
	return { context: gl, programCache };
}

let cachedOutputCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

export function readResult({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas | HTMLCanvasElement {
	if (!webglCanvas) throw new Error("WebGL canvas not initialized");
	
	if (!cachedOutputCanvas) {
		cachedOutputCanvas = createOffscreenCanvas({ width, height });
	} else if (cachedOutputCanvas.width !== width || cachedOutputCanvas.height !== height) {
		cachedOutputCanvas.width = width;
		cachedOutputCanvas.height = height;
	}

	const outputCtx = cachedOutputCanvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (outputCtx) {
		outputCtx.clearRect(0, 0, width, height);
		outputCtx.drawImage(webglCanvas, 0, 0, width, height);
	}
	return cachedOutputCanvas;
}
