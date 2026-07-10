import type { EffectDefinition } from "@/lib/effects/types";
import glitchFragmentShader from "./glitch.frag.glsl";

export const glitchEffectDefinition: EffectDefinition = {
	type: "glitch",
	name: "Digital Glitch",
	keywords: ["glitch", "digital", "chromatic", "aberration", "distortion", "noise"],
	params: [
		{ key: "intensity", label: "Intensity", type: "number", default: 0.5, min: 0.0, max: 1.0, step: 0.05 },
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: glitchFragmentShader,
				uniforms: ({ effectParams }) => {
					const intensity = typeof effectParams.intensity === "number" ? effectParams.intensity : 0.5;
					const time = typeof (effectParams as any).localTime === "number" ? (effectParams as any).localTime : 0.0;
					return {
						u_intensity: intensity,
						u_time: time,
					};
				},
			},
		],
	},
};
