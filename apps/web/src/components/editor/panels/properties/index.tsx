"use client";

import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { usePropertiesStore } from "./stores/properties-store";
import { getPropertiesConfig } from "./registry";
import { cn } from "@/utils/ui";
import { EmptyView } from "./empty-view";
import { ChatSidebar } from "./chat-sidebar";
import { MimicTab } from "./tabs/mimic-tab";

function PanelTabButton({
	active,
	accent,
	disabled,
	onClick,
	children,
}: {
	active: boolean;
	accent?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"flex-1 rounded-md px-1.5 py-1.5 text-[11px] font-medium whitespace-nowrap transition-colors",
				"disabled:cursor-not-allowed disabled:opacity-40",
				active
					? accent
						? "bg-card text-agent shadow-sm shadow-black/20"
						: "bg-card text-foreground shadow-sm shadow-black/20"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

export function PropertiesPanel() {
	const editor = useEditor();
	useEditor((e) => e.timeline.getTracks());
	useEditor((e) => e.media.getAssets());
	const { selectedElements } = useElementSelection();
	const { activeTabPerType, setActiveTab } = usePropertiesStore();

	const [activePanelTab, setActivePanelTab] = useState<
		"ai" | "mimic" | "properties"
	>("ai");

	// Automatically switch properties tab when a clip is selected, and return to AI tab when deselected
	useEffect(() => {
		if (selectedElements.length === 1) {
			setActivePanelTab("properties");
		} else if (selectedElements.length === 0) {
			if (activePanelTab === "properties") {
				setActivePanelTab("ai");
			}
		}
	}, [selectedElements.length]);

	const renderContent = () => {
		if (activePanelTab === "ai") {
			return <ChatSidebar />;
		}
		if (activePanelTab === "mimic") {
			return <MimicTab />;
		}

		// properties tab
		if (selectedElements.length === 0) {
			return <EmptyView />;
		}
		if (selectedElements.length > 1) {
			return (
				<div className="flex-1 flex flex-col items-center justify-center p-4">
					<p className="text-muted-foreground text-sm">
						{selectedElements.length} elements selected.
					</p>
				</div>
			);
		}

		const mediaAssets = editor.media.getAssets();
		const elementsWithTracks = editor.timeline.getElementsWithTracks({
			elements: selectedElements,
		});
		const elementWithTrack = elementsWithTracks[0];

		if (!elementWithTrack) return <EmptyView />;

		const { element, track } = elementWithTrack;
		const config = getPropertiesConfig({ element, mediaAssets });
		const visibleTabs = config.tabs;

		const storedTabId = activeTabPerType[element.type];
		const isStoredTabVisible = visibleTabs.some((t) => t.id === storedTabId);
		const activeTabId = isStoredTabVisible ? storedTabId : config.defaultTab;
		const activeTab =
			visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[0];

		if (!activeTab) return <EmptyView />;

		return (
			<div className="flex-1 min-h-0 flex overflow-hidden">
				<TooltipProvider delayDuration={0}>
					<div className="flex shrink-0 flex-col gap-0.5 border-r p-1 scrollbar-hidden overflow-y-auto bg-accent/5">
						{visibleTabs.map((tab) => (
							<Tooltip key={tab.id}>
								<TooltipTrigger asChild>
									<Button
										variant={tab.id === activeTab.id ? "secondary" : "ghost"}
										size="icon"
										onClick={() => setActiveTab(element.type, tab.id)}
										aria-label={tab.label}
										className={cn(
											"shrink-0",
											"h-8 w-8",
											tab.id !== activeTab.id && "text-muted-foreground",
										)}
									>
										{tab.icon}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="right">{tab.label}</TooltipContent>
							</Tooltip>
						))}
					</div>
				</TooltipProvider>
				<ScrollArea className="flex-1 scrollbar-hidden">
					{activeTab.content({ trackId: track.id })}
				</ScrollArea>
			</div>
		);
	};

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			<div className="shrink-0 p-1.5">
				<div className="bg-muted/50 border-border/60 flex gap-1 rounded-lg border p-1">
					<PanelTabButton
						active={activePanelTab === "ai"}
						onClick={() => setActivePanelTab("ai")}
						accent
					>
						AI Agent
					</PanelTabButton>
					<PanelTabButton
						active={activePanelTab === "mimic"}
						onClick={() => setActivePanelTab("mimic")}
					>
						Mimic
					</PanelTabButton>
					<PanelTabButton
						active={activePanelTab === "properties"}
						disabled={selectedElements.length === 0}
						onClick={() => setActivePanelTab("properties")}
					>
						Props
					</PanelTabButton>
				</div>
			</div>
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
				{renderContent()}
			</div>
		</div>
	);
}
