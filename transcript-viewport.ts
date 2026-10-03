import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

export interface TranscriptViewportStatus {
	following: boolean;
	hiddenBelow: number;
	totalLines: number;
	/** Zero-based, inclusive input-row index. */
	startLine: number;
	/** Zero-based, exclusive input-row index. */
	endLine: number;
}

// Anchor work stays bounded even if the caller supplies a very large transcript.
const ANCHOR_CHAR_LIMIT = 512;
const ANCHOR_RAW_LIMIT = 2048;
const ANCHOR_SEARCH_RADIUS = 256;

/**
 * A line viewport for overlays in either Pi renderer. Unlike public ScrollView,
 * this does not require an alternate-screen layout root or render a child history.
 *
 * Supply sanitized, already-wrapped terminal rows (including a speaker prefix on
 * each row when desired). Only visible rows are ANSI-aware truncated, not wrapped,
 * themed or padded. All supplied history is reachable; there is no history cap.
 * The caller owns source/layout bounds. This helper retains neither the array nor
 * a layout cache: state is O(1), with one anchor of at most 512 UTF-16 code units.
 * Normal renders read O(height) rows; width/source shifts may inspect at most
 * 513 extra rows, with at most 2048 code units per anchor candidate.
 *
 * Paused append/stream updates preserve the top index. A shifted bounded source
 * is re-anchored nearby when the previous top row can still be found. Height
 * changes clamp that index without resuming follow. Width changes find the top row
 * near its proportional new position (exact or shared-prefix match), then fall
 * back to the old index. Reflow cannot be perfectly anchored without source IDs.
 * Call reset() on thread/branch replacement, including same-length replacements.
 */
export class TranscriptViewport {
	private following = true;
	private totalLines = 0;
	private startLine = 0;
	private endLine = 0;
	private height = 0;
	private width = 0;
	private anchor?: { index: number; text: string };

	render(lines: readonly string[], height: number, width: number): string[] {
		height = dimension(height);
		width = dimension(width);
		const previousTotal = this.totalLines;
		const previousWidth = this.width;
		this.totalLines = lines.length;
		this.height = width > 0 ? height : 0;
		this.width = width;

		if (lines.length === 0) {
			this.following = true;
			this.anchor = undefined;
		} else if (!this.following && width > 0 && previousWidth > 0 && width !== previousWidth
			&& this.anchor?.index === this.startLine) {
			this.restoreAnchor(lines, previousTotal);
		} else if (!this.following && this.anchor?.index === this.startLine && width > 0
			&& anchorText(lines[this.startLine] ?? "") !== this.anchor.text) {
			// A caller's bounded history can evict older rows during an append.
			// Search near the old index, not a resize-proportional position.
			this.restoreAnchor(lines, lines.length);
		}
		this.updateRange();

		const visible: string[] = [];
		for (let i = this.startLine; i < this.endLine; i++) {
			visible.push(truncateToWidth(lines[i]!.replace(/[\r\n]/g, " "), width, ""));
		}
		// Keep only a small, unstyled anchor, never the source row or returned array.
		if (visible.length > 0) {
			const text = anchorText(visible[0]!);
			this.anchor = text ? { index: this.startLine, text } : undefined;
		}
		return visible;
	}

	/** Pause and move one last-rendered viewport height toward older rows. */
	pageUp(): void {
		if (this.totalLines === 0) return;
		this.following = false;
		this.startLine = Math.max(0, this.startLine - Math.max(1, this.height));
		this.anchor = undefined;
		this.updateRange();
	}

	/** Move one page toward the tail; reaching it explicitly resumes following. */
	pageDown(): void {
		this.startLine = Math.min(this.latestStart(), this.startLine + Math.max(1, this.height));
		if (this.startLine === this.latestStart()) this.following = true;
		this.anchor = undefined;
		this.updateRange();
	}

	toLatest(): void {
		this.following = true;
		this.anchor = undefined;
		this.updateRange();
	}

	/** Forget both content dimensions and scroll state for a new conversation. */
	reset(): void {
		this.following = true;
		this.totalLines = this.startLine = this.endLine = this.height = this.width = 0;
		this.anchor = undefined;
	}

	/** Reflects the last render, or navigation against that render's dimensions. */
	getStatus(): TranscriptViewportStatus {
		return {
			following: this.following,
			hiddenBelow: this.totalLines - this.endLine,
			totalLines: this.totalLines,
			startLine: this.startLine,
			endLine: this.endLine,
		};
	}

	private latestStart(): number {
		return Math.max(0, this.totalLines - this.height);
	}

	private updateRange(): void {
		this.startLine = this.following ? this.latestStart() : Math.min(this.startLine, this.latestStart());
		this.endLine = Math.min(this.totalLines, this.startLine + this.height);
	}

	private restoreAnchor(lines: readonly string[], previousTotal: number): void {
		const text = this.anchor!.text;
		const target = Math.min(lines.length - 1,
			Math.floor(this.startLine * lines.length / Math.max(1, previousTotal)));
		const first = Math.max(0, target - ANCHOR_SEARCH_RADIUS);
		const last = Math.min(lines.length - 1, target + ANCHOR_SEARCH_RADIUS);
		let bestIndex: number | undefined;
		let bestExact = false;
		let bestDistance = Infinity;
		for (let i = first; i <= last; i++) {
			const candidate = anchorText(lines[i]!);
			const exact = candidate === text;
			// Avoid anchoring all rows to a short speaker label after a narrow resize.
			const sharedPrefix = Math.min(candidate.length, text.length) >= 12
				&& (candidate.startsWith(text) || text.startsWith(candidate));
			if (!exact && !sharedPrefix) continue;
			const distance = Math.abs(i - target);
			if ((exact && !bestExact) || (exact === bestExact && distance < bestDistance)) {
				bestIndex = i;
				bestExact = exact;
				bestDistance = distance;
			}
		}
		if (bestIndex !== undefined) this.startLine = bestIndex;
	}
}

function anchorText(line: string): string {
	return stripTerminalSequences(line.slice(0, ANCHOR_RAW_LIMIT))
		.replace(/[\r\n]/g, " ").slice(0, ANCHOR_CHAR_LIMIT).trimEnd();
}

function dimension(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
