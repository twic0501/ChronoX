import type { Command } from "@/lib/commands";

export class CommandManager {
	private history: Command[] = [];
	private redoStack: Command[] = [];

	execute({ command }: { command: Command }): Command {
		command.execute();
		this.history.push(command);
		this.redoStack = [];
		return command;
	}

	push({ command }: { command: Command }): void {
		this.history.push(command);
		this.redoStack = [];
	}

	undo(): void {
		if (this.history.length === 0) return;
		const command = this.history.pop();
		command?.undo();
		if (command) {
			this.redoStack.push(command);
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const command = this.redoStack.pop();
		command?.redo();
		if (command) {
			this.history.push(command);
		}
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	/** Undo-stack depth — lets callers checkpoint before a batch of automated
	 * edits (e.g. an AI agent run) and revert exactly that many steps. */
	depth(): number {
		return this.history.length;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
	}
}
