import type { ParamDefinition, ParamValues } from "@/lib/params";

export interface Effect {
	id: string;
	type: string;
	params: ParamValues;
	enabled: boolean;
}

export interface ExtraTextureBinding {
	unit: number;
	texture: WebGLTexture;
	name: string;
	is3D?: boolean;
}

export interface ResolvedEffectPass {
	fragmentShader: string;
	uniforms: Record<string, number | number[]>;
	extraBindings?: ExtraTextureBinding[];
}

export interface WebGLEffectPass {
	fragmentShader: string;
	uniforms(params: {
		effectParams: ParamValues;
		width: number;
		height: number;
	}): Record<string, number | number[]>;
	extraBindings?(params: {
		gl: WebGLRenderingContext;
		effectParams: ParamValues;
		width: number;
		height: number;
	}): ExtraTextureBinding[];
}

export interface WebGLEffectRenderer {
	type: "webgl";
	passes: WebGLEffectPass[];
	buildPasses?: (params: {
		effectParams: ParamValues;
		width: number;
		height: number;
	}) => ResolvedEffectPass[];
}

export type EffectRenderer = WebGLEffectRenderer;

export interface EffectDefinition {
	type: string;
	name: string;
	keywords: string[];
	params: ParamDefinition[];
	renderer: EffectRenderer;
}
