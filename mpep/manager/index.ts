import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../shared/i18n/index.ts";
import { ManagerPanel } from "./panel.ts";
import { loadRegistry, writePluginStates, type RegistryItem } from "./preferences.ts";
import { disablePathLinkHyperlinks, enablePathLinkHyperlinks } from "../path-links/hyperlinks.ts";
import { installTheme, uninstallTheme } from "../theme-distributor.ts";

// Registry IDs and fallback metadata stay compatible with existing installations.
const builtinIds = [
	"turn-fold",
	"markdown-enhancer",
	"path-links",
	"terminal-interaction",
	"turn-navigator",
	"cooking-timer",
	"list",
	"statusline",
	"tps",
	"turn-notify",
	"usage",
	"export",
	"theme-distributor",
	"compact-forewarn",
	"drop-useless-reasoning-item-before-compact",
	"stderr-guard",
	"user-bubble",
	"responses-ws",
	"retry-error-normalizer",
	"responses-OpenAI-offical-search",
	"tips",
] as const;

// Lifecycle hooks: some plugins own files outside mpep-cache and must clean up
// (or set up) when toggled, instead of just self-gating on next load.
// Hooks receive the new enabled state of the toggled plugin.
type ToggleHook = (enabled: boolean) => string | undefined;
const toggleHooks: Partial<Record<string, ToggleHook>> = {
	"theme-distributor": (enabled) => enabled ? installTheme() : uninstallTheme(),
	"path-links": (enabled) => {
		if (enabled) enablePathLinkHyperlinks();
		else disablePathLinkHyperlinks();
		return undefined;
	},
};
function display(item: RegistryItem): { name: string; desc: string } {
	const id = builtinIds.find(id => id === item.id);
	return id ? { name: t(`plugin.${id}.name`), desc: t(`plugin.${id}.desc`) } : item;
}

async function handleManagerCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmedArgs = (args || "").trim();
	const subArgs = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
	const subCommand = subArgs[0]?.toLowerCase();

	const items = loadRegistry();
	if (items.length === 0) {
		ctx.ui.notify(t("manager.missingRegistry"), "error");
		return;
	}

	// Command-line argument support: /m-mng list
	if (subCommand === "list") {
		const lines = items.map((item) => {
			const mark = item.enabled ? `[✓ ${t("manager.enabled")}]` : `[  ${t("manager.disabled")}]`;
			const label = display(item);
			return `${mark} ${item.id.padEnd(16)} - ${label.name} (${label.desc})`;
		});
		ctx.ui.notify(t("manager.status", { lines: lines.join("\n") }), "info");
		return;
	}

	// Command-line argument support: /m-mng enable|disable <id>
	if ((subCommand === "enable" || subCommand === "disable") && subArgs[1]) {
		const targetId = subArgs[1].toLowerCase();
		const target = items.find((i) => i.id.toLowerCase() === targetId);
		if (!target) {
			ctx.ui.notify(t("manager.unknownId", { id: targetId }), "warning");
			return;
		}
		target.enabled = subCommand === "enable";
		writePluginStates({ [target.id]: target.enabled });
		toggleHooks[target.id]?.(target.enabled);
		ctx.ui.notify(t("manager.toggled", { state: t(target.enabled ? "manager.enabled" : "manager.disabled"), name: display(target).name }), "info");
		return;
	}

	// Interactive menu mode
	if (!ctx.hasUI) {
		ctx.ui.notify(t("manager.requiresUI"), "warning");
		return;
	}

	let hasChanged = false;
	const panelItems = items.map(item => ({ ...item, ...display(item) }));
	await ctx.ui.custom<void>(
		(tui, theme, keys, done) => new ManagerPanel({
			items: panelItems,
			theme,
			rows: () => tui.terminal.rows,
			matches: (data, action) => keys.matches(data, action),
			close: () => done(),
			change: (changes, toggledId) => {
				try {
					writePluginStates(changes);
					// Keep the open panel in sync with disk, even if a lifecycle hook fails.
					for (const item of panelItems) {
						if (Object.hasOwn(changes, item.id)) item.enabled = changes[item.id];
					}
					hasChanged = true;
					if (toggledId) toggleHooks[toggledId]?.(changes[toggledId]);
				} catch (error) {
					ctx.ui.notify(t("manager.saveFailed", {
						error: error instanceof Error ? error.message : String(error),
					}), "error");
				}
			},
		}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "100%",
				maxHeight: "100%",
				margin: { left: 1, right: 1 },
			},
		},
	);

	if (hasChanged) {
		ctx.ui.notify(t("manager.updated"), "info");
	}
}

export default function managerExtension(pi: ExtensionAPI) {
	pi.registerCommand("m-mng", {
		description: t("manager.description"),
		handler: async (args, ctx) => {
			try {
				await handleManagerCommand(args, ctx);
			} catch (error) {
				ctx.ui.notify(t("manager.saveFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
			}
		},
	});
}
