// CI-only refresh/retry wrapper. Local check-tags.mjs never fetches or modifies refs.
import { checkTags, git, options } from "./check-tags.mjs";

try {
	const opts = options(process.argv.slice(2), ["--head", "--baseline", "--fork", "--attempts", "--delay-ms"]);
	const attempts = Number(opts["--attempts"] ?? 6);
	const delay = Number(opts["--delay-ms"] ?? 10000);
	if (!Number.isInteger(attempts) || attempts < 1 || attempts > 12 || !Number.isInteger(delay) || delay < 0 || delay > 30000) {
		throw new Error("Invalid retry bounds (attempts 1–12, delay-ms 0–30000)");
	}
	const fork = opts["--fork"];
	if (fork && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(fork)) throw new Error("Invalid fork owner/repository");
	const prefix = "refs/policy/fork-tags/";
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			// Isolated action checkout: refresh even deleted/moved tags; never trust cached tags.
			git("fetch", "--no-recurse-submodules", "--force", "--prune", "origin", "+refs/tags/*:refs/tags/*");
			if (fork) git("fetch", "--no-tags", "--no-recurse-submodules", "--force", "--prune", `https://github.com/${fork}.git`, `+refs/tags/*:${prefix}*`);
			const result = checkTags({ head: opts["--head"], baseline: opts["--baseline"], tagPrefix: fork ? prefix : undefined });
			console.log(`Tag policy passed: ${result.checked} post-baseline commits checked`);
			break;
		} catch (error) {
			if (attempt === attempts) throw error;
			console.error(`Tags not ready (${attempt}/${attempts}): ${error.message}\nRetrying after ${delay}ms; push commits and tags atomically to avoid this wait.`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
		}
	}
} catch (error) { console.error(error.message); process.exitCode = 1; }
