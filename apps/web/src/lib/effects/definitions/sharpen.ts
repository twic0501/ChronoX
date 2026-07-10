import type { EffectDefinition } from "@/lib/effects/types";
import sharpenFragmentShader from "./sharpen.frag.glsl";

export const sharpenEffectDefinition: EffectDefinition = {
	type: "sharpen",
	name: "Sharpen",
	keywords: ["sharpen", "sharpness", "detail", "crisp", "unsharp", "clarity"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 1,
			min: 0,
			max: 4,
			step: 0.05,
			displayMultiplier: 25,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: sharpenFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_amount:
						typeof effectParams.amount === "number" ? effectParams.amount : 1,
				}),
			},
		],
	},
};
