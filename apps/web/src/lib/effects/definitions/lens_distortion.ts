import type { EffectDefinition } from "@/lib/effects/types";
import lensDistortionFragmentShader from "./lens_distortion.frag.glsl";

export const lensDistortionEffectDefinition: EffectDefinition = {
	type: "lens_distortion",
	name: "Lens Distortion",
	keywords: ["lens", "distortion", "fisheye", "barrel", "pincushion", "gopro"],
	params: [
		{
			key: "distortion",
			label: "Distortion",
			type: "number",
			default: 0.4,
			min: -1,
			max: 1,
			step: 0.01,
			displayMultiplier: 100,
		},
		{
			key: "zoom",
			label: "Zoom",
			type: "number",
			default: 1,
			min: 0.5,
			max: 2,
			step: 0.01,
			displayMultiplier: 100,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: lensDistortionFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_distortion:
						typeof effectParams.distortion === "number"
							? effectParams.distortion
							: 0.4,
					u_zoom: typeof effectParams.zoom === "number" ? effectParams.zoom : 1,
				}),
			},
		],
	},
};
