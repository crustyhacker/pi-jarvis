import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, rgbColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Original ASCII wordmark, shared by the overlay and generated README artwork. */
export const JARVIS_LOGO = [
	String.raw`     _    _    ____ __     _____ ____`,
	String.raw`    | |  / \  |  _ \\ \   / /_ _/ ___|`,
	String.raw` _  | | / _ \ | |_) |\ \ / / | |\___ \ `.trimEnd(),
	String.raw`| |_| |/ ___ \|  _ <  \ V /  | | ___) |`,
	String.raw` \___//_/   \_\_| \_\  \_/  |___|____/`,
] as const;
export const JARVIS_TAGLINE = "PI / A SECOND LANE OF THOUGHT";
export const INTRO_DURATION_MS = 1800;
export const INTRO_FRAME_MS = 50;

const darkPalette = [rgbColor(93, 226, 255), rgbColor(118, 177, 255), rgbColor(191, 138, 255), rgbColor(255, 112, 205), rgbColor(255, 185, 126)];
const lightPalette = [rgbColor(0, 100, 130), rgbColor(38, 67, 160), rgbColor(99, 35, 158), rgbColor(160, 22, 106), rgbColor(146, 58, 6)];
const logoWidth = Math.max(...JARVIS_LOGO.map((line) => line.length));

/** Bounded, stateless frame rendering: no screen clearing, blinking, or terminal commands. */
export function renderJarvisIntro(theme: Theme, width: number, height: number, elapsed: number): string[] {
	width = Math.max(0, Math.floor(width));
	height = Math.max(0, Math.floor(height));
	if (!width || !height) return [];
	const center = (line: string) => {
		const clipped = truncateToWidth(line, width, "", false);
		return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2))) + clipped;
	};
	if (width < logoWidth || height < 8) {
		return [theme.fg("accent", "J A R V I S"), theme.fg("muted", JARVIS_TAGLINE)].slice(0, height).map(center);
	}
	const light = theme.appearance === "light";
	const palette = light ? lightPalette : darkPalette;
	const highlight = light ? rgbColor(12, 20, 64) : rgbColor(255, 250, 255);
	// A single diagonal chrome sweep, not a repeating flash or brightness pulse.
	const sweep = -12 + Math.min(1, Math.max(0, elapsed / INTRO_DURATION_MS)) * (logoWidth + 30);
	const indent = " ".repeat(Math.max(0, Math.floor((width - logoWidth) / 2)));
	const logo = JARVIS_LOGO.map((line, row) => indent + [...line].map((char, col) => {
		if (char === " ") return char;
		const shine = Math.max(0, 1 - Math.abs(col + row * 2 - sweep) / 4);
		return typeof theme.style === "function"
			? theme.style(char, { fg: mixColors(palette[row]!, highlight, shine, "srgb"), bold: true })
			: theme.fg("accent", char);
	}).join(""));
	return [...logo, "", center(theme.fg("accent", JARVIS_TAGLINE)), center(theme.fg("dim", "Type to begin / intro fades automatically"))].slice(0, height);
}

/** Created only for an overlay; starts its unreferenced timer only when drawn. */
export class JarvisIntroAnimation {
	private active: boolean;
	private started?: number;
	private timer?: ReturnType<typeof setInterval>;

	constructor(private readonly redraw: () => void, enabled: boolean, private readonly now = () => performance.now()) {
		this.active = enabled;
	}

	frame(): number | undefined {
		if (!this.active) return undefined;
		if (this.started === undefined) {
			this.started = this.now();
			this.timer = setInterval(() => {
				if (!this.active) return;
				if (this.now() - this.started! >= INTRO_DURATION_MS) this.finish();
				this.redraw();
			}, INTRO_FRAME_MS);
			this.timer.unref?.();
		}
		const elapsed = this.now() - this.started;
		if (elapsed >= INTRO_DURATION_MS) { this.finish(); return undefined; }
		return elapsed;
	}

	/** Idempotent: input, confirmations, errors, and disposal all end the intro. */
	finish(): void {
		this.active = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
