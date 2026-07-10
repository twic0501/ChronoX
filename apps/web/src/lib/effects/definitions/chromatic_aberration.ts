import type { EffectDefinition } from "@/lib/effects/types";
import chromaticAberrationFragmentShader from "./chromatic_aberration.frag.glsl";

export const chromaticAberrationEffectDefinition: EffectDefinition = {
	type: "chromatic_aberration",
	name: "Chromatic Aberration",
	keywords: ["chromatic", "aberration", "fringe", "rgb", "split", "lens"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 0.4,
			min: 0,
			max: 1,
			step: 0.01,
			displayMultiplier: 100,
		},
		{
			key: "radial",
			label: "Radial (lens)",
			type: "boolean",
			default: true,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: chromaticAberrationFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_amount:
						typeof effectParams.amount === "number" ? effectParams.amount : 0.4,
					u_radial: effectParams.radial === false ? 0 : 1,
				}),
			},
		],
	},
};
