"use client";

export interface SourceItem {
	id: string;
	type: "youtube" | "text" | "brief";
	name: string;
	content: string; // text transcript, summary, or document text
	url?: string;
	selected: boolean;
	createdAt: number;
}

const STORAGE_KEY = "chronox.ai.sources";

export function listSources(): SourceItem[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

export function saveSource(source: SourceItem): SourceItem {
	if (typeof window === "undefined") return source;
	try {
		const list = listSources();
		const idx = list.findIndex((s) => s.id === source.id);
		if (idx >= 0) {
			list[idx] = source;
		} else {
			list.push(source);
		}
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch (err) {
		console.error("Failed to save source:", err);
	}
	return source;
}

export function deleteSource(id: string): void {
	if (typeof window === "undefined") return;
	try {
		const list = listSources().filter((s) => s.id !== id);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch (err) {
		console.error("Failed to delete source:", err);
	}
}

export function toggleSelectSource(id: string): SourceItem[] {
	if (typeof window === "undefined") return [];
	try {
		const list = listSources().map((s) =>
			s.id === id ? { ...s, selected: !s.selected } : s,
		);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
		return list;
	} catch {
		return [];
	}
}

export function clearSources(): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {}
}
