/** Ask the operating system to open a local path using its registered application. */
import { spawn } from "node:child_process";

export function openLocalPath(target: string): Promise<void> {
	const [command, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	return new Promise((resolve, reject) => {
		// Pass the path as an argument, never through a shell: spaces and shell
		// metacharacters in a Git filename must remain ordinary filename text.
		const child = spawn(command, args, {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		child.once("error", error => {
			// A missing launcher is not a missing target file. Keep its ENOENT
			// in the cause so callers can distinguish opening from lstat failures.
			reject(new Error("Could not start the system file opener.", { cause: error }));
		});
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`The system file opener exited with ${signal ?? code ?? "an unknown status"}.`));
			}
		});
		// The editor must be free to exit even if an application picker remains open.
		child.unref();
	});
}
