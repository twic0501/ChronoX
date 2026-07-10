import type { EffectDefinition } from "@/lib/effects/types";
import invertFragmentShader from "./invert.frag.glsl";

export const invertEffectDefinition: EffectDefinition = {
	type: "invert",
	name: "Invert",
	keywords: ["invert", "negative", "reverse", "negate"],
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
				fragmentShader: invertFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_intensity: typeof effectParams.intensity === "number" ? effectParams.intensity : 100,
				}),
			},
		],
	},
};
