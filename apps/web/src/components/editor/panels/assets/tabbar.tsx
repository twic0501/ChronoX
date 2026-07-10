"use client";

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

	return (
		<div className="scrollbar-hidden bg-card/40 flex w-[60px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border/60 py-3">
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
							"group relative flex h-[46px] w-[46px] flex-col items-center justify-center gap-1 rounded-[10px] p-0 transition-colors",
							isActive
								? "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary"
								: "text-muted-foreground hover:bg-accent hover:text-foreground",
						)}
					>
						{isActive && (
							<span className="bg-primary absolute -left-1.5 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full" />
						)}
						<tab.icon className="size-[19px]" />
						<span className="text-[8px] font-semibold leading-none tracking-wide">
							{RAIL_LABELS[tabKey]}
						</span>
					</Button>
				);
			})}
		</div>
	);
}
