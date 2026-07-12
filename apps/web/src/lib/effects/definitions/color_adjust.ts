import type { EffectDefinition } from "@/lib/effects/types";
import colorAdjustFragmentShader from "./color_adjust.frag.glsl";

export const colorAdjustEffectDefinition: EffectDefinition = {
	type: "color-adjust",
	name: "Color Adjust",
	keywords: ["color", "brightness", "contrast", "saturation", "adjust", "grade", "wheels", "exposure", "temp"],
	params: [
		{ key: "brightness", label: "Brightness", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		{ key: "contrast", label: "Contrast", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		{ key: "saturation", label: "Saturation", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		{ key: "exposure", label: "Exposure", type: "number", default: 0, min: -2, max: 2, step: 0.01 },
		{ key: "temperature", label: "Temperature", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		{ key: "tint", label: "Tint", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		{ key: "highlights", label: "Highlights", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		{ key: "shadows", label: "Shadows", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		
		// Lift (Red, Green, Blue)
		{ key: "lift_r", label: "Lift Red", type: "number", default: 0, min: -0.5, max: 0.5, step: 0.005 },
		{ key: "lift_g", label: "Lift Green", type: "number", default: 0, min: -0.5, max: 0.5, step: 0.005 },
		{ key: "lift_b", label: "Lift Blue", type: "number", default: 0, min: -0.5, max: 0.5, step: 0.005 },

		// Gamma (Red, Green, Blue)
		{ key: "gamma_r", label: "Gamma Red", type: "number", default: 1, min: 0.1, max: 2.0, step: 0.01 },
		{ key: "gamma_g", label: "Gamma Green", type: "number", default: 1, min: 0.1, max: 2.0, step: 0.01 },
		{ key: "gamma_b", label: "Gamma Blue", type: "number", default: 1, min: 0.1, max: 2.0, step: 0.01 },

		// Gain (Red, Green, Blue)
		{ key: "gain_r", label: "Gain Red", type: "number", default: 1, min: 0, max: 2.0, step: 0.01 },
		{ key: "gain_g", label: "Gain Green", type: "number", default: 1, min: 0, max: 2.0, step: 0.01 },
		{ key: "gain_b", label: "Gain Blue", type: "number", default: 1, min: 0, max: 2.0, step: 0.01 },
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: colorAdjustFragmentShader,
				uniforms: ({ effectParams }) => {
					const getNum = (key: string, def: number) => {
						const val = effectParams[key];
						return typeof val === "number" ? val : def;
					};
					return {
						u_brightness: getNum("brightness", 0),
						u_contrast: getNum("contrast", 0),
						u_saturation: getNum("saturation", 0),
						u_exposure: getNum("exposure", 0),
						// `warmth` is an alias the AI agent (adjust_color) and
						// style-mimic pipeline emit; the shader only knows
						// `temperature`. Fall back to warmth so per-scene
						// warm/cool grading from the AI actually renders instead
						// of silently no-op-ing (all scenes looked identical).
						u_temperature: getNum("temperature", getNum("warmth", 0)),
						u_tint: getNum("tint", 0),
						u_highlights: getNum("highlights", 0),
						u_shadows: getNum("shadows", 0),
						u_lift: [getNum("lift_r", 0), getNum("lift_g", 0), getNum("lift_b", 0)],
						u_gamma: [getNum("gamma_r", 1), getNum("gamma_g", 1), getNum("gamma_b", 1)],
						u_gain: [getNum("gain_r", 1), getNum("gain_g", 1), getNum("gain_b", 1)],
					};
				},
			},
		],
	},
};
