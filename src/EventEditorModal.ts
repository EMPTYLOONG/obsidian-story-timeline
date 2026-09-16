import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type StoryTimelinePlugin from './main';

export interface SubEventInput {
	date: string;
	endDate: string;
	title: string;
	link: string;
}

export interface EventEditorData {
	filePath?: string;
	title: string;
	date: string;
	endDate: string;
	category: string;
	tags: string[];
	description: string;
	subEvents: SubEventInput[];
}

/** YAML 字符串值转义 */
function yamlString(s: string): string {
	if (s === '') return '""';
	const needsQuote =
		/^[-?:,[\]{}#&*!|>'"%@`\s]/.test(s) ||
		/:\s/.test(s) ||
		/\s#/.test(s) ||
		/^\s|\s$/.test(s) ||
		/^(true|false|null|yes|no|on|off)$/i.test(s);
	if (needsQuote) {
		return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
	}
	return s;
}

export class EventEditorModal extends Modal {
	private plugin: StoryTimelinePlugin;
	private data: EventEditorData;
	private isEdit: boolean;
	private onSave: (saved: boolean) => void;
	private saving = false;

	private subEventsContainer!: HTMLElement;

	constructor(
		app: App,
		plugin: StoryTimelinePlugin,
		data: Partial<EventEditorData>,
		onSave: (saved: boolean) => void
	) {
		super(app);
		this.plugin = plugin;
		this.isEdit = !!data.filePath;
		this.onSave = onSave;
		this.data = {
			filePath: data.filePath,
			title: data.title ?? '',
			date: data.date ?? '',
			endDate: data.endDate ?? '',
			category: data.category ?? this.defaultCategoryId(),
			tags: data.tags ?? [],
			description: data.description ?? '',
			subEvents: data.subEvents ?? [],
		};
	}

	private defaultCategoryId(): string {
		const first = this.plugin.settings.categories.find((c) => c.id !== 'default');
		return first?.id ?? 'default';
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('timeline-event-editor');

		contentEl.createEl('h2', {
			text: this.isEdit ? '编辑时间线事件' : '新建时间线事件',
		});

		new Setting(contentEl)
			.setName('标题')
			.setDesc('事件的名称')
			.addText((text) =>
				text
					.setPlaceholder('例如 第一幕：主人公离家')
					.setValue(this.data.title)
					.onChange((v) => {
						this.data.title = v;
					})
			);

		new Setting(contentEl)
			.setName('开始日期')
			.setDesc('支持：2024-03-15 / 2024-03 / 2024 / 618 / 2024年3月15日')
			.addText((text) =>
				text
					.setPlaceholder('例如 2024-03-15')
					.setValue(this.data.date)
					.onChange((v) => {
						this.data.date = v;
					})
			);

		new Setting(contentEl)
			.setName('结束日期')
			.setDesc('留空 = 单点事件；填写后变成时期条带')
			.addText((text) =>
				text
					.setPlaceholder('留空为单点事件')
					.setValue(this.data.endDate)
					.onChange((v) => {
						this.data.endDate = v;
					})
			);

		new Setting(contentEl)
			.setName('分类')
			.setDesc('事件所属的轨道')
			.addDropdown((dd) => {
				for (const c of this.plugin.settings.categories) {
					dd.addOption(c.id, c.label || c.id);
				}
				dd.setValue(this.data.category);
				dd.onChange((v) => {
					this.data.category = v;
				});
			});

		new Setting(contentEl)
			.setName('标签')
			.setDesc('用逗号分隔多个标签')
			.addText((text) =>
				text
					.setPlaceholder('例如 主角, 伏笔')
					.setValue(this.data.tags.join(', '))
					.onChange((v) => {
						this.data.tags = v
							.split(',')
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
					})
			);

		// 描述
		const descItem = contentEl.createDiv('setting-item');
		const descInfo = descItem.createDiv('setting-item-info');
		descInfo.createDiv('setting-item-name').textContent = '描述';
		descInfo.createDiv('setting-item-description').textContent = '事件的简短描述（可选）';
		const descControl = descItem.createDiv('setting-item-control');
		const descArea = descControl.createEl('textarea', {
			cls: 'timeline-event-textarea',
		});
		descArea.placeholder = '描述内容……';
		descArea.value = this.data.description;
		descArea.oninput = () => {
			this.data.description = descArea.value;
		};

		// 子事件
		contentEl.createEl('h3', { cls: 'timeline-event-h3', text: '子事件（可选）' });
		contentEl.createEl('p', {
			cls: 'timeline-event-hint',
			text: '仅在填写了"结束日期"后生效。子事件会在时期条带内按时间比例分割。',
		});

		this.subEventsContainer = contentEl.createDiv('timeline-subevents-list');
		this.renderSubEvents();

		const addSubBtn = contentEl.createEl('button', {
			cls: 'timeline-subevent-add',
			text: '+ 添加子事件',
		});
		addSubBtn.onclick = () => {
			this.data.subEvents.push({ date: '', endDate: '', title: '', link: '' });
			this.renderSubEvents();
		};

		// 底部
		const footer = contentEl.createDiv('timeline-event-editor-footer');

		const cancelBtn = footer.createEl('button', { text: '取消' });
		cancelBtn.onclick = () => {
			this.close();
			this.onSave(false);
		};

		const saveBtn = footer.createEl('button', { text: '保存', cls: 'mod-cta' });
		saveBtn.onclick = () => void this.handleSave();
	}

	private renderSubEvents(): void {
		this.subEventsContainer.empty();

		if (this.data.subEvents.length === 0) {
			this.subEventsContainer.createEl('p', {
				cls: 'timeline-subevent-empty',
				text: '（暂无子事件）',
			});
			return;
		}

		this.data.subEvents.forEach((sub, idx) => {
			const row = this.subEventsContainer.createDiv('timeline-subevent-row');

			const titleIn = row.createEl('input', { type: 'text', cls: 'sub-title' });
			titleIn.placeholder = '名称';
			titleIn.value = sub.title;
			titleIn.oninput = () => {
				sub.title = titleIn.value;
			};

			const dateIn = row.createEl('input', { type: 'text', cls: 'sub-date' });
			dateIn.placeholder = '开始日期';
			dateIn.value = sub.date;
			dateIn.oninput = () => {
				sub.date = dateIn.value;
			};

			const endDateIn = row.createEl('input', { type: 'text', cls: 'sub-date' });
			endDateIn.placeholder = '结束（可空）';
			endDateIn.value = sub.endDate;
			endDateIn.oninput = () => {
				sub.endDate = endDateIn.value;
			};

			const linkIn = row.createEl('input', { type: 'text', cls: 'sub-link' });
			linkIn.placeholder = '链接笔记（可空）';
			linkIn.value = sub.link;
			linkIn.oninput = () => {
				sub.link = linkIn.value;
			};

			const delBtn = row.createEl('button', { text: '×', cls: 'sub-del' });
			delBtn.title = '删除该子事件';
			delBtn.onclick = () => {
				this.data.subEvents.splice(idx, 1);
				this.renderSubEvents();
			};
		});
	}

	private async handleSave(): Promise<void> {
		if (this.saving) return;

		if (!this.data.title.trim()) {
			new Notice('请填写标题');
			return;
		}
		if (!this.data.date.trim()) {
			new Notice('请填写开始日期');
			return;
		}

		this.saving = true;
		try {
			if (this.isEdit && this.data.filePath) {
				await this.updateExistingFile();
			} else {
				await this.createNewFile();
			}
			new Notice(this.isEdit ? '事件已更新' : '事件已创建');
			this.close();
			this.onSave(true);
		} catch (e) {
			console.error('[Story Timeline] 保存失败', e);
			new Notice('保存失败：' + (e instanceof Error ? e.message : String(e)));
		} finally {
			this.saving = false;
		}
	}

	private async createNewFile(): Promise<void> {
		const folder = this.plugin.settings.eventFolder.trim();
		const safeTitle = this.data.title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名事件';

		let path = folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`;

		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = folder
				? `${folder}/${safeTitle} ${counter}.md`
				: `${safeTitle} ${counter}.md`;
			counter++;
		}

		if (folder) {
			const existing = this.app.vault.getAbstractFileByPath(folder);
			if (!existing) {
				await this.app.vault.createFolder(folder);
			}
		}

		const content = this.buildNewFileContent();
		await this.app.vault.create(path, content);
	}

	private async updateExistingFile(): Promise<void> {
		if (!this.data.filePath) return;
		const file = this.app.vault.getAbstractFileByPath(this.data.filePath);
		if (!(file instanceof TFile)) {
			new Notice('找不到原文件');
			return;
		}

		const content = await this.app.vault.read(file);
		const newContent = this.mergeIntoContent(content);
		await this.app.vault.modify(file, newContent);
	}

	/** 收集本次要写入的所有 timeline 相关行（所有值经 yamlString 转义） */
	private buildTimelineLines(): string[] {
		const lines: string[] = [];

		// 日期不转义（保持 Obsidian 能识别为 date 类型）
		lines.push(`timelineDate: ${this.data.date.trim()}`);
		if (this.data.endDate.trim()) {
			lines.push(`timelineEndDate: ${this.data.endDate.trim()}`);
		}

		// 其他值统一转义
		lines.push(`timelineTitle: ${yamlString(this.data.title.trim())}`);
		if (this.data.description.trim()) {
			lines.push(`timelineDescription: ${yamlString(this.data.description.trim())}`);
		}
		lines.push(`timelineCategory: ${yamlString(this.data.category)}`);

		if (this.data.tags.length > 0) {
			lines.push(
				`timelineTags: [${this.data.tags.map((t) => yamlString(t)).join(', ')}]`
			);
		}

		const subs = this.data.subEvents.filter(
			(s) => s.date.trim() && s.title.trim()
		);
		if (subs.length > 0) {
			lines.push('timelineSubEvents:');
			for (const sub of subs) {
				lines.push(`  - date: ${sub.date.trim()}`);
				if (sub.endDate.trim()) {
					lines.push(`    endDate: ${sub.endDate.trim()}`);
				}
				lines.push(`    title: ${yamlString(sub.title.trim())}`);
				if (sub.link.trim()) {
					lines.push(`    link: ${yamlString(sub.link.trim())}`);
				}
			}
		}
		return lines;
	}

	private buildNewFileContent(): string {
		const lines = [
			'---',
			...this.buildTimelineLines(),
			'---',
			'',
			`# ${this.data.title.trim()}`,
			'',
			'',
		];
		return lines.join('\n');
	}

	private mergeIntoContent(content: string): string {
		const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
		const match = content.match(fmRegex);

		if (!match) {
			return this.buildNewFileContent() + content;
		}

		const oldLines = match[1]!.split(/\r?\n/);
		const managed = new Set([
			'timelineDate',
			'timelineEndDate',
			'timelineTitle',
			'timelineDescription',
			'timelineCategory',
			'timelineTags',
			'timelineSubEvents',
		]);

		const kept: string[] = [];
		let i = 0;
		while (i < oldLines.length) {
			const line = oldLines[i]!;
			const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
			if (m && managed.has(m[1]!)) {
				i++;
				while (i < oldLines.length && /^\s+/.test(oldLines[i]!)) {
					i++;
				}
				continue;
			}
			kept.push(line);
			i++;
		}

		const newLines = [...kept, ...this.buildTimelineLines()];
		return content.replace(fmRegex, `---\n${newLines.join('\n')}\n---`);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
