import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import { isVisualElement, updateElementInTracks } from "@/lib/timeline";
import type { TimelineTrack, VisualElement } from "@/lib/timeline";
import { buildDefaultEffectInstance } from "@/lib/effects";

function addEffectToElement({
	element,
	effectType,
	initialParams,
}: {
	element: VisualElement;
	effectType: string;
	initialParams?: Record<string, unknown>;
}): VisualElement {
	const instance = buildDefaultEffectInstance({ effectType });
	if (initialParams) {
		instance.params = { ...instance.params, ...initialParams } as any;
	}
	const currentEffects = element.effects ?? [];
	return { ...element, effects: [...currentEffects, instance] };
}

export class AddClipEffectCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private effectId: string | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly effectType: string;
	private readonly initialParams?: Record<string, unknown>;

	constructor({
		trackId,
		elementId,
		effectType,
		initialParams,
	}: {
		trackId: string;
		elementId: string;
		effectType: string;
		initialParams?: Record<string, unknown>;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.effectType = effectType;
		this.initialParams = initialParams;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const updatedTracks = updateElementInTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			elementPredicate: isVisualElement,
		update: (element) => {
			const updated = addEffectToElement({
				element: element as VisualElement,
				effectType: this.effectType,
				initialParams: this.initialParams,
			});
				const effects = updated.effects ?? [];
				this.effectId = effects[effects.length - 1]?.id ?? null;
				return updated;
			},
		});

		editor.timeline.updateTracks(updatedTracks);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getEffectId(): string | null {
		return this.effectId;
	}
}
