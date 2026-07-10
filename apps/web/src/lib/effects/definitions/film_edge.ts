import type { EffectDefinition } from "@/lib/effects/types";
import filmEdgeFragmentShader from "./film_edge.frag.glsl";

export const filmEdgeEffectDefinition: EffectDefinition = {
	type: "film_edge",
	name: "Film Edge",
	keywords: ["film", "edge", "torn", "rough", "border", "grunge", "split", "mask"],
	params: [
		{
			key: "depth",
			label: "Depth",
			type: "number",
			default: 6,
			min: 0,
			max: 25,
			step: 0.5,
		},
		{
			key: "roughness",
			label: "Roughness",
			type: "number",
			default: 9,
			min: 1,
			max: 40,
			step: 1,
		},
		{
			key: "softness",
			label: "Softness",
			type: "number",
			default: 1,
			min: 0,
			max: 10,
			step: 0.1,
		},
		{
			key: "grain",
			label: "Grain",
			type: "number",
			default: 15,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "seed",
			label: "Seed",
			type: "number",
			default: 1,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: filmEdgeFragmentShader,
				uniforms: ({ effectParams }) => ({
					// UI ranges are human-friendly percents; shader wants fractions
					u_depth:
						(typeof effectParams.depth === "number" ? effectParams.depth : 6) / 100,
					u_roughness:
						typeof effectParams.roughness === "number" ? effectParams.roughness : 9,
					u_softness:
						(typeof effectParams.softness === "number" ? effectParams.softness : 1) / 100,
					u_grain:
						(typeof effectParams.grain === "number" ? effectParams.grain : 15) / 100,
					u_seed: typeof effectParams.seed === "number" ? effectParams.seed : 1,
				}),
			},
		],
	},
};
