import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { colorAdjustEffectDefinition } from "./color_adjust";
import { grayscaleEffectDefinition } from "./grayscale";
import { invertEffectDefinition } from "./invert";
import { vignetteEffectDefinition } from "./vignette";
import { lutGradeEffectDefinition } from "./lut_grade";
import { halationEffectDefinition } from "./halation";
import { cameraShakeEffectDefinition } from "./camera_shake";
import { glitchEffectDefinition } from "./glitch";
import { letterboxEffectDefinition } from "./letterbox";
import { filmEdgeEffectDefinition } from "./film_edge";
import { pixelateEffectDefinition } from "./pixelate";
import { chromaticAberrationEffectDefinition } from "./chromatic_aberration";
import { sharpenEffectDefinition } from "./sharpen";
import { filmGrainEffectDefinition } from "./film_grain";
import { duotoneEffectDefinition } from "./duotone";
import { posterizeEffectDefinition } from "./posterize";
import { lensDistortionEffectDefinition } from "./lens_distortion";
import { radialBlurEffectDefinition } from "./radial_blur";
import { mirrorEffectDefinition } from "./mirror";

const defaultEffects = [
	blurEffectDefinition,
	colorAdjustEffectDefinition,
	grayscaleEffectDefinition,
	invertEffectDefinition,
	vignetteEffectDefinition,
	lutGradeEffectDefinition,
	halationEffectDefinition,
	cameraShakeEffectDefinition,
	glitchEffectDefinition,
	letterboxEffectDefinition,
	filmEdgeEffectDefinition,
	sharpenEffectDefinition,
	filmGrainEffectDefinition,
	duotoneEffectDefinition,
	posterizeEffectDefinition,
	pixelateEffectDefinition,
	chromaticAberrationEffectDefinition,
	lensDistortionEffectDefinition,
	radialBlurEffectDefinition,
	mirrorEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register(definition.type, definition);
	}
}

