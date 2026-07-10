import type { EffectDefinition } from "@/lib/effects/types";
import posterizeFragmentShader from "./posterize.frag.glsl";

export const posterizeEffectDefinition: EffectDefinition = {
	type: "posterize",
	name: "Posterize",
	keywords: ["posterize", "levels", "banding", "poster", "pop", "art"],
	params: [
		{
			key: "levels",
			label: "Levels",
			type: "number",
			default: 6,
			min: 2,
			max: 24,
			step: 1,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: posterizeFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_levels:
						typeof effectParams.levels === "number" ? effectParams.levels : 6,
				}),
			},
		],
	},
};
