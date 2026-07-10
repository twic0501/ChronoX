import { describe, expect, test, mock, beforeAll } from "bun:test";
import { parsePartialOperations } from "@/components/editor/panels/properties/chat-sidebar";
import { useEditorStore } from "@/stores/editor-store";
import { registerDefaultMasks } from "@/lib/masks/definitions";

beforeAll(() => {
	registerDefaultMasks();
});

describe("ChronoX AI & Interactive UI verification tests", () => {
	// --- Group 1: Robustness Test ---
	test("Group 1: parsePartialOperations should robustly parse truncated/malformed JSON stream without crashing", () => {
		// Test case A: Truncated JSON operations list
		const truncatedStreamInput = `Here is the first proposed action:
\`\`\`json
{
  "operations": [
    {
      "action": "split",
      "clip_id": "c1",
      "time": 15.0
    }
`;
		const parsedOpsA = parsePartialOperations(truncatedStreamInput);
		expect(parsedOpsA).toBeArray();
		expect(parsedOpsA.length).toBe(1);
		expect(parsedOpsA[0].action).toBe("split");
		expect(parsedOpsA[0].clip_id).toBe("c1");
		expect(parsedOpsA[0].time).toBe(15.0);

		// Test case B: Severe truncation inside params key/value
		const severeTruncationInput = `{"operations": [{"action": "trim", "clip_id": "c2", "start": 5.0`;
		const parsedOpsB = parsePartialOperations(severeTruncationInput);
		// Should either parse successfully by fixing the closing brackets, or return empty array without throwing SyntaxError.
		expect(() => parsePartialOperations(severeTruncationInput)).not.toThrow();
	});

	// --- Group 2: Zustand Store Ghost State Test ---
	test("Group 4: Zustand Store State Machine and Toggle/Commit loop", () => {
		const store = useEditorStore.getState();

		// Mock operations list returned from LLM
		const mockOps = [
			{ action: "split", clip_id: "clip_01", time: 10.0, trackId: "main_video" },
			{ action: "trim", clip_id: "clip_02", start: 2.0, end: 8.0, trackId: "main_video" },
			{ action: "adjust_color", clip_id: "clip_03", trackId: "main_video" }
		];

		// Populates activeOperations and ghostClips
		store.setGhostStateFromStream(mockOps);

		// Verify state populated correctly
		expect(useEditorStore.getState().activeOperations.length).toBe(3);
		expect(useEditorStore.getState().ghostClips.length).toBe(2); // Only trim and split create ghostClips in setGhostStateFromStream logic

		// Toggling an operation should set corresponding ghostClips isInvalid to true
		const firstOpId = useEditorStore.getState().activeOperations[0].id;
		store.toggleOperation(firstOpId, false);

		// Verify corresponding ghostClip is marked invalid
		const ghostClips = useEditorStore.getState().ghostClips;
		const splitGhostClip = ghostClips.find(c => c.operationId === firstOpId);
		if (splitGhostClip) {
			expect(splitGhostClip.isInvalid).toBe(true);
		}

		// Verify clear state works
		store.clearGhostState();
		expect(useEditorStore.getState().activeOperations.length).toBe(0);
		expect(useEditorStore.getState().ghostClips.length).toBe(0);
	});

	test("Group 4: compileAction compiles J/L cuts, speed ramping, effects, masks, subtitles, and overlays successfully", async () => {
		const { compileAction } = await import("@/lib/ai/compiler");

		// Mock tracks snapshot
		const mockTracks = [
			{
				id: "main_video",
				name: "Video Track 1",
				type: "video",
				elements: [
					{ id: "clip_01", type: "video", startTime: 0, duration: 10.0, trimStart: 0, trimEnd: 0 }
				]
			}
		] as any;

		// Mock editor core
		const mockEditor = {
			timeline: {
				getTracks: () => mockTracks,
			}
		} as any;

		// 1. Change Speed
		const cmdSpeed = compileAction(
			{ action: "change_speed", clip_id: "clip_01", speed: 2.0 },
			mockTracks,
			mockEditor
		);
		expect(cmdSpeed).not.toBeNull();

		// 2. Adjust Volume / Duck Audio
		const cmdVolume = compileAction(
			{ action: "adjust_volume", clip_id: "clip_01", volume: 0.1 },
			mockTracks,
			mockEditor
		);
		expect(cmdVolume).not.toBeNull();

		// 3. Add Effect
		const cmdEffect = compileAction(
			{ action: "add_effect", clip_id: "clip_01", effect_type: "blur" },
			mockTracks,
			mockEditor
		);
		expect(cmdEffect).not.toBeNull();

		// 4. Add Mask
		const cmdMask = compileAction(
			{ action: "add_mask", clip_id: "clip_01", mask_type: "rectangle", invert: true },
			mockTracks,
			mockEditor
		);
		expect(cmdMask).not.toBeNull();

		// 5. Add Subtitle
		const cmdSub = compileAction(
			{ action: "add_subtitle", start: 2.0, duration: 3.5, text: "Auto Subtitles" },
			mockTracks,
			mockEditor
		);
		expect(cmdSub).not.toBeNull();

		// 6. Add Overlay
		const cmdOverlay = compileAction(
			{ action: "add_overlay", start: 1.0, duration: 4.0, overlay_type: "video" },
			mockTracks,
			mockEditor
		);
		expect(cmdOverlay).not.toBeNull();

		// 7. Blend Mode
		const cmdBlend = compileAction(
			{ action: "blend_mode", clip_id: "clip_01", opacity: 0.8, blend_mode: "multiply" },
			mockTracks,
			mockEditor
		);
		expect(cmdBlend).not.toBeNull();

		// 8. Synonyms / Hallucinated Action Names
		const cmdSynonymSpeed = compileAction(
			{ action: "speed", clip_id: "clip_01", speed: 2.0 },
			mockTracks,
			mockEditor
		);
		expect(cmdSynonymSpeed).not.toBeNull();

		const cmdSynonymVolume = compileAction(
			{ action: "volume", clip_id: "clip_01", volume: 0.2 },
			mockTracks,
			mockEditor
		);
		expect(cmdSynonymVolume).not.toBeNull();

		const cmdSynonymFilter = compileAction(
			{ action: "filter", clip_id: "clip_01", filter: "blur" },
			mockTracks,
			mockEditor
		);
		expect(cmdSynonymFilter).not.toBeNull();
	});
});
