import { NumberField } from "@/components/ui/number-field";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/lib/timeline/audio-constants";
import { DEFAULTS } from "@/lib/timeline/defaults";
import {
	clamp,
	formatNumberForDisplay,
	getFractionDigitsForStep,
	isNearlyEqual,
	snapToStep,
} from "@/utils/math";
import type { AudioElement, VideoElement } from "@/lib/timeline";
import { resolveNumberAtTime } from "@/lib/animation";
import { useElementPlayhead } from "../hooks/use-element-playhead";
import { useKeyframedNumberProperty } from "../hooks/use-keyframed-number-property";
import { KeyframeToggle } from "../components/keyframe-toggle";
import { HugeiconsIcon } from "@hugeicons/react";
import { VolumeHighIcon } from "@hugeicons/core-free-icons";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/hooks/use-editor";
import { Button } from "@/components/ui/button";

const VOLUME_STEP = 0.1;
const VOLUME_FRACTION_DIGITS = getFractionDigitsForStep({ step: VOLUME_STEP });

export function AudioTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const resolvedVolume = resolveNumberAtTime({
		baseValue: element.volume ?? DEFAULTS.element.volume,
		animations: element.animations,
		propertyPath: "volume",
		localTime,
	});
	const volume = useKeyframedNumberProperty({
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: "volume",
		localTime,
		isPlayheadWithinElementRange,
		displayValue: formatNumberForDisplay({
			value: resolvedVolume,
			fractionDigits: VOLUME_FRACTION_DIGITS,
		}),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) {
				return null;
			}

			return clamp({
				value: snapToStep({ value: parsed, step: VOLUME_STEP }),
				min: VOLUME_DB_MIN,
				max: VOLUME_DB_MAX,
			});
		},
		valueAtPlayhead: resolvedVolume,
		step: VOLUME_STEP,
		buildBaseUpdates: ({ value }) => ({
			volume: value,
		}),
	});
	const isDefault =
		volume.hasAnimatedKeyframes && isPlayheadWithinElementRange
			? isNearlyEqual({
					leftValue: resolvedVolume,
					rightValue: DEFAULTS.element.volume,
				})
			: (element.volume ?? DEFAULTS.element.volume) === DEFAULTS.element.volume;

	return (
		<Section collapsible sectionKey={`${element.id}:audio`}>
			<SectionHeader>
				<SectionTitle>Audio</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<SectionField
						label="Volume"
						beforeLabel={
							<KeyframeToggle
								isActive={volume.isKeyframedAtTime}
								isDisabled={!isPlayheadWithinElementRange}
								title="Toggle volume keyframe"
								onToggle={volume.toggleKeyframe}
							/>
						}
					>
						<NumberField
							icon={<HugeiconsIcon icon={VolumeHighIcon} />}
							value={volume.displayValue}
							onFocus={volume.onFocus}
							onChange={volume.onChange}
							onBlur={volume.onBlur}
							dragSensitivity="slow"
							scrubClamp={{ min: VOLUME_DB_MIN, max: VOLUME_DB_MAX }}
							onScrub={volume.scrubTo}
							onScrubEnd={volume.commitScrub}
							onReset={() =>
								volume.commitValue({
									value: DEFAULTS.element.volume,
								})
							}
							isDefault={isDefault}
							suffix="dB"
						/>
					</SectionField>
					<SectionField label="Audio Fade Presets">
						<div className="flex gap-2 w-full mt-1">
							<Button
								variant="outline"
								size="sm"
								className="text-xs h-8 flex-1"
								onClick={() => {
									editor.timeline.upsertKeyframes({
										keyframes: [
											{ trackId, elementId: element.id, propertyPath: "volume", time: 0, value: VOLUME_DB_MIN },
											{ trackId, elementId: element.id, propertyPath: "volume", time: 1, value: 0 },
										],
									});
								}}
							>
								Fade In (1s)
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="text-xs h-8 flex-1"
								onClick={() => {
									const dur = element.duration;
									editor.timeline.upsertKeyframes({
										keyframes: [
											{ trackId, elementId: element.id, propertyPath: "volume", time: Math.max(0, dur - 1), value: 0 },
											{ trackId, elementId: element.id, propertyPath: "volume", time: dur, value: VOLUME_DB_MIN },
										],
									});
								}}
							>
								Fade Out (1s)
							</Button>
						</div>
					</SectionField>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
