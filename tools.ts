/**
 * Tools Extension
 * Adapted from https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/tools.ts
 *
 * Provides /tools to enable/disable tools and /ask or Alt+A to toggle questions.
 * The stats footer shows [Ask On] while interactive questions are enabled.
 * /ask keeps declarations fixed and announces mode changes before the next request.
 * Tool selection and question mode persist across reloads and branch navigation.
 *
 * Loaded alongside index.ts by this package's pi.extensions manifest.
 * Use /tools to open the tool selector, or /ask [on|off|status] / Alt+A
 * to control the ask_user tool.
 */

import { randomUUID } from "node:crypto";
import type {
	ContextWithSystemEvent,
	CustomMessageEntry,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { installAskFooter } from "./footer";

// State persisted to session
interface ToolsState {
	enabledTools: string[];
	askEnabled?: boolean;
}

type AskState = "on" | "off" | "unavailable";
interface AskAnnouncement {
	id: string;
	state: AskState;
}
const ASK_STATE = "ask-user-availability";
const ASK_BLOCKED = "ask-user-blocked";
const DISABLED = "Interactive questions disabled.";

function announcement(details: unknown): AskAnnouncement | undefined {
	const value = details as Partial<AskAnnouncement> | undefined;
	return value && typeof value.id === "string" &&
		(value.state === "on" || value.state === "off" || value.state === "unavailable")
		? value as AskAnnouncement : undefined;
}

/**
 * Compaction may hide an announcement while retaining the local tools-config.
 * Carry the last announcement from the folded history beside its summary. Its
 * position and content come from saved entries, never the current toggle value:
 * later toggles must not rewrite the prefix the model has already seen.
 * context_with_system runs after ACM's context filter, in either load order.
 */
function retainCompactedAnnouncements(event: ContextWithSystemEvent, ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	const before = new Map<string, CustomMessageEntry | undefined>();
	let latest: CustomMessageEntry | undefined;
	for (const entry of branch) {
		before.set(entry.id, latest);
		if (entry.type === "custom_message" && entry.customType === ASK_STATE && announcement(entry.details)) {
			latest = entry;
		}
	}
	const summaryKey = (message: ContextWithSystemEvent["messages"][number]) => {
		if (message.role === "compactionSummary") return `native:${message.timestamp}`;
		if (message.role === "branchSummary") return `branch:${message.timestamp}:${message.fromId}`;
		if (message.role === "custom" && message.customType === "pi-context-compaction") {
			return `acm:${message.timestamp}:${JSON.stringify(message.details)}`;
		}
	};
	const carried = new Map<string, CustomMessageEntry>();
	for (const projected of ctx.sessionManager.buildSessionProjection().entries) {
		const entry = projected.sourceEntry;
		const cutoff = entry.type === "compaction" ? entry.firstKeptEntryId ?? entry.id :
			entry.type === "branch_summary" ||
			(entry.type === "custom_message" && entry.customType === "pi-context-compaction") ? entry.id : undefined;
		const saved = cutoff ? before.get(cutoff) : undefined;
		if (saved) for (const message of projected.messages) {
			const key = summaryKey(message);
			if (key) carried.set(key, saved);
		}
	}
	const present = new Set(event.messages.flatMap((message) => {
		const saved = message.role === "custom" && message.customType === ASK_STATE ? announcement(message.details) : undefined;
		return saved ? [saved.id] : [];
	}));
	let changed = false;
	const messages = event.messages.flatMap((message) => {
		const key = summaryKey(message);
		const saved = key ? carried.get(key) : undefined;
		if (!saved) return [message];
		const id = announcement(saved.details)!.id;
		if (present.has(id)) return [message];
		present.add(id);
		changed = true;
		return [message, ...sessionEntryToContextMessages(saved)];
	});
	return changed ? { messages } : undefined;
}

export default function toolsExtension(pi: ExtensionAPI) {
	const setFooterEnabled = installAskFooter();
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];
	let askEnabled = false;

	// Custom session entries do not enter model context.
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: pi.getActiveTools(),
			askEnabled,
		});
	}

	function currentAskState(): AskState {
		return pi.getActiveTools().includes("ask_user") ? (askEnabled ? "on" : "off") : "unavailable";
	}

	function pendingAnnouncement(ctx: ExtensionContext): CustomMessageEntryDraft | undefined {
		const state = currentAskState();
		let previous: AskState = "on"; // The unchanged tool definition already permits questions.
		let blockedAfterAnnouncement = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom_message" && entry.customType === ASK_STATE) {
				const saved = announcement(entry.details);
				if (saved) {
					previous = saved.state;
					blockedAfterAnnouncement = false;
				}
			} else if (entry.type === "custom" && entry.customType === ASK_BLOCKED) {
				blockedAfterAnnouncement = true;
			} else if (entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolName === "ask_user" && entry.message.isError &&
				entry.message.content.some((block) => block.type === "text" && block.text === DISABLED)) {
				blockedAfterAnnouncement = true;
			}
		}
		// A rejection is newer evidence even if off -> on returned to the old mode.
		if (state === previous && !(state === "on" && blockedAfterAnnouncement)) return;
		const content = state === "on"
			? "Interactive questions are ON. ask_user is available again; earlier disabled results no longer apply. Use it when a user decision is needed."
			: state === "off"
				? "Interactive questions are OFF. Do not call ask_user while this mode is off. Continue with the available information; if a user decision is essential, explain what is needed in your response."
				: "ask_user is currently unavailable in the active tool selection. Do not call it until a later availability update.";
		return { type: "custom_message", customType: ASK_STATE, content, display: false,
			details: { id: randomUUID(), state } satisfies AskAnnouncement };
	}

	function updateAskStatus(ctx: ExtensionContext) {
		const state = currentAskState();
		setFooterEnabled(state === "on" && ctx.mode === "tui");
		// Request a render and clear the old separate status row.
		ctx.ui.setStatus("interactive-questions", undefined);
		return state;
	}

	// Apply current tool selection and display the actual state.
	function applyTools(ctx: ExtensionContext) {
		pi.setActiveTools(Array.from(enabledTools));
		enabledTools = new Set(pi.getActiveTools());
		updateAskStatus(ctx);
	}

	function toggleAsk(ctx: ExtensionContext, enabled?: boolean) {
		if (!pi.getAllTools().some((tool) => tool.name === "ask_user")) {
			updateAskStatus(ctx);
			ctx.ui.notify("ask_user is unavailable. Load pi-ask-user first.", "warning");
			return;
		}

		if (!pi.getActiveTools().includes("ask_user")) {
			updateAskStatus(ctx);
			ctx.ui.notify("ask_user is inactive. Enable it with /tools first.", "warning");
			return;
		}

		const next = enabled ?? !askEnabled;
		if (next !== askEnabled) {
			askEnabled = next;
			persistState();
		}
		updateAskStatus(ctx);
		ctx.ui.notify(`Interactive questions ${askEnabled ? "on" : "off"}.`, "info");
	}

	// Find the last tools-config entry in the current branch
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedState: ToolsState | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedState = data;
				}
			}
		}

		askEnabled = savedState ? (savedState.askEnabled ?? savedState.enabledTools.includes("ask_user")) : false;
		if (savedState) {
			// Restore saved tool selection (filter to only tools that still exist).
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedState.enabledTools.filter((t: string) => allToolNames.includes(t)));
			// Migrate the old /ask-off state: keep the definition, block execution locally.
			if (savedState.askEnabled === undefined && allToolNames.includes("ask_user")) {
				enabledTools.add("ask_user");
			}
			applyTools(ctx);
		} else {
			// No saved state - sync with currently active tools
			enabledTools = new Set(pi.getActiveTools());
			updateAskStatus(ctx);
		}
	}

	pi.registerCommand("ask", {
		description: "Toggle interactive questions (/ask [on|off|status])",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.toLowerCase()))
				.map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			switch (args.trim().toLowerCase()) {
				case "":
					toggleAsk(ctx);
					break;
				case "on":
					toggleAsk(ctx, true);
					break;
				case "off":
					toggleAsk(ctx, false);
					break;
				case "status":
					ctx.ui.notify(`Interactive questions ${updateAskStatus(ctx)}.`, "info");
					break;
				default:
					ctx.ui.notify("Usage: /ask [on|off|status]", "warning");
			}
		},
	});

	pi.registerShortcut("alt+a", {
		description: "Toggle interactive questions",
		handler: async (ctx) => toggleAsk(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "ask_user" && !askEnabled) {
			// Nested calls (e.g. codemode) have no separate saved ask_user result.
			pi.appendEntry(ASK_BLOCKED, { toolCallId: event.toolCallId });
			return { block: true, reason: DISABLED };
		}
	});

	// /tools still manages declarations; /ask only controls question execution.
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// Refresh tool list and selection, including changes from other extensions.
			allTools = pi.getAllTools();
			enabledTools = new Set(pi.getActiveTools());

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately.
						enabledTools = new Set(pi.getActiveTools());
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools(ctx);
						persistState();
					},
					() => {
						// Close dialog
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					// Newer Pi hosts use this flag to send PageUp/PageDown to the list.
					capturesViewportInput: (settingsList as SettingsList & { capturesViewportInput?: boolean })
						.capturesViewportInput,
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		updateAskStatus(ctx);
		const message = pendingAnnouncement(ctx);
		// Returning `message`, or using nextTurn, places it AFTER the user prompt.
		// Context-only messages sent here are flushed BEFORE the starting prompt.
		if (message) pi.sendMessage(message, { triggerTurn: false });
	});
	pi.on("turn_end", async (event, ctx) => {
		updateAskStatus(ctx);
		// A live toggle takes effect immediately in tool_call. Announce it at the
		// closed tool boundary, before queued input, only if another request follows.
		if (event.outcome !== "completed" || ctx.signal?.aborted ||
			(!event.toolResults.length && !event.continue && !event.context.pendingMessages.length)) return;
		const message = pendingAnnouncement(ctx);
		if (message) return { entries: [...event.entries, message] };
	});
	pi.on("context_with_system", retainCompactedAnnouncements);
	pi.on("session_shutdown", async (_event, ctx) => {
		setFooterEnabled(false);
		ctx.ui.setStatus("interactive-questions", undefined);
	});
}
