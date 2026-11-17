/**
 * Formats a non-negative duration in seconds using compact h/m/s units.
 * Rolls over at 60 seconds into minutes and 60 minutes into hours without
 * rolling over into days (e.g. 12 -> "12s", 90 -> "1m30s", 5445 -> "1h30m45s").
 */
export function formatCompactDuration(totalSeconds: number): string {
	const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours > 0) return `${hours}h${minutes}m${secs}s`;
	if (minutes > 0) return `${minutes}m${secs}s`;
	return `${secs}s`;
}
