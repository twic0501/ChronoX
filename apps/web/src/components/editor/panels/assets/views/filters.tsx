"use client";

import { useEffect, useRef, useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { EFFECT_TARGET_ELEMENT_TYPES } from "@/lib/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { useEditor } from "@/hooks/use-editor";
import { buildEffectElement } from "@/lib/timeline/element-utils";

export interface FilterInfo {
	id: string;
	name: string;
	type: string; // underlying effect type
	params?: Record<string, any>;
	thumbnailBg: string;
}

export const COLOR_FILTERS: FilterInfo[] = [
	{
		id: "cinematic_lut",
		name: "Cinematic Teal & Orange",
		type: "lut_grade",
		params: { intensity: 1.0, logProfile: 1.0 },
		thumbnailBg: "bg-gradient-to-tr from-cyan-600 to-amber-500",
	},
	{
		id: "grayscale_noir",
		name: "B&W Noir",
		type: "grayscale",
		thumbnailBg: "bg-gradient-to-tr from-gray-700 to-gray-300",
	},
	{
		id: "vintage_sepia",
		name: "Vintage Sepia",
		type: "duotone",
		params: { color1: "#402000", color2: "#ffdfa0" },
		thumbnailBg: "bg-gradient-to-tr from-[#402000] to-[#ffdfa0]",
	},
	{
		id: "neon_cyberpunk",
		name: "Neon Cyberpunk",
		type: "duotone",
		params: { color1: "#ff007f", color2: "#00ffff" },
		thumbnailBg: "bg-gradient-to-tr from-pink-500 to-cyan-400",
	},
	{
		id: "classic_negative",
		name: "Negative Film",
		type: "invert",
		thumbnailBg: "bg-gradient-to-tr from-purple-800 to-green-500",
	},
	{
		id: "warm_gold",
		name: "Warm Gold",
		type: "color_adjust",
		params: { brightness: 0.05, contrast: 0.05, saturation: 0.1 },
		thumbnailBg: "bg-gradient-to-tr from-yellow-700 to-amber-400",
	},
];

export function FiltersView() {
	return (
		<PanelView title="Filters">
			<FiltersGrid filters={COLOR_FILTERS} />
		</PanelView>
	);
}

function FiltersGrid({ filters }: { filters: FilterInfo[] }) {
	return (
		<div
			className="grid gap-2"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}
		>
			{filters.map((filter) => (
				<FilterItem key={filter.id} filter={filter} />
			))}
		</div>
	);
}

function FilterPreviewCanvas({
	effectType,
	params,
}: {
	effectType: string;
	params?: Record<string, any>;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const render = () => {
			if (!canvasRef.current) return;
			try {
				effectPreviewService.renderPreview({
					effectType,
					params: params || {},
					targetCanvas: canvasRef.current,
				});
			} catch (error) {
				console.warn(`Filter preview failed for "${effectType}"`, error);
			}
		};

		render();
		return effectPreviewService.onPreviewImageReady({ callback: render });
	}, [effectType, params]);

	return <canvas ref={canvasRef} className="size-full rounded-md" />;
}

function FilterItem({ filter }: { filter: FilterInfo }) {
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		const element = buildEffectElement({
			effectType: filter.type,
			startTime: currentTime,
		});

		// Apply preset parameters and custom name
		if (filter.params) {
			element.params = { ...element.params, ...filter.params };
		}
		element.name = filter.name;

		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	}, [editor, filter]);

	const preview = (
		<div className="relative size-full rounded-md overflow-hidden bg-accent">
			<FilterPreviewCanvas effectType={filter.type} params={filter.params} />
			<div className="absolute inset-0 bg-black/10 hover:bg-black/0 transition-colors duration-200" />
		</div>
	);

	return (
		<DraggableItem
			name={filter.name}
			preview={preview}
			dragData={{
				id: filter.id,
				name: filter.name,
				type: "effect",
				effectType: filter.type,
				params: filter.params, // pass custom preset params
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
