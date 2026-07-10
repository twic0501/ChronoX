import type { EffectDefinition } from "@/lib/effects/types";
import grayscaleFragmentShader from "./grayscale.frag.glsl";

export const grayscaleEffectDefinition: EffectDefinition = {
	type: "grayscale",
	name: "Grayscale",
	keywords: ["grayscale", "black", "white", "mono", "desaturate"],
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 100,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: grayscaleFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_intensity: typeof effectParams.intensity === "number" ? effectParams.intensity : 100,
				}),
			},
		],
	},
};
