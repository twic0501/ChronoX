import { describe, expect, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { Command } from "@/lib/commands";

/** Minimal command that mutates a shared counter, for stack semantics. */
function counterCommand(state: { value: number }): Command {
	return {
		execute: () => {
			state.value += 1;
		},
		undo: () => {
			state.value -= 1;
		},
		redo: () => {
			state.value += 1;
		},
	} as unknown as Command;
}

describe("CommandManager", () => {
	test("execute/undo/redo round-trip", () => {
		const cm = new CommandManager();
		const state = { value: 0 };
		cm.execute({ command: counterCommand(state) });
		cm.execute({ command: counterCommand(state) });
		expect(state.value).toBe(2);
		cm.undo();
		expect(state.value).toBe(1);
		expect(cm.canRedo()).toBe(true);
		cm.redo();
		expect(state.value).toBe(2);
	});

	test("depth() checkpoints an AI run: revert exactly N automated edits", () => {
		const cm = new CommandManager();
		const state = { value: 0 };
		// user makes 2 edits of their own
		cm.execute({ command: counterCommand(state) });
		cm.execute({ command: counterCommand(state) });

		// AI run checkpoint — same mechanism the chat sidebar uses
		const startDepth = cm.depth();
		cm.execute({ command: counterCommand(state) });
		cm.execute({ command: counterCommand(state) });
		cm.execute({ command: counterCommand(state) });
		const editsMade = cm.depth() - startDepth;
		expect(editsMade).toBe(3);

		// "Revert all (N)" — user's own edits must survive
		for (let i = 0; i < editsMade; i++) cm.undo();
		expect(state.value).toBe(2);
		expect(cm.depth()).toBe(startDepth);
	});

	test("a new execute clears the redo stack", () => {
		const cm = new CommandManager();
		const state = { value: 0 };
		cm.execute({ command: counterCommand(state) });
		cm.undo();
		expect(cm.canRedo()).toBe(true);
		cm.execute({ command: counterCommand(state) });
		expect(cm.canRedo()).toBe(false);
	});

	test("undo/redo on empty stacks is a no-op", () => {
		const cm = new CommandManager();
		expect(() => {
			cm.undo();
			cm.redo();
		}).not.toThrow();
		expect(cm.depth()).toBe(0);
		expect(cm.canUndo()).toBe(false);
	});
});
