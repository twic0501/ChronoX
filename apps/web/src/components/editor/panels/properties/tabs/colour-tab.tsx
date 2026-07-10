"use client";

import { useRef } from "react";
import type { ParamValues } from "@/lib/params";
import type { Effect } from "@/lib/effects/types";
import type { VisualElement } from "@/lib/timeline";
import { useEditor } from "@/hooks/use-editor";
import { useElementPreview } from "@/hooks/use-element-preview";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";

const EFFECT_TYPE = "color-adjust";

/** Defaults mirror the color-adjust effect definition. */
const GRADE_DEFAULTS: Record<string, number> = {
	brightness: 0,
	contrast: 0,
	saturation: 0,
	exposure: 0,
	temperature: 0,
	tint: 0,
	highlights: 0,
	shadows: 0,
	lift_r: 0,
	lift_g: 0,
	lift_b: 0,
	gamma_r: 1,
	gamma_g: 1,
	gamma_b: 1,
	gain_r: 1,
	gain_g: 1,
	gain_b: 1,
};

type WheelSpec = {
	id: "lift" | "gamma" | "gain";
	label: string;
	base: number;
	/** How far a full puck deflection moves a channel away from the mean. */
	range: number;
	/** Master slider bounds. */
	masterMin: number;
	masterMax: number;
	/** Hard clamps from the effect definition. */
	clampMin: number;
	clampMax: number;
};

const WHEELS: WheelSpec[] = [
	{
		id: "lift",
		label: "Lift",
		base: 0,
		range: 0.35,
		masterMin: -0.35,
		masterMax: 0.35,
		clampMin: -0.5,
		clampMax: 0.5,
	},
	{
		id: "gamma",
		label: "Gamma",
		base: 1,
		range: 0.55,
		masterMin: 0.45,
		masterMax: 1.55,
		clampMin: 0.1,
		clampMax: 2,
	},
	{
		id: "gain",
		label: "Gain",
		base: 1,
		range: 0.8,
		masterMin: 0.2,
		masterMax: 1.8,
		clampMin: 0,
		clampMax: 2,
	},
];

/** Channel directions on the wheel face: R up, G lower-left, B lower-right. */
const CHANNEL_VECTORS: Record<"r" | "g" | "b", { x: number; y: number }> = {
	r: { x: 0, y: -1 },
	g: { x: -0.866, y: 0.5 },
	b: { x: 0.866, y: 0.5 },
};

type SliderSpec = {
	key: string;
	label: string;
	min: number;
	max: number;
	step: number;
	/** Display multiplier — sliders show ±100 style values. */
	scale: number;
};

const ADJUST_SLIDERS: SliderSpec[] = [
	{
		key: "temperature",
		label: "Temperature",
		min: -1,
		max: 1,
		step: 0.01,
		scale: 100,
	},
	{ key: "tint", label: "Tint", min: -1, max: 1, step: 0.01, scale: 100 },
	{ key: "exposure", label: "Exposure", min: -2, max: 2, step: 0.01, scale: 1 },
	{
		key: "contrast",
		label: "Contrast",
		min: -1,
		max: 1,
		step: 0.01,
		scale: 100,
	},
	{
		key: "saturation",
		label: "Saturation",
		min: -1,
		max: 1,
		step: 0.01,
		scale: 100,
	},
	{
		key: "highlights",
		label: "Highlights",
		min: -1,
		max: 1,
		step: 0.01,
		scale: 100,
	},
	{ key: "shadows", label: "Shadows", min: -1, max: 1, step: 0.01, scale: 100 },
	{
		key: "brightness",
		label: "Brightness",
		min: -1,
		max: 1,
		step: 0.01,
		scale: 100,
	},
];

type Look = {
	id: string;
	label: string;
	swatch: string;
	params: Partial<Record<string, number>>;
};

/** Param bundles for the real color-adjust shader — every key exists in the definition. */
const LOOKS: Look[] = [
	{
		id: "none",
		label: "None",
		swatch: "linear-gradient(135deg, #3a3a42, #23232a)",
		params: { ...GRADE_DEFAULTS },
	},
	{
		id: "teal-orange",
		label: "Teal & Orange",
		swatch: "linear-gradient(135deg, #2e8f88, #d98a4a)",
		params: {
			lift_r: -0.04,
			lift_b: 0.05,
			gain_r: 1.12,
			gain_g: 1.02,
			gain_b: 0.9,
			contrast: 0.15,
			saturation: 0.08,
		},
	},
	{
		id: "golden-hour",
		label: "Golden Hour",
		swatch: "linear-gradient(135deg, #f0c069, #c2662f)",
		params: {
			temperature: 0.35,
			gain_r: 1.14,
			gain_g: 1.04,
			gain_b: 0.92,
			shadows: 0.08,
			contrast: 0.06,
			saturation: 0.05,
		},
	},
	{
		id: "film",
		label: "Film",
		swatch: "linear-gradient(135deg, #7d8a6d, #4a4438)",
		params: {
			contrast: 0.2,
			saturation: -0.15,
			lift_g: 0.02,
			lift_b: 0.03,
			gain_b: 1.05,
			highlights: -0.1,
		},
	},
	{
		id: "moody",
		label: "Moody",
		swatch: "linear-gradient(135deg, #46557a, #191c26)",
		params: {
			exposure: -0.18,
			contrast: 0.22,
			saturation: -0.1,
			temperature: -0.18,
			shadows: -0.1,
			lift_b: 0.04,
		},
	},
	{
		id: "bw",
		label: "B&W",
		swatch: "linear-gradient(135deg, #d8d8d8, #2a2a2a)",
		params: { saturation: -1, contrast: 0.12 },
	},
];

export function ColourTab({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});

	const findGrade = (el: VisualElement): Effect | undefined =>
		el.effects?.find((ef) => ef.type === EFFECT_TYPE);

	const committedGrade = findGrade(element);
	const renderGrade = findGrade(renderElement as VisualElement);
	const params: ParamValues =
		renderGrade?.params ?? committedGrade?.params ?? {};

	const getNum = (key: string): number => {
		const v = params[key];
		return typeof v === "number" ? v : (GRADE_DEFAULTS[key] ?? 0);
	};

	/** The grade effect is created lazily, on the first real interaction. */
	const ensureEffectId = (): string => {
		const existing = findGrade(element);
		if (existing) return existing.id;
		return editor.timeline.addClipEffect({
			trackId,
			elementId: element.id,
			effectType: EFFECT_TYPE,
		});
	};

	const previewParams = (updates: Record<string, number>) => {
		const effectId = ensureEffectId();
		const current =
			(renderElement as VisualElement).effects ?? element.effects ?? [];
		const updatedEffects = current.map((ef) =>
			ef.id !== effectId ? ef : { ...ef, params: { ...ef.params, ...updates } },
		);
		previewUpdates({ effects: updatedEffects });
	};

	const applyLook = (look: Look) => {
		const effectId = ensureEffectId();
		editor.timeline.updateClipEffectParams({
			trackId,
			elementId: element.id,
			effectId,
			params: { ...GRADE_DEFAULTS, ...look.params },
		});
	};

	const resetAll = () => {
		const grade = findGrade(element);
		if (!grade) return;
		editor.timeline.updateClipEffectParams({
			trackId,
			elementId: element.id,
			effectId: grade.id,
			params: { ...GRADE_DEFAULTS },
		});
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 shrink-0 items-center justify-between border-b px-3.5">
				<span className="text-sm font-medium">Colour</span>
				<Button
					variant="text"
					size="sm"
					className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
					onClick={resetAll}
				>
					Reset
				</Button>
			</div>

			<div className="scrollbar-thin flex-1 overflow-y-auto">
				{/* LOOK presets */}
				<SectionBlock title="Look">
					<div className="scrollbar-hidden -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
						{LOOKS.map((look) => (
							<button
								key={look.id}
								type="button"
								onClick={() => applyLook(look)}
								className="group flex shrink-0 flex-col items-center gap-1.5"
							>
								<span
									className="block h-12 w-16 rounded-md border border-border/60 transition-transform group-hover:scale-[1.04] group-active:scale-95"
									style={{ background: look.swatch }}
								/>
								<span className="text-[10px] text-muted-foreground group-hover:text-foreground">
									{look.label}
								</span>
							</button>
						))}
					</div>
				</SectionBlock>

				{/* Colour wheels */}
				<SectionBlock title="Colour grade">
					<div className="grid grid-cols-3 gap-2">
						{WHEELS.map((wheel) => (
							<ColourWheel
								key={wheel.id}
								spec={wheel}
								r={getNum(`${wheel.id}_r`)}
								g={getNum(`${wheel.id}_g`)}
								b={getNum(`${wheel.id}_b`)}
								onPreview={previewParams}
								onCommit={commit}
							/>
						))}
					</div>
				</SectionBlock>

				{/* Adjustment sliders */}
				<SectionBlock title="Adjust" last>
					<div className="flex flex-col gap-3.5">
						{ADJUST_SLIDERS.map((spec) => (
							<AdjustSlider
								key={spec.key}
								spec={spec}
								value={getNum(spec.key)}
								onPreview={(v) => previewParams({ [spec.key]: v })}
								onCommit={commit}
							/>
						))}
					</div>
				</SectionBlock>
			</div>
		</div>
	);
}

function SectionBlock({
	title,
	last,
	children,
}: {
	title: string;
	last?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("px-3.5 py-4", !last && "border-b border-border/60")}>
			<span className="mb-3 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</span>
			{children}
		</div>
	);
}

/**
 * Maps three channel values onto a wheel puck + master:
 * master = channel mean; the puck holds the per-channel deviations projected
 * onto the R/G/B directions (the classic lift/gamma/gain wheel behaviour).
 */
function ColourWheel({
	spec,
	r,
	g,
	b,
	onPreview,
	onCommit,
}: {
	spec: WheelSpec;
	r: number;
	g: number;
	b: number;
	onPreview: (updates: Record<string, number>) => void;
	onCommit: () => void;
}) {
	const faceRef = useRef<HTMLDivElement>(null);
	const draggingRef = useRef(false);

	const mean = (r + g + b) / 3;
	const devs = { r: r - mean, g: g - mean, b: b - mean };

	// puck = (2/3) Σ (dev_c / range) * unit_c  — inverse of the projection below.
	const px =
		((devs.r * CHANNEL_VECTORS.r.x +
			devs.g * CHANNEL_VECTORS.g.x +
			devs.b * CHANNEL_VECTORS.b.x) /
			spec.range) *
		(2 / 3);
	const py =
		((devs.r * CHANNEL_VECTORS.r.y +
			devs.g * CHANNEL_VECTORS.g.y +
			devs.b * CHANNEL_VECTORS.b.y) /
			spec.range) *
		(2 / 3);

	const clamp = (v: number) =>
		Math.min(spec.clampMax, Math.max(spec.clampMin, v));

	const channelsFromPuck = (x: number, y: number, master: number) => ({
		[`${spec.id}_r`]: clamp(
			master + (x * CHANNEL_VECTORS.r.x + y * CHANNEL_VECTORS.r.y) * spec.range,
		),
		[`${spec.id}_g`]: clamp(
			master + (x * CHANNEL_VECTORS.g.x + y * CHANNEL_VECTORS.g.y) * spec.range,
		),
		[`${spec.id}_b`]: clamp(
			master + (x * CHANNEL_VECTORS.b.x + y * CHANNEL_VECTORS.b.y) * spec.range,
		),
	});

	const handlePointer = (e: React.PointerEvent) => {
		const face = faceRef.current;
		if (!face) return;
		const rect = face.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		let x = ((e.clientX - cx) / (rect.width / 2)) * 1;
		let y = ((e.clientY - cy) / (rect.height / 2)) * 1;
		const len = Math.hypot(x, y);
		if (len > 1) {
			x /= len;
			y /= len;
		}
		onPreview(channelsFromPuck(x, y, mean));
	};

	return (
		<div className="flex flex-col items-center gap-2">
			{/* biome-ignore lint/a11y/useFocusableInteractive: pointer-only colour wheel; master slider below is the accessible control */}
			<div
				ref={faceRef}
				role="slider"
				aria-label={`${spec.label} colour wheel`}
				aria-valuenow={Number(mean.toFixed(3))}
				onPointerDown={(e) => {
					draggingRef.current = true;
					(e.target as HTMLElement).setPointerCapture(e.pointerId);
					handlePointer(e);
				}}
				onPointerMove={(e) => {
					if (draggingRef.current) handlePointer(e);
				}}
				onPointerUp={(e) => {
					if (!draggingRef.current) return;
					draggingRef.current = false;
					(e.target as HTMLElement).releasePointerCapture(e.pointerId);
					onCommit();
				}}
				onDoubleClick={() => {
					onPreview(channelsFromPuck(0, 0, spec.base));
					onCommit();
				}}
				className="relative aspect-square w-full max-w-[88px] cursor-crosshair touch-none select-none rounded-full border border-border/70"
				style={{
					background:
						"radial-gradient(circle at 50% 50%, var(--card) 32%, transparent 78%)," +
						"conic-gradient(from 0deg, #e05252, #e0d152, #52e05e, #52dfe0, #5252e0, #e052d8, #e05252)",
				}}
				title={`${spec.label} — drag to shift, double-click to reset`}
			>
				{/* crosshair */}
				<span className="absolute left-1/2 top-1/2 h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-foreground/20" />
				<span className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/20" />
				{/* puck */}
				<span
					className="pointer-events-none absolute size-3 rounded-full border-2 border-white bg-black/40 shadow-md"
					style={{
						left: `calc(50% + ${px * 50}% - 6px)`,
						top: `calc(50% + ${py * 50}% - 6px)`,
					}}
				/>
			</div>

			<span className="text-[11px] font-medium text-foreground">
				{spec.label}
			</span>

			{/* master */}
			<Slider
				min={spec.masterMin}
				max={spec.masterMax}
				step={0.005}
				value={[Math.min(spec.masterMax, Math.max(spec.masterMin, mean))]}
				onValueChange={([v]) => {
					if (v === undefined) return;
					onPreview({
						[`${spec.id}_r`]: clamp(v + devs.r),
						[`${spec.id}_g`]: clamp(v + devs.g),
						[`${spec.id}_b`]: clamp(v + devs.b),
					});
				}}
				onValueCommit={() => onCommit()}
				className="w-full"
			/>

			<span className="font-mono text-[9px] leading-none text-muted-foreground">
				R{fmt(r - spec.base)} G{fmt(g - spec.base)} B{fmt(b - spec.base)}
			</span>
		</div>
	);
}

function fmt(v: number): string {
	const s = v.toFixed(2);
	return s.startsWith("-") ? s : `.${s.split(".")[1]}`;
}

function AdjustSlider({
	spec,
	value,
	onPreview,
	onCommit,
}: {
	spec: SliderSpec;
	value: number;
	onPreview: (value: number) => void;
	onCommit: () => void;
}) {
	const display =
		spec.scale === 1
			? (value >= 0 ? "+" : "") + value.toFixed(2)
			: (value >= 0 ? "+" : "") + Math.round(value * spec.scale);

	const isNeutral = Math.abs(value) < 0.0001;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">{spec.label}</span>
				<span
					className={cn(
						"font-mono text-[10px]",
						isNeutral ? "text-muted-foreground/60" : "text-primary",
					)}
				>
					{display}
				</span>
			</div>
			<Slider
				min={spec.min}
				max={spec.max}
				step={spec.step}
				value={[value]}
				onValueChange={([v]) => {
					if (v !== undefined) onPreview(v);
				}}
				onValueCommit={() => onCommit()}
			/>
		</div>
	);
}
