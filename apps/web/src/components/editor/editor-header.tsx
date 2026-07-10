"use client";

import { Button } from "../ui/button";
import { useRef, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import Link from "next/link";
import { RenameProjectDialog } from "./dialogs/rename-project-dialog";
import { DeleteProjectDialog } from "./dialogs/delete-project-dialog";
import { useRouter } from "next/navigation";
import { FaDiscord } from "react-icons/fa6";
import { ExportButton } from "./export-button";
import { ThemeToggle } from "../theme-toggle";
import { DEFAULT_LOGO_URL, SOCIAL_LINKS } from "@/constants/site-constants";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import { CommandIcon, Logout05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ShortcutsDialog } from "./dialogs/shortcuts-dialog";
import Image from "next/image";
import { cn } from "@/utils/ui";
import { Save, Cloud, CloudOff } from "lucide-react";
import { AiSearchBar } from "./ai-search-bar";
import { useEditorStore } from "@/stores/editor-store";
import { Sparkles } from "lucide-react";

export function EditorHeader() {
	return (
		<header className="bg-background flex h-[3.4rem] items-center justify-between border-b border-border/60 px-3">
			<div className="flex items-center gap-1">
				<ProjectDropdown />
				<EditableProjectName />
				<AiBriefBadge />
			</div>

			<nav className="flex items-center gap-2">
				<AiActivityPill />
				{/* Status cluster — passive indicators grouped together */}
				<div className="flex items-center gap-1.5">
					<ServerConnectionStatus />
					<AutosaveControls />
				</div>
				<div className="mx-0.5 h-5 w-px bg-border" />
				<ExportButton />
				<ThemeToggle />
			</nav>
		</header>
	);
}

/**
 * The creative brief captured when the project was created — shown as a small
 * violet tag so it's clear the AI is editing with this intent in mind.
 */
function AiBriefBadge() {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const brief = activeProject?.metadata.aiBrief;
	if (!brief) return null;
	const short = brief.split(" — ")[0].split(",")[0];
	return (
		<span
			title={brief}
			className="hidden md:inline-flex items-center gap-1 rounded-md border border-agent/30 bg-agent/10 px-2 py-0.5 font-mono text-[10px] text-agent select-none max-w-[14rem] truncate"
		>
			<Sparkles className="size-2.5 shrink-0" />
			<span className="truncate">{short}</span>
		</span>
	);
}

/**
 * Non-blocking indicator that the AI agent is working. It never disables the
 * editor — the user keeps cutting, dragging and adjusting while it runs — it
 * only reports what the agent is doing right now.
 */
function AiActivityPill() {
	const aiStatus = useEditorStore((e) => e.aiStatus);
	const aiStatusLabel = useEditorStore((e) => e.aiStatusLabel);
	if (aiStatus !== "running") return null;
	return (
		<div className="flex items-center gap-1.5 h-9 px-2.5 rounded-md border border-agent/40 bg-agent/10 select-none animate-in fade-in slide-in-from-right-2">
			<Sparkles className="size-3.5 text-agent animate-pulse" />
			<span className="text-[10px] font-medium text-agent">AI working</span>
			{aiStatusLabel && (
				<span className="text-[10px] text-agent/70 font-mono max-w-[10rem] truncate">
					· {aiStatusLabel}
				</span>
			)}
			<span className="text-[9px] text-muted-foreground/70 border-l border-agent/20 pl-1.5 ml-0.5">
				keep editing
			</span>
		</div>
	);
}

function ServerConnectionStatus() {
	const status = useEditor((e) => e.websocket.getStatus());

	return (
		<div className="flex items-center gap-1.5 px-2.5 py-1 border border-border rounded-md bg-background/40 select-none h-9">
			{status === "connected" && (
				<>
					<span className="relative flex size-2">
						<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-constructive opacity-75" />
						<span className="relative inline-flex rounded-full size-2 bg-constructive" />
					</span>
					<span className="text-[10px] font-medium text-constructive">
						Local Server
					</span>
				</>
			)}
			{status === "connecting" && (
				<>
					<span className="relative flex size-2">
						<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
						<span className="relative inline-flex rounded-full size-2 bg-amber-500" />
					</span>
					<span className="text-[10px] font-medium text-amber-500/90 animate-pulse">
						Connecting...
					</span>
				</>
			)}
			{status === "disconnected" && (
				<>
					<span className="relative inline-flex rounded-full size-2 bg-muted-foreground/50" />
					<span className="text-[10px] font-medium text-muted-foreground">
						Offline
					</span>
				</>
			)}
		</div>
	);
}

function AutosaveControls() {
	const editor = useEditor();
	const [autosave, setAutosave] = useState(() => {
		if (typeof window !== "undefined") {
			return localStorage.getItem("autosave_enabled") !== "false";
		}
		return true;
	});
	const [isSaving, setIsSaving] = useState(false);

	const handleToggleAutosave = () => {
		const nextState = !autosave;
		setAutosave(nextState);
		if (typeof window !== "undefined") {
			localStorage.setItem("autosave_enabled", String(nextState));
		}
		if (nextState) {
			editor.save.resume();
			toast.success("Auto-save enabled");
		} else {
			editor.save.pause();
			toast.info("Auto-save disabled. Save your project manually.");
		}
	};

	const handleManualSave = async () => {
		setIsSaving(true);
		try {
			await editor.project.saveCurrentProject();
			toast.success("Project saved successfully!");
		} catch (err) {
			console.error("Manual save failed:", err);
			toast.error("Failed to save project");
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div className="flex items-center gap-2 border border-border rounded-md p-1 bg-background/40">
			<Button
				variant="text"
				size="sm"
				onClick={handleToggleAutosave}
				className="text-xs h-7 gap-1.5 text-muted-foreground hover:text-foreground px-2 cursor-pointer"
				title={autosave ? "Auto-saving is active" : "Auto-saving is paused"}
			>
				{autosave ? (
					<>
						<Cloud className="size-3.5 text-green-500" />
						<span className="text-[10px] font-medium text-green-500/90">
							Auto-save
						</span>
					</>
				) : (
					<>
						<CloudOff className="size-3.5 text-muted-foreground" />
						<span className="text-[10px] font-medium">Manual</span>
					</>
				)}
			</Button>
			{!autosave && (
				<Button
					variant="outline"
					size="sm"
					onClick={handleManualSave}
					disabled={isSaving}
					className="text-xs h-7 gap-1 px-2 border-border bg-card hover:bg-accent text-foreground cursor-pointer"
				>
					<Save className={cn("size-3.5", isSaving && "animate-spin")} />
					<span className="text-[10px]">Save</span>
				</Button>
			)}
		</div>
	);
}

function ProjectDropdown() {
	const [openDialog, setOpenDialog] = useState<
		"delete" | "rename" | "shortcuts" | null
	>(null);
	const [isExiting, setIsExiting] = useState(false);
	const router = useRouter();
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());

	const handleExit = async () => {
		if (isExiting) return;
		setIsExiting(true);

		try {
			await editor.project.prepareExit();
			editor.project.closeProject();
		} catch (error) {
			console.error("Failed to prepare project exit:", error);
		} finally {
			editor.project.closeProject();
			router.push("/projects");
		}
	};

	const handleSaveProjectName = async (newName: string) => {
		if (
			activeProject &&
			newName.trim() &&
			newName !== activeProject.metadata.name
		) {
			try {
				await editor.project.renameProject({
					id: activeProject.metadata.id,
					name: newName.trim(),
				});
			} catch (error) {
				toast.error("Failed to rename project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			} finally {
				setOpenDialog(null);
			}
		}
	};

	const handleDeleteProject = async () => {
		if (activeProject) {
			try {
				await editor.project.deleteProjects({
					ids: [activeProject.metadata.id],
				});
				router.push("/projects");
			} catch (error) {
				toast.error("Failed to delete project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			} finally {
				setOpenDialog(null);
			}
		}
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						className="p-1.5 px-2.5 rounded-md h-9 gap-2 select-none"
					>
						<Image
							src={DEFAULT_LOGO_URL}
							alt="Project thumbnail"
							width={24}
							height={24}
							className="bg-white rounded-xs p-0.5 size-5.5 object-contain"
						/>
						<span className="font-orbitron font-bold text-xs tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-amber-500 to-amber-600 dark:from-amber-400 dark:to-orange-500">
							CHRONOX
						</span>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="z-100 w-44">
					<DropdownMenuItem
						onClick={handleExit}
						disabled={isExiting}
						icon={<HugeiconsIcon icon={Logout05Icon} />}
					>
						Exit project
					</DropdownMenuItem>

					<DropdownMenuItem
						onClick={() => setOpenDialog("shortcuts")}
						icon={<HugeiconsIcon icon={CommandIcon} />}
					>
						Shortcuts
					</DropdownMenuItem>

					<DropdownMenuSeparator />

					<DropdownMenuItem asChild icon={<FaDiscord className="size-4!" />}>
						<Link
							href={SOCIAL_LINKS.discord}
							target="_blank"
							rel="noopener noreferrer"
						>
							Discord
						</Link>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<RenameProjectDialog
				isOpen={openDialog === "rename"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "rename" : null)}
				onConfirm={(newName) => handleSaveProjectName(newName)}
				projectName={activeProject?.metadata.name || ""}
			/>
			<DeleteProjectDialog
				isOpen={openDialog === "delete"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "delete" : null)}
				onConfirm={handleDeleteProject}
				projectNames={[activeProject?.metadata.name || ""]}
			/>
			<ShortcutsDialog
				isOpen={openDialog === "shortcuts"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "shortcuts" : null)}
			/>
		</>
	);
}

function EditableProjectName() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const [isEditing, setIsEditing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const originalNameRef = useRef("");

	const projectName = activeProject?.metadata.name || "";

	const startEditing = () => {
		if (isEditing) return;
		originalNameRef.current = projectName;
		setIsEditing(true);

		requestAnimationFrame(() => {
			inputRef.current?.select();
		});
	};

	const saveEdit = async () => {
		if (!inputRef.current || !activeProject) return;
		const newName = inputRef.current.value.trim();
		setIsEditing(false);

		if (!newName) {
			inputRef.current.value = originalNameRef.current;
			return;
		}

		if (newName !== originalNameRef.current) {
			try {
				await editor.project.renameProject({
					id: activeProject.metadata.id,
					name: newName,
				});
			} catch (error) {
				toast.error("Failed to rename project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			}
		}
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			inputRef.current?.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			if (inputRef.current) {
				inputRef.current.value = originalNameRef.current;
				inputRef.current.setSelectionRange(0, 0);
			}
			setIsEditing(false);
			inputRef.current?.blur();
		}
	};

	return (
		<input
			ref={inputRef}
			type="text"
			defaultValue={projectName}
			readOnly={!isEditing}
			onClick={startEditing}
			onBlur={saveEdit}
			onKeyDown={handleKeyDown}
			style={{ fieldSizing: "content" }}
			className={cn(
				"text-[0.9rem] h-8 px-2 py-1 rounded-sm bg-transparent outline-none cursor-pointer hover:bg-accent hover:text-accent-foreground",
				isEditing && "ring-1 ring-ring cursor-text hover:bg-transparent",
			)}
		/>
	);
}
