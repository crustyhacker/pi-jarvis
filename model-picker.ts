import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, Input, SelectList, isKeyRelease, matchesKey, parseKey, sliceByColumn, truncateToWidth, visibleWidth,
	type Component, type Focusable, type KeybindingsManager,
	type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { JarvisDraftEditor } from "./draft-editor.js";

export interface JarvisPickerChoice { value: string; label: string }

/** Searchable public Input/SelectList composition, usable inside an existing overlay. */
export class JarvisChoicePicker implements Component, Focusable {
	focused = false;
	private readonly input = new Input({ prompt: "" });
	private readonly pasteDrain: JarvisDraftEditor;
	private list: SelectList;
	private listHeight = 1;
	private filteredIndices: number[] = [];
	private canSelect = false;
	private renderedRows = 0;
	private renderedColumns = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly choices: readonly JarvisPickerChoice[],
		private readonly onSelect: (choice: JarvisPickerChoice) => void,
		private readonly onCancel: () => void,
		private readonly title: string,
		initialSearch = "",
	) {
		this.input.setValue(safeInline(initialSearch).slice(0, 1024));
		// Reuse the draft's bounded, split-framing drain rather than public Input's
		// trailing-packet replay. Picker paste is deliberately discarded, not keys.
		this.pasteDrain = new JarvisDraftEditor(tui, theme, { onChange() {}, onSubmit() {} });
		this.list = this.createList();
	}

	private createList(): SelectList {
		const search = this.input.getValue().toLowerCase().trim();
		this.filteredIndices = [];
		// Exact requests outrank description matches (e.g. "off" also occurs
		// in auto's explanatory label; "high" is a substring of "xhigh").
		const ordered = this.choices.map((choice, index) => ({ choice, index })).sort((a, b) =>
			Number(b.choice.value.toLowerCase() === search) - Number(a.choice.value.toLowerCase() === search));
		const list = new SelectList(ordered.flatMap(({ choice, index }) => {
			const label = safeInline(choice.label);
			if (!label.toLowerCase().includes(search)) return [];
			this.filteredIndices.push(index);
			return [{ value: String(index), label }];
		}), this.listHeight, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: () => this.theme.fg("warning", "No matching choices"),
		});
		return list;
	}

	handleInput(data: string): void {
		if (this.pasteDrain.handlePasteInput(data, true) || isKeyRelease(data)) return;
		const kb = this.keybindings;
		if (matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.list.getSelectedItem();
			if (this.canSelect && this.focused && selected && this.renderedRows === this.tui.terminal.rows
				&& this.renderedColumns === this.tui.terminal.columns) this.onSelect(this.choices[Number(selected.value)]!);
		} else if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const)
			.some((action) => kb.matches(data, action))) {
			const selected = this.list.getSelectedItem();
			const index = selected ? this.filteredIndices.indexOf(Number(selected.value)) : 0;
			const up = kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.pageUp");
			const page = kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown");
			this.list.setSelectedIndex(index + (up ? -1 : 1) * (page ? this.listHeight : 1));
		} else {
			// Unknown terminal packets never become search text.
			if (data.startsWith("\x1b") && !parseKey(data)) return;
			if (!data.startsWith("\x1b") && data.length > 1 && /[\x00-\x1f\x7f-\x9f]/.test(data)) return;
			const previousSearch = this.input.getValue();
			this.input.handleInput(data);
			const search = this.input.getValue();
			if (Buffer.byteLength(search, "utf8") > 1024 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(search)) this.input.setValue(previousSearch);
			if (this.input.getValue() !== previousSearch) this.list = this.createList();
		}
		this.tui.requestRender();
	}

	render(width: number, height = this.tui.terminal.rows): string[] {
		width = dimension(width); height = dimension(height);
		this.renderedRows = this.tui.terminal.rows;
		this.renderedColumns = this.tui.terminal.columns;
		this.canSelect = width >= 4 && height >= 4;
		if (!width || !height) return [];
		this.input.focused = this.focused;
		const nextHeight = Math.max(1, Math.min(12, height - 3));
		if (this.listHeight !== nextHeight) {
			const selected = this.list.getSelectedItem()?.value;
			this.listHeight = nextHeight;
			this.list = this.createList();
			if (selected !== undefined) this.list.setSelectedIndex(this.filteredIndices.indexOf(Number(selected)));
		}
		const search = this.renderSearch(width);
		if (!this.canSelect) return [search, truncateToWidth("Enlarge to select; Esc back", width, "", true)].slice(0, height);
		return [
			this.theme.fg("accent", safeInline(this.title)), search,
			...this.list.render(width).slice(0, height - 3),
			this.theme.fg("dim", "↑/↓ choose • Enter apply • Esc back"),
		].map((line) => truncateToWidth(line, width, "", true));
	}

	private renderSearch(width: number): string {
		let line = this.input.render(Math.max(3, width))[0] ?? "";
		const marker = line.indexOf(CURSOR_MARKER);
		if (visibleWidth(line) > width && marker >= 0) {
			const before = line.slice(0, marker);
			const prefix = sliceByColumn(before, Math.max(0, visibleWidth(before) - width + 1), width - 1, true);
			const suffix = sliceByColumn(line.slice(marker + CURSOR_MARKER.length), 0, width - visibleWidth(prefix), true);
			line = prefix + CURSOR_MARKER + (visibleWidth(suffix) ? suffix : "\x1b[7m \x1b[0m");
		}
		return truncateToWidth(line, width, "", true);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		if (this.pasteDrain.hasPendingPaste()) return { handled: true, render: false };
		const delta = event.wheelDelta ?? 0;
		if (Number.isFinite(delta) && delta !== 0) {
			const selected = this.list.getSelectedItem();
			const index = selected ? this.filteredIndices.indexOf(Number(selected.value)) : 0;
			this.list.setSelectedIndex(index + Math.sign(delta) * Math.max(1, Math.floor(Math.abs(delta))));
		}
		return { handled: true, render: true };
	}

	invalidate(): void { this.canSelect = false; this.input.invalidate(); this.list.invalidate(); }
}

/** Outside /jarvis-model command picker: main host modal admission stays in index. */
export class JarvisModelPicker extends JarvisChoicePicker {
	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, models: readonly Model<any>[],
		onSelect: (model: Model<any>) => void, onCancel: () => void, initialSearch = "") {
		super(tui, theme, keybindings, models.map((model, index) => ({ value: String(index), label: `${model.provider}/${model.id}` })),
			(choice) => onSelect(models[Number(choice.value)]!), onCancel, "Jarvis model (main model unchanged)", initialSearch);
	}
}

function dimension(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
function safeInline(text: string): string {
	return text.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}
