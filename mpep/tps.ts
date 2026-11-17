import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCompactDuration } from "./shared/duration.ts";
import { getLocale, t } from "./shared/i18n/index.ts";
import { isPluginEnabled } from "./manager/preferences.ts";

export default function (pi: ExtensionAPI) {
	if (!isPluginEnabled("tps")) return;
	let agentStartMs: number | null = null;

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;

		for (const message of event.messages) {
			if (message.role !== "assistant") continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		const message = t("tps.report", {
			tps: tokensPerSecond.toFixed(1), output: output.toLocaleString(getLocale()),
			input: input.toLocaleString(getLocale()), cacheRead: cacheRead.toLocaleString(getLocale()),
			cacheWrite: cacheWrite.toLocaleString(getLocale()), total: totalTokens.toLocaleString(getLocale()),
			elapsed: formatCompactDuration(elapsedSeconds),
		});
		ctx.ui.notify(message, "info");
	});
}
