import type { CanvasRenderer } from "../canvas-renderer";
import { createOffscreenCanvas } from "../canvas-utils";
import { BaseNode } from "./base-node";
import type { TextElement } from "@/lib/timeline";
import {
	CORNER_RADIUS_MAX,
	CORNER_RADIUS_MIN,
} from "@/constants/text-constants";
import {
	getMetricAscent,
	getMetricDescent,
	getTextBackgroundRect,
	setCanvasLetterSpacing,
} from "@/lib/text/layout";
import { measureTextElement } from "@/lib/text/measure-element";
import {
	getElementLocalTime,
	resolveColorAtTime,
	resolveOpacityAtTime,
	resolveTransformAtTime,
} from "@/lib/animation";
import { resolveEffectParamsAtTime } from "@/lib/animation/effect-param-channel";
import { effectsRegistry, resolveEffectPasses } from "@/lib/effects";
import { webglEffectRenderer } from "../webgl/webgl-effect-renderer";
import { getWebGLContext, readResult } from "../webgl/webgl-context";
import { compileProgram, createTexture, drawFullscreenQuad } from "../webgl/webgl-utils";
import { computeSignedDistanceField } from "../webgl/jfa";
import sdfTextShaderSource from "../webgl/sdf_text.frag.glsl";
import { clamp } from "@/utils/math";

const TEXT_DECORATION_THICKNESS_RATIO = 0.07;
const STRIKETHROUGH_VERTICAL_RATIO = 0.35;

function drawTextDecoration({
	ctx,
	textDecoration,
	lineWidth,
	lineY,
	metrics,
	scaledFontSize,
	textAlign,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	textDecoration: string;
	lineWidth: number;
	lineY: number;
	metrics: TextMetrics;
	scaledFontSize: number;
	textAlign: CanvasTextAlign;
}): void {
	if (textDecoration === "none" || !textDecoration) return;

	const thickness = Math.max(
		1,
		scaledFontSize * TEXT_DECORATION_THICKNESS_RATIO,
	);
	const ascent = getMetricAscent({ metrics, fallbackFontSize: scaledFontSize });
	const descent = getMetricDescent({
		metrics,
		fallbackFontSize: scaledFontSize,
	});

	let xStart = -lineWidth / 2;
	if (textAlign === "left") xStart = 0;
	if (textAlign === "right") xStart = -lineWidth;

	if (textDecoration === "underline") {
		const underlineY = lineY + descent + thickness;
		ctx.fillRect(xStart, underlineY, lineWidth, thickness);
	}

	if (textDecoration === "line-through") {
		const strikeY = lineY - (ascent - descent) * STRIKETHROUGH_VERTICAL_RATIO;
		ctx.fillRect(xStart, strikeY, lineWidth, thickness);
	}
}

export type TextNodeParams = TextElement & {
	canvasCenter: { x: number; y: number };
	canvasHeight: number;
	textBaseline?: CanvasTextBaseline;
};

const SDF_TEXTURE_SIZE = 512;
const SDF_CACHE_MAX_ENTRIES = 12;

interface SDFCacheEntry {
	inside: WebGLTexture;
	outside: WebGLTexture;
	cleanup: () => void;
}

// Keyed by glyph-content hash and shared across TextNode instances: the
// preview rebuilds the scene (fresh nodes) on every timeline edit, so a
// per-instance cache would leak GPU textures on each rebuild.
const sdfTextureCache = new Map<string, SDFCacheEntry>();

function getCachedSDF(key: string): SDFCacheEntry | undefined {
	const entry = sdfTextureCache.get(key);
	if (entry) {
		// refresh LRU position
		sdfTextureCache.delete(key);
		sdfTextureCache.set(key, entry);
	}
	return entry;
}

function putCachedSDF(key: string, entry: SDFCacheEntry): void {
	sdfTextureCache.set(key, entry);
	while (sdfTextureCache.size > SDF_CACHE_MAX_ENTRIES) {
		const oldestKey = sdfTextureCache.keys().next().value as string;
		sdfTextureCache.get(oldestKey)?.cleanup();
		sdfTextureCache.delete(oldestKey);
	}
}

function parseColorToVec4(colorStr: string): number[] {
	if (colorStr.startsWith("rgba")) {
		const parts = colorStr.match(/[\d.]+/g);
		if (parts && parts.length >= 4) {
			return [
				parseFloat(parts[0]) / 255,
				parseFloat(parts[1]) / 255,
				parseFloat(parts[2]) / 255,
				parseFloat(parts[3]),
			];
		}
	}
	if (colorStr.startsWith("rgb")) {
		const parts = colorStr.match(/\d+/g);
		if (parts && parts.length >= 3) {
			return [
				parseFloat(parts[0]) / 255,
				parseFloat(parts[1]) / 255,
				parseFloat(parts[2]) / 255,
				1.0,
			];
		}
	}
	if (colorStr.startsWith("#")) {
		const hex = colorStr.substring(1);
		if (hex.length === 3) {
			return [
				parseInt(hex[0] + hex[0], 16) / 255,
				parseInt(hex[1] + hex[1], 16) / 255,
				parseInt(hex[2] + hex[2], 16) / 255,
				1.0,
			];
		}
		if (hex.length === 6 || hex.length === 8) {
			return [
				parseInt(hex.substring(0, 2), 16) / 255,
				parseInt(hex.substring(2, 4), 16) / 255,
				parseInt(hex.substring(4, 6), 16) / 255,
				hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1.0,
			];
		}
	}
	return [1.0, 1.0, 1.0, 1.0];
}

export class TextNode extends BaseNode<TextNodeParams> {
	isInRange({ time }: { time: number }) {
		return (
			time >= this.params.startTime &&
			time < this.params.startTime + this.params.duration
		);
	}

	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		if (!this.isInRange({ time })) {
			return;
		}

		const localTime = getElementLocalTime({
			timelineTime: time,
			elementStartTime: this.params.startTime,
			elementDuration: this.params.duration,
		});
		const transform = resolveTransformAtTime({
			baseTransform: this.params.transform,
			animations: this.params.animations,
			localTime,
		});
		const opacity = resolveOpacityAtTime({
			baseOpacity: this.params.opacity,
			animations: this.params.animations,
			localTime,
		});

		const x = transform.position.x + this.params.canvasCenter.x;
		const y = transform.position.y + this.params.canvasCenter.y;

		const baseline = this.params.textBaseline ?? "middle";
		const blendMode = (
			this.params.blendMode && this.params.blendMode !== "normal"
				? this.params.blendMode
				: "source-over"
		) as GlobalCompositeOperation;

		const {
			scaledFontSize,
			fontString,
			letterSpacing,
			lineHeightPx,
			lines,
			lineMetrics,
			block,
			fontSizeRatio,
			resolvedBackground,
		} = measureTextElement({
			element: this.params,
			canvasHeight: this.params.canvasHeight,
			localTime,
			ctx: renderer.context,
		});

		const lineCount = lines.length;

		const textColor = resolveColorAtTime({
			baseColor: this.params.color,
			animations: this.params.animations,
			propertyPath: "color",
			localTime,
		});
		const resolvedBackgroundWithColor = {
			...resolvedBackground,
			color: resolveColorAtTime({
				baseColor: this.params.background.color,
				animations: this.params.animations,
				propertyPath: "background.color",
				localTime,
			}),
		};

		const drawContent = (
			ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		) => {
			ctx.font = fontString;
			ctx.textAlign = this.params.textAlign;
			ctx.textBaseline = baseline;
			ctx.fillStyle = textColor;
			setCanvasLetterSpacing({ ctx, letterSpacingPx: letterSpacing });

			if (
				this.params.background.enabled &&
				this.params.background.color &&
				this.params.background.color !== "transparent" &&
				lineCount > 0
			) {
				const backgroundRect = getTextBackgroundRect({
					textAlign: this.params.textAlign,
					block,
					background: resolvedBackgroundWithColor,
					fontSizeRatio,
				});
				if (backgroundRect) {
					const p =
						clamp({
							value: resolvedBackgroundWithColor.cornerRadius,
							min: CORNER_RADIUS_MIN,
							max: CORNER_RADIUS_MAX,
						}) / 100;
					const radius =
						(Math.min(backgroundRect.width, backgroundRect.height) / 2) * p;
					ctx.fillStyle = resolvedBackgroundWithColor.color;
					ctx.beginPath();
					ctx.roundRect(
						backgroundRect.left,
						backgroundRect.top,
						backgroundRect.width,
						backgroundRect.height,
						radius,
					);
					ctx.fill();
					ctx.fillStyle = textColor;
				}
			}

			for (let i = 0; i < lineCount; i++) {
				const lineY = i * lineHeightPx - block.visualCenterOffset;
				ctx.fillText(lines[i], 0, lineY);
				drawTextDecoration({
					ctx,
					textDecoration: this.params.textDecoration ?? "none",
					lineWidth: lineMetrics[i].width,
					lineY,
					metrics: lineMetrics[i],
					scaledFontSize,
					textAlign: this.params.textAlign,
				});
			}
		};

		const applyTransform = (
			ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		) => {
			ctx.translate(x, y);
			ctx.scale(transform.scaleX, transform.scaleY);
			if (transform.rotate) {
				ctx.rotate((transform.rotate * Math.PI) / 180);
			}
		};

		const enabledEffects =
			this.params.effects?.filter((effect) => effect.enabled) ?? [];

		const renderPlain2D = () => {
			renderer.context.save();
			applyTransform(renderer.context);
			renderer.context.globalCompositeOperation = blendMode;
			renderer.context.globalAlpha = opacity;
			drawContent(renderer.context);
			renderer.context.restore();
		};

		// SDF path: razor-sharp glyph edges under heavy zoom. Only correct for
		// plain single-color text — a background rect or decoration would be
		// binarized into the glyph mask, and effects need the 2D pipeline.
		const upscale = Math.max(
			Math.abs(transform.scaleX),
			Math.abs(transform.scaleY),
		);
		const wantsSDF =
			enabledEffects.length === 0 &&
			upscale > 1.05 &&
			lineCount > 0 &&
			!this.params.background.enabled &&
			(this.params.textDecoration ?? "none") === "none";

		if (wantsSDF) {
			try {
				const rendered = this.renderSDF({
					renderer,
					textColor,
					letterSpacing,
					lineHeightPx,
					drawContent,
					applyTransform,
					blendMode,
					opacity,
				});
				if (rendered) return;
			} catch (error) {
				console.warn("SDF text render failed; falling back to 2D:", error);
			}
		}

		if (enabledEffects.length === 0) {
			renderPlain2D();
			return;
		}

		// Effects path: render text to a same-size offscreen canvas so the blur
		// can spread into the surrounding transparent area without hard clipping.
		const offscreen = createOffscreenCanvas({
			width: renderer.width,
			height: renderer.height,
		});
		const offscreenCtx = offscreen.getContext(
			"2d",
		) as OffscreenCanvasRenderingContext2D | null;

		if (!offscreenCtx) {
			renderPlain2D();
			return;
		}

		offscreenCtx.save();
		applyTransform(offscreenCtx);
		drawContent(offscreenCtx);
		offscreenCtx.restore();

		let currentSource: CanvasImageSource = offscreen;
		for (const effect of enabledEffects) {
			const resolvedParams = resolveEffectParamsAtTime({
				effect,
				animations: this.params.animations,
				localTime,
			});
			(resolvedParams as any).localTime = localTime;
			const definition = effectsRegistry.get(effect.type);
			const { context: fxGl } = getWebGLContext({
				width: renderer.width,
				height: renderer.height,
			});
			const passes = resolveEffectPasses({
				definition,
				effectParams: resolvedParams,
				width: renderer.width,
				height: renderer.height,
				gl: fxGl,
			});
			currentSource = webglEffectRenderer.applyEffect({
				source: currentSource,
				width: renderer.width,
				height: renderer.height,
				passes,
			});
		}

		renderer.context.save();
		renderer.context.globalCompositeOperation = blendMode;
		renderer.context.globalAlpha = opacity;
		renderer.context.drawImage(currentSource, 0, 0);
		renderer.context.restore();
	}

	// Returns false when the environment can't run the SDF pipeline (no WebGL2).
	private renderSDF({
		renderer,
		textColor,
		letterSpacing,
		lineHeightPx,
		drawContent,
		applyTransform,
		blendMode,
		opacity,
	}: {
		renderer: CanvasRenderer;
		textColor: string;
		letterSpacing: number;
		lineHeightPx: number;
		drawContent: (
			ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		) => void;
		applyTransform: (
			ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		) => void;
		blendMode: GlobalCompositeOperation;
		opacity: number;
	}): boolean {
		const { context: gl, programCache } = getWebGLContext({
			width: renderer.width,
			height: renderer.height,
		});
		// #version 300 es + fwidth need a real WebGL2 context
		if (
			typeof WebGL2RenderingContext === "undefined" ||
			!(gl instanceof WebGL2RenderingContext)
		) {
			return false;
		}

		const sdfSize = SDF_TEXTURE_SIZE;
		const sdfScale = sdfSize / Math.max(renderer.width, renderer.height);

		// Color is applied via uniform, so it does not participate in the mask key
		const cacheKey = [
			this.params.content,
			this.params.fontSize,
			this.params.fontFamily,
			this.params.fontWeight,
			this.params.fontStyle,
			this.params.textAlign,
			letterSpacing,
			lineHeightPx,
			renderer.width,
			renderer.height,
		].join("|");

		let entry = getCachedSDF(cacheKey);
		if (!entry) {
			const glyphCanvas = createOffscreenCanvas({
				width: sdfSize,
				height: sdfSize,
			});
			const glyphCtx = glyphCanvas.getContext(
				"2d",
			) as OffscreenCanvasRenderingContext2D | null;
			if (!glyphCtx) return false;

			glyphCtx.clearRect(0, 0, sdfSize, sdfSize);
			glyphCtx.save();
			glyphCtx.translate(sdfSize / 2, sdfSize / 2);
			glyphCtx.scale(sdfScale, sdfScale);
			drawContent(glyphCtx);
			glyphCtx.restore();

			// Binarize to a white mask: jfa-init seeds on the red channel, which
			// would be empty for dark text colors.
			glyphCtx.save();
			glyphCtx.globalCompositeOperation = "source-in";
			glyphCtx.fillStyle = "#ffffff";
			glyphCtx.fillRect(0, 0, sdfSize, sdfSize);
			glyphCtx.restore();

			const glyphTexture = createTexture({ context: gl, source: glyphCanvas });
			const sdf = computeSignedDistanceField({
				context: gl,
				programCache,
				sourceTexture: glyphTexture,
				width: sdfSize,
				height: sdfSize,
			});
			gl.deleteTexture(glyphTexture);

			entry = {
				inside: sdf.insideTexture,
				outside: sdf.outsideTexture,
				cleanup: sdf.cleanup,
			};
			putCachedSDF(cacheKey, entry);
		}

		const program = compileProgram({
			context: gl,
			fragmentShaderSource: sdfTextShaderSource,
			programCache,
		});
		gl.useProgram(program);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, entry.inside);
		const uInsideLoc = gl.getUniformLocation(program, "u_jfa_inside");
		if (uInsideLoc) gl.uniform1i(uInsideLoc, 0);

		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, entry.outside);
		const uOutsideLoc = gl.getUniformLocation(program, "u_jfa_outside");
		if (uOutsideLoc) gl.uniform1i(uOutsideLoc, 1);

		const uSdfResLoc = gl.getUniformLocation(program, "u_sdf_resolution");
		if (uSdfResLoc) gl.uniform2f(uSdfResLoc, sdfSize, sdfSize);

		const uTextColorLoc = gl.getUniformLocation(program, "u_textColor");
		if (uTextColorLoc) {
			gl.uniform4fv(
				uTextColorLoc,
				new Float32Array(parseColorToVec4(textColor)),
			);
		}

		const strokeColor = (this.params as any).strokeColor || "#000000";
		const uOutlineColorLoc = gl.getUniformLocation(program, "u_outlineColor");
		if (uOutlineColorLoc) {
			gl.uniform4fv(
				uOutlineColorLoc,
				new Float32Array(parseColorToVec4(strokeColor)),
			);
		}

		const strokeWidth =
			typeof (this.params as any).strokeWidth === "number"
				? (this.params as any).strokeWidth
				: 0;
		const uOutlineWidthLoc = gl.getUniformLocation(program, "u_outlineWidth");
		// stroke width is authored in canvas px; convert to SDF-texture px
		if (uOutlineWidthLoc) gl.uniform1f(uOutlineWidthLoc, strokeWidth * sdfScale);

		drawFullscreenQuad({
			context: gl,
			program,
			width: renderer.width,
			height: renderer.height,
		});

		gl.bindTexture(gl.TEXTURE_2D, null);
		const output = readResult({ width: renderer.width, height: renderer.height });

		renderer.context.save();
		renderer.context.globalCompositeOperation = blendMode;
		renderer.context.globalAlpha = opacity;
		applyTransform(renderer.context);
		// The SDF square covers max(w, h) canvas px around the text origin
		const drawSize = sdfSize / sdfScale;
		renderer.context.drawImage(
			output,
			-drawSize / 2,
			-drawSize / 2,
			drawSize,
			drawSize,
		);
		renderer.context.restore();
		return true;
	}
}
