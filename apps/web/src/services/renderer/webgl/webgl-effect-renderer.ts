import { getWebGLContext, readResult } from "./webgl-context";
import { applyMultiPassEffect } from "./webgl-utils";
import type { EffectPassData } from "./webgl-utils";

export interface ApplyEffectParams {
	source: CanvasImageSource;
	width: number;
	height: number;
	passes: EffectPassData[];
}

function applyEffect({
	source,
	width,
	height,
	passes,
}: ApplyEffectParams): CanvasImageSource {
	if (passes.length === 0) {
		return source;
	}
	const { context, programCache } = getWebGLContext({ width, height });

	// GLSL ES 3.0 shaders (and 3D LUT textures) need WebGL2. On a WebGL1
	// fallback context, skip those passes instead of crashing the render.
	const isWebGL2 =
		typeof WebGL2RenderingContext !== "undefined" &&
		context instanceof WebGL2RenderingContext;
	const runnablePasses = isWebGL2
		? passes
		: passes.filter(
				(pass) => !pass.fragmentShader.trim().startsWith("#version 300 es"),
			);
	if (runnablePasses.length === 0) {
		return source;
	}

	try {
		applyMultiPassEffect({
			context,
			source,
			width,
			height,
			passes: runnablePasses,
			programCache,
		});
	} catch (error) {
		// A broken shader must not take down the whole render loop —
		// skip the effect and keep the frame.
		console.warn("Effect pass failed; rendering without it:", error);
		return source;
	}
	return readResult({ width, height });
}

export const webglEffectRenderer = {
	applyEffect,
};
