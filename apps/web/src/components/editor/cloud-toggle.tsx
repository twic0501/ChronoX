"use client";

import { useEditorStore } from "@/stores/editor-store";
import { Cloud, CloudOff, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/utils/ui";

export function CloudToggle() {
	const aiMode = useEditorStore((s) => s.aiMode);
	const setAiMode = useEditorStore((s) => s.setAiMode);

	const handleToggle = (mode: "local" | "cloud") => {
		setAiMode(mode);
		if (mode === "cloud") {
			toast.success("Switched to Cloud AI", {
				description: "Using Cloud Whisper API & Gemini API for maximum speed and accuracy.",
			});
		} else {
			toast.info("Switched to Local AI", {
				description: "Running fully locally on your device, 100% private and cost-free.",
			});
		}
	};

	return (
		<div className="flex items-center gap-0.5 border border-border p-0.5 rounded-md bg-background/40 select-none h-9">
			<Button
				variant="ghost"
				size="sm"
				onClick={() => handleToggle("local")}
				className={cn(
					"h-7 text-[10px] font-medium gap-1 px-2.5 rounded-sm transition-all",
					aiMode === "local" 
						? "bg-accent text-white shadow-sm" 
						: "text-muted-foreground hover:text-foreground"
				)}
			>
				<CloudOff className="size-3" />
				<span>Local AI</span>
			</Button>

			<Button
				variant="ghost"
				size="sm"
				onClick={() => handleToggle("cloud")}
				className={cn(
					"h-7 text-[10px] font-medium gap-1 px-2.5 rounded-sm transition-all",
					aiMode === "cloud" 
						? "bg-purple-600/20 border border-purple-500/20 text-purple-400 font-semibold shadow-sm" 
						: "text-muted-foreground hover:text-foreground"
				)}
			>
				<Cloud className="size-3" />
				<span>Cloud AI</span>
			</Button>
		</div>
	);
}
