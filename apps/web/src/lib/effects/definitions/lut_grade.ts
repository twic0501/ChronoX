import type { EffectDefinition } from "@/lib/effects/types";
import lutGradeFragmentShader from "./lut_grade.frag.glsl";

let defaultLut3DTexture: WebGLTexture | null = null;

function getOrCreateDefault3DLUTTexture(gl: WebGLRenderingContext): WebGLTexture {
	if (defaultLut3DTexture) return defaultLut3DTexture;

	const gl2 = gl as any;
	const texture = gl.createTexture();
	if (!texture) throw new Error("Failed to create LUT texture");

	const size = 33;
	const data = new Uint8Array(size * size * size * 4); // RGBA format

	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				const idx = (b * size * size + g * size + r) * 4;
				const normR = r / (size - 1);
				const normG = g / (size - 1);
				const normB = b / (size - 1);

				// Cinematic Teal & Orange LUT Algorithm
				let R = normR;
				let G = normG;
				let B = normB;

				const luma = 0.299 * R + 0.587 * G + 0.114 * B;
				if (luma > 0.5) {
					const factor = (luma - 0.5) * 0.4;
					R += factor * 0.15;
					G += factor * 0.05;
					B -= factor * 0.1;
				} else {
					const factor = (0.5 - luma) * 0.3;
					R -= factor * 0.1;
					G += factor * 0.05;
					B += factor * 0.15;
				}

				data[idx] = Math.max(0, Math.min(255, R * 255));
				data[idx + 1] = Math.max(0, Math.min(255, G * 255));
				data[idx + 2] = Math.max(0, Math.min(255, B * 255));
				data[idx + 3] = 255;
			}
		}
	}

	gl.bindTexture(gl2.TEXTURE_3D || 0x806F, texture);
	gl.texParameteri(gl2.TEXTURE_3D || 0x806F, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl2.TEXTURE_3D || 0x806F, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl2.TEXTURE_3D || 0x806F, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl2.TEXTURE_3D || 0x806F, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl2.texParameteri?.(gl2.TEXTURE_3D || 0x806F, gl2.TEXTURE_WRAP_R || 0x8072, gl.CLAMP_TO_EDGE);

	gl2.texImage3D?.(
		gl2.TEXTURE_3D || 0x806F,
		0,
		gl.RGBA,
		size,
		size,
		size,
		0,
		gl.RGBA,
		gl.UNSIGNED_BYTE,
		data
	);

	gl.bindTexture(gl2.TEXTURE_3D || 0x806F, null);

	defaultLut3DTexture = texture;
	return texture;
}

export const lutGradeEffectDefinition: EffectDefinition = {
	type: "lut_grade",
	name: "Cinematic LUT",
	keywords: ["lut", "color", "grade", "cinematic", "log", "s-log3", "d-log"],
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 1.0,
			min: 0.0,
			max: 1.0,
			step: 0.01,
		},
		{
			key: "logProfile",
			label: "LOG Profile",
			type: "number", // 0: Rec709, 1: S-Log3
			default: 1.0,
			min: 0.0,
			max: 2.0,
			step: 1.0,
		},
		{
			key: "lumaVsSatBottom",
			label: "Shadow Cleanup Threshold",
			type: "number",
			default: 0.15,
			min: 0.0,
			max: 0.5,
			step: 0.01,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: lutGradeFragmentShader,
				uniforms: ({ effectParams }) => ({
					u_intensity: typeof effectParams.intensity === "number" ? effectParams.intensity : 1.0,
					u_logProfile: typeof effectParams.logProfile === "number" ? effectParams.logProfile : 1.0,
					u_lumaVsSatBottom: typeof effectParams.lumaVsSatBottom === "number" ? effectParams.lumaVsSatBottom : 0.15,
				}),
				extraBindings: ({ gl }) => {
					const lutTex = getOrCreateDefault3DLUTTexture(gl);
					return [
						{
							unit: 1,
							texture: lutTex,
							name: "u_lutTexture",
							is3D: true,
						},
					];
				},
			},
		],
	},
};
