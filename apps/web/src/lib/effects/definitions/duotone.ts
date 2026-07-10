import type { EffectDefinition } from "@/lib/effects/types";
import duotoneFragmentShader from "./duotone.frag.glsl";

function hexToRgb(value: unknown, fallback: [number, number, number]) {
	if (typeof value !== "string") return fallback;
	const hex = value.replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return fallback;
	return [
		parseInt(hex.slice(0, 2), 16) / 255,
		parseInt(hex.slice(2, 4), 16) / 255,
		parseInt(hex.slice(4, 6), 16) / 255,
	];
}

export const duotoneEffectDefinition: EffectDefinition = {
	type: "duotone",
	name: "Duotone",
	keywords: ["duotone", "two", "tone", "tint", "poster", "stylized", "spotify"],
	params: [
		{
			key: "shadowColor",
			label: "Shadows",
			type: "color",
			default: "#16215c",
		},
		{
			key: "highlightColor",
			label: "Highlights",
			type: "color",
			default: "#f2c14e",
		},
		{
			key: "mix",
			label: "Mix",
			type: "number",
			default: 1,
			min: 0,
			max: 1,
			step: 0.01,
			displayMultiplier: 100,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: duotoneFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_shadowColor: hexToRgb(effectParams.shadowColor, [
						0x16 / 255,
						0x21 / 255,
						0x5c / 255,
					]),
					u_highlightColor: hexToRgb(effectParams.highlightColor, [
						0xf2 / 255,
						0xc1 / 255,
						0x4e / 255,
					]),
					u_mix: typeof effectParams.mix === "number" ? effectParams.mix : 1,
				}),
			},
		],
	},
};
