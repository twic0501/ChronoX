"use client";

import { useState } from "react";
import { Search, Sparkles, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/hooks/use-editor";
import { toast } from "sonner";

export function AiSearchBar() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const [query, setQuery] = useState("");
	const [isSearching, setIsSearching] = useState(false);

	if (!activeProject) return null;

	const handleSearch = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!query.trim() || isSearching) return;

		setIsSearching(true);
		try {
			const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
			const response = await fetch(`${API_URL}/api/ai/search`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					projectId: activeProject.metadata.id,
					query: query.trim(),
				}),
			});

			if (!response.ok) {
				throw new Error("Semantic search failed.");
			}

			const data = await response.json();
			const results = data.results;

			if (results && results.length > 0) {
				const bestMatch = results[0];
				
				// Jump playhead to start time
				editor.playback.seek({ time: bestMatch.startTime });

				toast.success("Jumped to the best-matching scene!", {
					description: `AI Match (${Math.round(bestMatch.score * 100)}%): "${bestMatch.text}" at ${bestMatch.startTime}s`,
					action: {
						label: "Play clip",
						onClick: () => editor.playback.play(),
					},
				});
			} else {
				toast.info("No matching scene found.", {
					description: "Make sure the video has been transcribed and captioned so the AI can index it.",
				});
			}
		} catch (error) {
			console.error("Semantic search error:", error);
			toast.error("Search error", {
				description: "Embedding service is not responding, or the backend is not running.",
			});
		} finally {
			setIsSearching(false);
		}
	};

	return (
		<form onSubmit={handleSearch} className="relative flex items-center w-full">
			<div className="relative flex-1">
				<input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Smart scene search (e.g. 'the intro' or 'the setup shot')..."
					disabled={isSearching}
					className="w-full pl-8 pr-12 py-1 h-9 text-xs rounded-md border bg-accent/25 border-border outline-none text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
				/>
				<div className="absolute left-2.5 top-2.5 text-muted-foreground">
					{isSearching ? (
						<Loader2 className="size-3.5 animate-spin text-purple-400" />
					) : (
						<Search className="size-3.5" />
					)}
				</div>
				<div className="absolute right-2 top-1.5 flex items-center gap-1 text-[10px] text-purple-400 font-semibold bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20 select-none">
					<Sparkles className="size-2.5 animate-pulse" />
					<span>AI RAG</span>
				</div>
			</div>
		</form>
	);
}
