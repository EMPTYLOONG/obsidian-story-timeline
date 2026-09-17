import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type StoryTimelinePlugin from './main';

export interface CategoryDef {
	id: string;
	label: string;
	color: string;
}

export interface TimelineSettings {
	dateField: string;
	defaultZoom: number;
	showDescription: boolean;
	showTags: boolean;
	autoRegisterCategories: boolean;
	cardWidth: number;
	eventFolder: string;
	categories: CategoryDef[];
}

/** 分类显示名称最大长度 */
const MAX_CATEGORY_LABEL_LENGTH = 20;

export const DEFAULT_CATEGORIES: CategoryDef[] = [
	{ id: 'main', label: '主线', color: '#e74c3c' },
	{ id: 'sub', label: '支线', color: '#3498db' },
	{ id: 'character', label: '角色线', color: '#2ecc71' },
	{ id: 'default', label: '其他', color: '#95a5a6' },
];

export const DEFAULT_SETTINGS: TimelineSettings = {
	dateField: 'timelineDate',
	defaultZoom: 100,
	showDescription: true,
	showTags: true,
	autoRegisterCategories: true,
	cardWidth: 100,
	eventFolder: '',
	categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
};

export function migrateSettings(raw: unknown): TimelineSettings {
	const data = (raw ?? {}) as Record<string, unknown>;

	const result: TimelineSettings = {
		dateField:
			typeof data.dateField === 'string' ? data.dateField : DEFAULT_SETTINGS.dateField,
		defaultZoom:
			typeof data.defaultZoom === 'number' && data.defaultZoom >= 0.5 && data.defaultZoom <= 500
				? data.defaultZoom
				: DEFAULT_SETTINGS.defaultZoom,
		showDescription:
			typeof data.showDescription === 'boolean'
				? data.showDescription
				: DEFAULT_SETTINGS.showDescription,
		showTags:
			typeof data.showTags === 'boolean' ? data.showTags : DEFAULT_SETTINGS.showTags,
		autoRegisterCategories:
			typeof data.autoRegisterCategories === 'boolean'
				? data.autoRegisterCategories
				: DEFAULT_SETTINGS.autoRegisterCategories,
		cardWidth:
			typeof data.cardWidth === 'number' && data.cardWidth >= 40 && data.cardWidth <= 400
				? data.cardWidth
				: DEFAULT_SETTINGS.cardWidth,
		eventFolder:
			typeof data.eventFolder === 'string' ? data.eventFolder : DEFAULT_SETTINGS.eventFolder,
		categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
	};

	if (Array.isArray(data.categories)) {
		const cats: CategoryDef[] = [];
		for (const item of data.categories) {
			if (!item || typeof item !== 'object') continue;
			const c = item as Record<string, unknown>;
			if (typeof c.id !== 'string' || c.id.length === 0) continue;
			const rawLabel = typeof c.label === 'string' ? c.label : c.id;
			cats.push({
				id: c.id,
				// 加载时对已存在的超长 label 自动截断
				label: rawLabel.slice(0, MAX_CATEGORY_LABEL_LENGTH) || c.id,
				color: typeof c.color === 'string' ? c.color : '#95a5a6',
			});
		}
		if (cats.length > 0) result.categories = cats;
	} else if (data.categoryColors && typeof data.categoryColors === 'object') {
		const colors = data.categoryColors as Record<string, unknown>;
		const cats: CategoryDef[] = [];
		for (const [id, color] of Object.entries(colors)) {
			cats.push({
				id,
				label: id.slice(0, MAX_CATEGORY_LABEL_LENGTH),
				color: typeof color === 'string' ? color : '#95a5a6',
			});
		}
		if (cats.length > 0) result.categories = cats;
	}

	if (!result.categories.some((c) => c.id === 'default')) {
		result.categories.push({ id: 'default', label: '其他', color: '#95a5a6' });
	}

	return result;
}

// ============ 通用确认对话框 ============
class ConfirmModal extends Modal {
	private message: string;
	private confirmText: string;
	private onConfirm: () => void;

	constructor(app: App, message: string, confirmText: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.confirmText = confirmText;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: '确认操作' });
		// 支持换行
		this.message.split('\n').forEach((line) => {
			contentEl.createEl('p', { text: line, cls: 'timeline-confirm-line' });
		});

		const footer = contentEl.createDiv('modal-button-container');

		const cancel = footer.createEl('button', { text: '取消' });
		cancel.onclick = () => this.close();

		const ok = footer.createEl('button', { text: this.confirmText, cls: 'mod-cta' });
		ok.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class TimelineSettingTab extends PluginSettingTab {
	plugin: StoryTimelinePlugin;

	constructor(app: App, plugin: StoryTimelinePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('故事时间线设置').setHeading();

		new Setting(containerEl)
			.setName('日期字段名')
			.setDesc('Frontmatter 中用于时间线的日期字段（默认 timelineDate）')
			.addText((text) =>
				text.setValue(this.plugin.settings.dateField).onChange(async (value) => {
					this.plugin.settings.dateField = value.trim() || 'timelineDate';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('默认缩放级别')
			.setDesc('0.5 = 10年间隔，500 = 周间隔。可在时间线视图里用 Ctrl+滚轮 调整')
			.addSlider((slider) =>
				slider
					.setLimits(1, 500, 1)
					.setValue(this.plugin.settings.defaultZoom)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.defaultZoom = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName('卡片宽度（像素）')
			.setDesc('也可在时间线视图工具栏右侧实时调整')
			.addSlider((slider) =>
				slider
					.setLimits(60, 240, 10)
					.setValue(this.plugin.settings.cardWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.cardWidth = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('新建事件的默认文件夹')
			.setDesc('留空 = 库根目录。使用"+ 新建事件"按钮时，新笔记会放在这个文件夹里')
			.addText((text) =>
				text
					.setPlaceholder('例如 时间线/事件')
					.setValue(this.plugin.settings.eventFolder)
					.onChange(async (value) => {
						this.plugin.settings.eventFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('显示事件描述')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showDescription).onChange(async (value) => {
					this.plugin.settings.showDescription = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('显示事件标签')
			.setDesc('在每个事件下方显示自定义标签')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTags).onChange(async (value) => {
					this.plugin.settings.showTags = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('自动注册新分类')
			.setDesc('在笔记中写入新的 timelineCategory 后，打开时间线并刷新时会自动加入下方列表')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoRegisterCategories)
					.onChange(async (value) => {
						this.plugin.settings.autoRegisterCategories = value;
						await this.plugin.saveSettings();
					})
			);

		// ============ 分类管理 ============
		new Setting(containerEl).setName('时间线分类').setHeading();

		containerEl.createEl('p', {
			text:
				'每个分类对应时间线上的一条水平轨道。ID 用于 frontmatter 中 timelineCategory 的值。' +
				`显示名称最长 ${MAX_CATEGORY_LABEL_LENGTH} 个字符。`,
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('管理操作')
			.addButton((btn) =>
				btn.setButtonText('+ 新增分类').onClick(() => {
					new ConfirmModal(
						this.app,
						'确定要新增一个时间线分类吗？\n新增后会在下方列表末尾出现，可以修改显示名称和颜色。',
						'确定新建',
						() => void this.createNewCategory()
					).open();
				})
			)
			.addButton((btn) =>
				btn.setButtonText('检查重复').onClick(() => {
					this.checkDuplicates();
				})
			);

		const duplicateLabels = this.findDuplicateLabels();

		const list = containerEl.createDiv('timeline-category-list');
		this.plugin.settings.categories.forEach((cat, idx) => {
			this.renderCategoryRow(list, cat, idx, duplicateLabels.has(cat.label));
		});
	}

	private async createNewCategory(): Promise<void> {
		const id = this.generateUniqueId();
		this.plugin.settings.categories.push({
			id,
			label: '新分类',
			color: '#888888',
		});
		await this.plugin.saveSettings();
		this.display();
		new Notice('新分类已创建，请在下方列表中修改名称和颜色');
	}

	private findDuplicateLabels(): Set<string> {
		const counter = new Map<string, number>();
		for (const c of this.plugin.settings.categories) {
			counter.set(c.label, (counter.get(c.label) ?? 0) + 1);
		}
		const dup = new Set<string>();
		for (const [label, count] of counter) {
			if (count >= 2) dup.add(label);
		}
		return dup;
	}

	private checkDuplicates(): void {
		const dup = this.findDuplicateLabels();
		if (dup.size === 0) {
			new Notice('没有重复的分类名称');
			return;
		}
		const names = Array.from(dup).join('、');
		new Notice(`发现重复分类名称：${names}。请修改其中之一的显示名。`);
	}

	private renderCategoryRow(
		parent: HTMLElement,
		cat: CategoryDef,
		index: number,
		isDuplicate: boolean
	): void {
		const row = parent.createDiv('timeline-category-row');
		if (isDuplicate) row.addClass('is-duplicate');

		// 颜色
		const colorInput = row.createEl('input', {
			type: 'color',
			cls: 'category-color-input',
		});
		colorInput.value = cat.color;
		colorInput.oninput = () => {
			cat.color = colorInput.value;
			void this.plugin.saveSettings();
		};

		// ID（只读）
		const idEl = row.createEl('code', {
			cls: 'category-id',
			text: cat.id,
		});
		idEl.title = `Frontmatter 中 timelineCategory 使用的值：${cat.id}`;

		// 显示名称（带长度限制）
		const labelInput = row.createEl('input', {
			type: 'text',
			cls: 'category-label-input',
		});
		labelInput.value = cat.label;
		labelInput.placeholder = '显示名称';
		labelInput.maxLength = MAX_CATEGORY_LABEL_LENGTH;

		labelInput.oninput = () => {
			// 实时显示剩余字符数（可选提示）
			const remaining = MAX_CATEGORY_LABEL_LENGTH - labelInput.value.length;
			labelInput.title =
				remaining > 0
					? `还可输入 ${remaining} 个字符`
					: `已达上限（${MAX_CATEGORY_LABEL_LENGTH} 字符）`;
		};

		labelInput.onchange = () => {
			const v = labelInput.value.trim();
			const finalLabel = (v || cat.id).slice(0, MAX_CATEGORY_LABEL_LENGTH);
			labelInput.value = finalLabel;
			if (finalLabel !== cat.label) {
				cat.label = finalLabel;
				void this.plugin.saveSettings();
				this.display();
			}
		};

		// 重复警告
		if (isDuplicate) {
			const warn = row.createEl('span', {
				cls: 'category-duplicate-tag',
				text: '⚠ 名称重复',
			});
			warn.title = '有多个分类使用相同的显示名称，请修改';
		}

		// 删除 / 默认标记
		if (cat.id !== 'default') {
			const delBtn = row.createEl('button', {
				cls: 'category-delete-btn',
				text: '删除',
			});
			delBtn.onclick = () => {
				new ConfirmModal(
					this.app,
					`确定要删除分类"${cat.label}"吗？\n（笔记中的事件不会被删除，会归入"其他"分类）`,
					'确定删除',
					() => void this.deleteCategory(index)
				).open();
			};
		} else {
			row.createEl('span', { cls: 'category-default-tag', text: '默认' });
		}
	}

	private async deleteCategory(index: number): Promise<void> {
		this.plugin.settings.categories.splice(index, 1);
		await this.plugin.saveSettings();
		this.display();
	}

	private generateUniqueId(): string {
		const ids = new Set(this.plugin.settings.categories.map((c) => c.id));
		let n = 1;
		while (ids.has(`category-${n}`)) n++;
		return `category-${n}`;
	}
}
