"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import {
	TAB_KEYS,
	tabs,
	useAssetsPanelStore,
} from "@/stores/assets-panel-store";

/** Short labels so they fit under the icon in the 60px rail. */
const RAIL_LABELS: Record<(typeof TAB_KEYS)[number], string> = {
	media: "Media",
	sounds: "Audio",
	text: "Text",
	effects: "Effects",
	transitions: "Trans.",
	motion: "Motion",
	captions: "Caption",
};

export function TabBar() {
	const { activeTab, setActiveTab } = useAssetsPanelStore();
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	const scroll = (direction: "left" | "right") => {
		if (scrollContainerRef.current) {
			const scrollAmount = 120;
			scrollContainerRef.current.scrollBy({
				left: direction === "left" ? -scrollAmount : scrollAmount,
				behavior: "smooth",
			});
		}
	};

	return (
		<div className="relative bg-card/40 flex w-full shrink-0 flex-row items-center border-b border-border/60 h-[56px] px-1">
			<Button
				variant="ghost"
				size="icon"
				onClick={() => scroll("left")}
				className="h-8 w-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent/40"
			>
				<ChevronLeft className="size-4" />
			</Button>

			<div
				ref={scrollContainerRef}
				className="scrollbar-hidden flex flex-1 flex-row items-center gap-2 overflow-x-auto px-1 py-1.5 scroll-smooth"
			>
				{TAB_KEYS.map((tabKey) => {
					const tab = tabs[tabKey];
					const isActive = activeTab === tabKey;
					return (
						<Button
							key={tabKey}
							variant="ghost"
							aria-label={tab.label}
							onClick={() => setActiveTab(tabKey)}
							className={cn(
								"group relative flex h-[44px] w-[56px] shrink-0 flex-col items-center justify-center gap-1 rounded-[8px] p-0 transition-colors",
								isActive
									? "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary"
									: "text-muted-foreground hover:bg-accent hover:text-foreground",
							)}
						>
							{isActive && (
								<span className="bg-primary absolute bottom-0.5 left-1/2 h-[3px] w-5 -translate-x-1/2 rounded-full" />
							)}
							<tab.icon className="size-[18px]" />
							<span className="text-[8px] font-semibold leading-none tracking-wide">
								{RAIL_LABELS[tabKey]}
							</span>
						</Button>
					);
				})}
			</div>

			<Button
				variant="ghost"
				size="icon"
				onClick={() => scroll("right")}
				className="h-8 w-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent/40"
			>
				<ChevronRight className="size-4" />
			</Button>
		</div>
	);
}
