import type { Model } from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

/** A searchable host-registry picker, without a second credential/catalog runtime. */
export class JarvisModelPicker implements Component, Focusable {
	focused = false;
	private readonly input = new Input();
	private list: SelectList;
	private listHeight = 0;
	private filteredModelIndices: number[] = [];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly models: readonly Model<any>[],
		private readonly onSelect: (model: Model<any>) => void,
		private readonly onCancel: () => void,
		initialSearch = "",
	) {
		this.input.setValue(initialSearch);
		this.list = this.createList();
	}

	private createList(): SelectList {
		const search = this.input.getValue().toLowerCase().trim();
		this.listHeight = Math.max(1, Math.min(12, this.tui.terminal.rows - 4));
		this.filteredModelIndices = [];
		const list = new SelectList(this.models.flatMap((model, index) => {
			const label = `${model.provider}/${model.id}`.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
			if (!label.toLowerCase().includes(search)) return [];
			this.filteredModelIndices.push(index);
			return [{ value: String(index), label }];
		}), this.listHeight, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: () => this.theme.fg("warning", "No matching models"),
		});
		list.onSelect = (item) => this.onSelect(this.models[Number(item.value)]!);
		list.onCancel = this.onCancel;
		return list;
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.list.getSelectedItem();
			if (selected) this.onSelect(this.models[Number(selected.value)]!);
		} else if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const)
			.some((action) => kb.matches(data, action))) {
			const selected = this.list.getSelectedItem();
			const index = selected ? this.filteredModelIndices.indexOf(Number(selected.value)) : 0;
			const up = kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.pageUp");
			const page = kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown");
			this.list.setSelectedIndex(index + (up ? -1 : 1) * (page ? this.listHeight : 1));
		} else {
			const previousSearch = this.input.getValue();
			this.input.handleInput(data);
			if (this.input.getValue() !== previousSearch) this.list = this.createList();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 1) return [];
		this.input.focused = this.focused;
		if (this.listHeight !== Math.max(1, Math.min(12, this.tui.terminal.rows - 4))) {
			const selected = this.list.getSelectedItem()?.value;
			this.list = this.createList();
			if (selected !== undefined) this.list.setSelectedIndex(this.filteredModelIndices.indexOf(Number(selected)));
		}
		return [
			this.theme.fg("accent", "Jarvis model (main model unchanged)"),
			...this.input.render(width),
			...this.list.render(width),
		].slice(0, Math.max(1, this.tui.terminal.rows)).map((line) => truncateToWidth(line, width, "", true));
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}
}
