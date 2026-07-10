import type { EffectDefinition } from "@/lib/effects/types";
import vignetteFragmentShader from "./vignette.frag.glsl";

export const vignetteEffectDefinition: EffectDefinition = {
	type: "vignette",
	name: "Vignette",
	keywords: ["vignette", "dark", "corner", "cinematic", "film"],
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "radius",
			label: "Radius",
			type: "number",
			default: 0.75,
			min: 0.1,
			max: 1.5,
			step: 0.01,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: vignetteFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_intensity: typeof effectParams.intensity === "number" ? effectParams.intensity : 50,
					u_radius: typeof effectParams.radius === "number" ? effectParams.radius : 0.75,
				}),
			},
		],
	},
};
