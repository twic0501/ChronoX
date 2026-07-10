import type { EffectDefinition } from "@/lib/effects/types";
import radialBlurFragmentShader from "./radial_blur.frag.glsl";

export const radialBlurEffectDefinition: EffectDefinition = {
	type: "radial_blur",
	name: "Radial Blur",
	keywords: ["radial", "zoom", "blur", "speed", "motion", "punch"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 0.3,
			min: 0,
			max: 1,
			step: 0.01,
			displayMultiplier: 100,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: radialBlurFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_amount:
						typeof effectParams.amount === "number" ? effectParams.amount : 0.3,
				}),
			},
		],
	},
};
