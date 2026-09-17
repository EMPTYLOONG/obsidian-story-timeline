import { App, Modal } from 'obsidian';

export interface ExportOptions {
	startDate: string;
	endDate: string;
	includeDescription: boolean;
	includeTags: boolean;
	includeSubEvents: boolean;
}

export class ExportModal extends Modal {
	private defaults: ExportOptions;
	private onExport: (opts: ExportOptions) => void;

	private startInput!: HTMLInputElement;
	private endInput!: HTMLInputElement;
	private descCheck!: HTMLInputElement;
	private tagsCheck!: HTMLInputElement;
	private subsCheck!: HTMLInputElement;

	constructor(
		app: App,
		defaults: Partial<ExportOptions>,
		onExport: (opts: ExportOptions) => void
	) {
		super(app);
		this.defaults = {
			startDate: defaults.startDate ?? '',
			endDate: defaults.endDate ?? '',
			includeDescription: defaults.includeDescription ?? true,
			includeTags: defaults.includeTags ?? true,
			includeSubEvents: defaults.includeSubEvents ?? true,
		};
		this.onExport = onExport;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('timeline-export-modal');

		contentEl.createEl('h2', { text: '导出时间线截图' });

		contentEl.createEl('h3', { text: '时间区间（可选）' });
		contentEl.createEl('p', {
			cls: 'timeline-export-hint',
			text: '留空则包含全部事件。支持：2024 / 2024-03 / 2024-03-15 / 2024年3月',
		});

		const rangeRow = contentEl.createDiv('timeline-export-row');
		const startWrap = rangeRow.createDiv('timeline-export-field');
		startWrap.createEl('label', { text: '开始日期' });
		this.startInput = startWrap.createEl('input', { type: 'text' });
		this.startInput.placeholder = '留空 = 最早事件';
		this.startInput.value = this.defaults.startDate;

		const endWrap = rangeRow.createDiv('timeline-export-field');
		endWrap.createEl('label', { text: '结束日期' });
		this.endInput = endWrap.createEl('input', { type: 'text' });
		this.endInput.placeholder = '留空 = 最晚事件';
		this.endInput.value = this.defaults.endDate;

		contentEl.createEl('h3', { text: '导出内容' });
		const opts = contentEl.createDiv('timeline-export-options');

		const mkCheck = (
			label: string,
			def: boolean,
			assign: (el: HTMLInputElement) => void
		) => {
			const row = opts.createDiv('timeline-export-check');
			const cb = row.createEl('input', { type: 'checkbox' });
			cb.checked = def;
			const lb = row.createEl('label');
			lb.textContent = label;
			assign(cb);
		};

		mkCheck('包含事件描述', this.defaults.includeDescription, (el) => {
			this.descCheck = el;
		});
		mkCheck('包含标签', this.defaults.includeTags, (el) => {
			this.tagsCheck = el;
		});
		mkCheck('包含子事件', this.defaults.includeSubEvents, (el) => {
			this.subsCheck = el;
		});

		const footer = contentEl.createDiv('timeline-export-footer');
		const cancel = footer.createEl('button', { text: '取消' });
		cancel.onclick = () => this.close();

		const ok = footer.createEl('button', { text: '导出', cls: 'mod-cta' });
		ok.onclick = () => {
			this.onExport({
				startDate: this.startInput.value.trim(),
				endDate: this.endInput.value.trim(),
				includeDescription: this.descCheck.checked,
				includeTags: this.tagsCheck.checked,
				includeSubEvents: this.subsCheck.checked,
			});
			this.close();
		};

		window.setTimeout(() => this.startInput.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
