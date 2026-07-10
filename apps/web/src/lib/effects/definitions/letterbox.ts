import type { EffectDefinition } from "@/lib/effects/types";
import letterboxFragmentShader from "./letterbox.frag.glsl";

export const letterboxEffectDefinition: EffectDefinition = {
	type: "letterbox",
	name: "Cinematic Bars",
	keywords: ["letterbox", "bars", "cinematic", "aspect", "crop", "mask", "2.39"],
	params: [
		{ key: "aspectRatio", label: "Aspect Ratio", type: "number", default: 2.39, min: 1.0, max: 4.0, step: 0.01 },
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: letterboxFragmentShader,
				uniforms: ({ effectParams }) => {
					const aspectRatio = typeof effectParams.aspectRatio === "number" ? effectParams.aspectRatio : 2.39;
					return {
						u_aspectRatio: aspectRatio,
					};
				},
			},
		],
	},
};
