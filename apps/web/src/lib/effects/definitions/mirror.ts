import type { EffectDefinition } from "@/lib/effects/types";
import mirrorFragmentShader from "./mirror.frag.glsl";

const DIRECTION_TO_UNIFORM: Record<string, number> = {
	"left-right": 0,
	"right-left": 1,
	"top-bottom": 2,
	"bottom-top": 3,
};

export const mirrorEffectDefinition: EffectDefinition = {
	type: "mirror",
	name: "Mirror",
	keywords: ["mirror", "reflect", "symmetry", "flip", "kaleido"],
	params: [
		{
			key: "direction",
			label: "Direction",
			type: "select",
			default: "left-right",
			options: [
				{ value: "left-right", label: "Left → Right" },
				{ value: "right-left", label: "Right → Left" },
				{ value: "top-bottom", label: "Top → Bottom" },
				{ value: "bottom-top", label: "Bottom → Top" },
			],
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: mirrorFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_direction:
						DIRECTION_TO_UNIFORM[String(effectParams.direction)] ?? 0,
				}),
			},
		],
	},
};
