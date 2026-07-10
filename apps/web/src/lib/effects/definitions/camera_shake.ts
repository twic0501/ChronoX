import type { EffectDefinition } from "@/lib/effects/types";
import cameraShakeFragmentShader from "./camera_shake.frag.glsl";

export const cameraShakeEffectDefinition: EffectDefinition = {
	type: "camera-shake",
	name: "Camera Shake",
	keywords: ["shake", "handheld", "motion", "jitter", "camera"],
	params: [
		{ key: "amplitude", label: "Amplitude", type: "number", default: 0.015, min: 0.0, max: 0.1, step: 0.001 },
		{ key: "frequency", label: "Frequency", type: "number", default: 12.0, min: 0.0, max: 30.0, step: 0.5 },
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: cameraShakeFragmentShader,
				uniforms: ({ effectParams }) => {
					const amplitude = typeof effectParams.amplitude === "number" ? effectParams.amplitude : 0.015;
					const frequency = typeof effectParams.frequency === "number" ? effectParams.frequency : 12.0;
					const time = typeof (effectParams as any).localTime === "number" ? (effectParams as any).localTime : 0.0;
					return {
						u_amplitude: amplitude,
						u_frequency: frequency,
						u_time: time,
					};
				},
			},
		],
	},
};
