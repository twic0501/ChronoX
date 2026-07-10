"use client";

import { type Tab, useAssetsPanelStore } from "@/stores/assets-panel-store";
import { TabBar } from "./tabbar";
import { Captions } from "./views/captions";
import { MediaView } from "./views/assets";
import { SoundsView } from "./views/sounds";
import { TextView } from "./views/text";
import { EffectsView } from "./views/effects";
import { TransitionsView } from "./views/transitions";
import { MotionView } from "./views/motion";

export function AssetsPanel() {
	const { activeTab } = useAssetsPanelStore();

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		sounds: <SoundsView />,
		text: <TextView />,
		effects: <EffectsView />,
		transitions: <TransitionsView />,
		motion: <MotionView />,
		captions: <Captions />,
	};

	return (
		<div className="panel bg-background flex flex-col h-full rounded-sm border overflow-hidden">
			<TabBar />
			<div className="flex-1 overflow-hidden">{viewMap[activeTab]}</div>
		</div>
	);
}
