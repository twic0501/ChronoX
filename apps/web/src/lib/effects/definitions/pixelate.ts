import type { EffectDefinition } from "@/lib/effects/types";
import pixelateFragmentShader from "./pixelate.frag.glsl";

export const pixelateEffectDefinition: EffectDefinition = {
	type: "pixelate",
	name: "Pixelate",
	keywords: ["pixelate", "mosaic", "censor", "8bit", "retro", "blocky"],
	params: [
		{
			key: "size",
			label: "Block size",
			type: "number",
			default: 16,
			min: 2,
			max: 200,
			step: 1,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: pixelateFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_size:
						typeof effectParams.size === "number" ? effectParams.size : 16,
				}),
			},
		],
	},
};
