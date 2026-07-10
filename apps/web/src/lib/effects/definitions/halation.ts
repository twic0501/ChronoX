import type { EffectDefinition } from "@/lib/effects/types";
import halationFragmentShader from "./halation.frag.glsl";

export const halationEffectDefinition: EffectDefinition = {
	type: "halation",
	name: "Film Halation",
	keywords: ["analog", "glow", "film", "halation", "bloom", "highlights"],
	params: [
		{ key: "radius", label: "Glow Radius", type: "number", default: 8.0, min: 0.0, max: 20.0, step: 0.1 },
		{ key: "intensity", label: "Intensity", type: "number", default: 0.7, min: 0.0, max: 2.0, step: 0.05 },
		{ key: "threshold", label: "Highlight Threshold", type: "number", default: 0.65, min: 0.0, max: 1.0, step: 0.05 },
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: halationFragmentShader,
				uniforms: ({ effectParams, width, height }) => {
					const radius = typeof effectParams.radius === "number" ? effectParams.radius : 8.0;
					const intensity = typeof effectParams.intensity === "number" ? effectParams.intensity : 0.7;
					const threshold = typeof effectParams.threshold === "number" ? effectParams.threshold : 0.65;
					return {
						u_resolution: [width, height],
						u_radius: radius,
						u_intensity: intensity,
						u_threshold: threshold,
					};
				},
			},
		],
	},
};
