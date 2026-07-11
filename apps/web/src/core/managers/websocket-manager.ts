import type { EditorCore } from "@/core";
import { useEditorStore } from "@/stores/editor-store";
import { toast } from "sonner";

export type ConnectionStatus = "connected" | "disconnected" | "connecting";

export interface WebSocketMessage {
	type: string;
	requestId?: string;
	payload: any;
}

export class WebSocketManager {
	private ws: WebSocket | null = null;
	private status: ConnectionStatus = "disconnected";
	private listeners = new Set<() => void>();
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private pendingRequests = new Map<
		string,
		{
			resolve: (value: any) => void;
			reject: (reason: any) => void;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(private editor: EditorCore) {
		if (typeof window !== "undefined") {
			this.connect();
		}
	}

	getStatus(): ConnectionStatus {
		return this.status;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	sendMessage(type: string, payload: any): void {
		if (!this.ws || this.status !== "connected") {
			console.warn("WebSocket is not connected. Cannot send message:", type);
			return;
		}

		const msg: WebSocketMessage = { type, payload };
		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Send a command to Rust Backend and wait for the response via Promise
	 */
	request(type: string, payload: any): Promise<any> {
		return new Promise((resolve, reject) => {
			if (typeof window === "undefined") {
				reject(new Error("Cannot make WebSocket request on Server Side"));
				return;
			}

			if (!this.ws || this.status !== "connected") {
				reject(new Error("WebSocket is not connected to Rust Backend"));
				return;
			}

			const requestId = Math.random().toString(36).substring(2, 11);
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error(`Request timeout for command: ${type}`));
			}, 10000); // 10 seconds timeout

			this.pendingRequests.set(requestId, { resolve, reject, timeout });

			const msg: WebSocketMessage = {
				type,
				requestId,
				payload,
			};
			
			this.ws.send(JSON.stringify(msg));
		});
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private connect(): void {
		this.disconnect();
		this.status = "connecting";
		this.notify();

		const wsUrl = "ws://127.0.0.1:8000/ws";
		console.log(`Connecting to Rust Backend WebSocket: ${wsUrl}`);

		try {
			this.ws = new WebSocket(wsUrl);

			this.ws.onopen = () => {
				console.log("WebSocket connected to Rust Backend!");
				this.status = "connected";
				this.clearReconnect();
				this.notify();

				// Send initial handshake
				this.sendMessage("HANDSHAKE", {
					client: "nextjs-editor",
					timestamp: Date.now(),
				});
			};

			this.ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					this.handleMessage(data);
				} catch (e) {
					console.error("Failed to parse WebSocket message:", event.data, e);
				}
			};

			this.ws.onclose = () => {
				console.log("WebSocket connection closed.");
				this.status = "disconnected";
				this.notify();
				this.rejectAllPendingRequests("WebSocket connection closed");
				this.scheduleReconnect();
			};

			this.ws.onerror = (error) => {
				console.error("WebSocket connection error:", error);
				// Close handler will trigger reconnect
			};
		} catch (error) {
			console.error("Failed to initialize WebSocket connection:", error);
			this.status = "disconnected";
			this.notify();
			this.scheduleReconnect();
		}
	}

	private disconnect(): void {
		this.clearReconnect();

		if (this.ws) {
			// Remove handlers to prevent infinite reconnection loop
			this.ws.onopen = null;
			this.ws.onmessage = null;
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.close();
			this.ws = null;
		}

		if (this.status !== "disconnected") {
			this.status = "disconnected";
			this.notify();
		}

		this.rejectAllPendingRequests("WebSocket disconnected");
	}

	private scheduleReconnect(): void {
		this.clearReconnect();

		console.log("Scheduling WebSocket reconnect in 5 seconds...");
		this.reconnectTimeout = setTimeout(() => {
			this.connect();
		}, 5000);
	}

	private clearReconnect(): void {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
	}

	private rejectAllPendingRequests(reason: string): void {
		for (const [requestId, pending] of this.pendingRequests.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(reason));
		}
		this.pendingRequests.clear();
	}

	private handleMessage(message: WebSocketMessage): void {
		console.log("Received WS message:", message.type, "RequestId:", message.requestId);

		// 1. If this message is a response to a pending request, resolve/reject the Promise
		if (message.requestId) {
			const pending = this.pendingRequests.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pendingRequests.delete(message.requestId);

				if (message.type === "ERROR") {
					pending.reject(new Error(message.payload));
				} else {
					pending.resolve(message.payload);
				}
				return;
			}
		}

		// 2. Handle server-initiated messages
		switch (message.type) {
			case "CONNECTION_STATUS":
				console.log(`Server status: ${message.payload.message}`);
				break;
			case "MCP_EXECUTE": {
				const ops = message.payload.operations || [];
				if (ops.length === 0) break;

				const tracks = this.editor.timeline.getTracks();
				const videoTrack = tracks.find((t) => t.type === "video");
				const trackId = videoTrack?.id || "video_track";
				const clips = videoTrack?.elements || [];
				const proposedGhostClips: any[] = [];

				ops.forEach((op: any, index: number) => {
					const uuid = `proposed_mcp_${Date.now()}_${index}`;
					if (op.action === "split") {
						proposedGhostClips.push({
							id: uuid,
							trackId: op.track_id || trackId,
							start: op.time,
							end: op.time,
							type: "split",
							label: `Proposed Cut (${op.time.toFixed(1)}s)`,
							operationId: "split",
							isPendingSplit: true,
							isInvalid: false,
							operationData: op,
						});
					} else if (op.action === "delete") {
						const targetClip = clips.find((c) => c.id === op.clip_id);
						if (targetClip) {
							proposedGhostClips.push({
								id: uuid,
								trackId: trackId,
								start: targetClip.startTime,
								end: targetClip.startTime + targetClip.duration,
								type: "delete",
								label: `Remove Clip "${targetClip.name}"`,
								operationId: "delete",
								isPendingDelete: true,
								isInvalid: false,
								originalClipId: targetClip.id,
								operationData: op,
							});
						}
					} else if (op.action === "trim") {
						const targetClip = clips.find((c) => c.id === op.clip_id);
						if (targetClip) {
							const clipStart = targetClip.startTime;
							const clipEnd = clipStart + targetClip.duration;
							
							if (op.start > 0) {
								proposedGhostClips.push({
									id: `${uuid}_trim_l`,
									trackId: trackId,
									start: clipStart,
									end: clipStart + op.start,
									type: "trim_left",
									label: "Trim Out Left",
									operationId: "delete",
									isPendingDelete: true,
									isInvalid: false,
									operationData: { action: "trim_cut", clip_id: op.clip_id, start: 0, end: op.start },
								});
							}
							
							if (op.end < targetClip.duration) {
								proposedGhostClips.push({
									id: `${uuid}_trim_r`,
									trackId: trackId,
									start: clipStart + op.end,
									end: clipEnd,
									type: "trim_right",
									label: "Trim Out Right",
									operationId: "delete",
									isPendingDelete: true,
									isInvalid: false,
									operationData: { action: "trim_cut", clip_id: op.clip_id, start: op.end, end: targetClip.duration },
								});
							}
						}
					} else {
						const targetClip = clips.find((c) => c.id === op.clip_id);
						proposedGhostClips.push({
							id: uuid,
							trackId: trackId,
							start: targetClip?.startTime ?? 0,
							end: targetClip ? targetClip.startTime + targetClip.duration : 5,
							type: op.action,
							label: `Change: ${op.action}`,
							operationId: op.action,
							isPendingDelete: false,
							isPendingSplit: false,
							isInvalid: false,
							operationData: op,
						});
					}
				});

				useEditorStore.getState().setGhostClips(proposedGhostClips);
				toast.success(`Received ${ops.length} proposed edits from AI MCP Server. Confirm on the right sidebar.`);
				break;
			}
			default:
				break;
		}
	}
}
