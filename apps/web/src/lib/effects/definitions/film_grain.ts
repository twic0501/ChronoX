import type { EffectDefinition } from "@/lib/effects/types";
import filmGrainFragmentShader from "./film_grain.frag.glsl";

export const filmGrainEffectDefinition: EffectDefinition = {
	type: "film_grain",
	name: "Film Grain",
	keywords: ["grain", "film", "noise", "analog", "texture", "35mm"],
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 0.25,
			min: 0,
			max: 1,
			step: 0.01,
			displayMultiplier: 100,
		},
		{
			key: "size",
			label: "Grain size",
			type: "number",
			default: 2,
			min: 1,
			max: 8,
			step: 0.5,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: filmGrainFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_intensity:
						typeof effectParams.intensity === "number"
							? effectParams.intensity
							: 0.25,
					u_size: typeof effectParams.size === "number" ? effectParams.size : 2,
					u_time:
						typeof (effectParams as { localTime?: unknown }).localTime ===
						"number"
							? ((effectParams as { localTime: number }).localTime as number)
							: 0,
				}),
			},
		],
	},
};
