import { ItemView, WorkspaceLeaf, TFile, Notice, Menu } from 'obsidian';
import type StoryTimelinePlugin from './main';
import { EventEditorModal, EventEditorData } from './EventEditorModal';
import { ExportModal, ExportOptions } from './ExportModal';

export const TIMELINE_VIEW_TYPE = 'story-timeline-view';

type DatePrecision = 'day' | 'month' | 'year';

interface ParsedDate { ts: number; precision: DatePrecision; raw: string; }
interface SubEvent {
	dateTs: number; dateStr: string;
	endTs?: number; endStr?: string;
	title: string; link?: string;
}
interface TimelineEvent {
	dateTs: number; dateStr: string; datePrecision: DatePrecision;
	endTs?: number; endStr?: string; endPrecision?: DatePrecision;
	title: string; description: string; category: string; color?: string;
	tags: string[]; filePath: string; subEvents: SubEvent[];
}
interface LayoutBox { event: TimelineEvent; startX: number; endX: number; layer: number; }

// ============ 刻度规格（无极缩放核心） ============
type TickKind = 'week1' | 'week2' | 'month1' | 'month3' | 'month6' | 'year1' | 'year5' | 'year10';
interface TickSpec { kind: TickKind; approxDays: number; }

const TICK_SPECS: TickSpec[] = [
	{ kind: 'week1', approxDays: 7 },
	{ kind: 'week2', approxDays: 14 },
	{ kind: 'month1', approxDays: 30.44 },
	{ kind: 'month3', approxDays: 91.31 },
	{ kind: 'month6', approxDays: 182.62 },
	{ kind: 'year1', approxDays: 365.25 },
	{ kind: 'year5', approxDays: 1826.25 },
	{ kind: 'year10', approxDays: 3652.5 },
];

const AUTO_COLOR_PALETTE = [
	'#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
	'#00bcd4', '#009688', '#4caf50', '#ff9800',
	'#795548', '#607d8b', '#f44336', '#ff5722',
];

const ONE_DAY_MS = 86400000;

function makeUTCDate(y: number, mo: number, d: number): Date {
	const dt = new Date(Date.UTC(2000, 0, 1));
	dt.setUTCFullYear(y, mo, d);
	dt.setUTCHours(0, 0, 0, 0);
	return dt;
}

function isDateObject(v: unknown): v is Date {
	return Object.prototype.toString.call(v) === '[object Date]';
}

function normalizeDateValue(raw: unknown): string | null {
	if (typeof raw === 'string') {
		const s = raw.trim();
		return s.length > 0 ? s : null;
	}
	if (typeof raw === 'number') {
		if (!isFinite(raw)) return null;
		return String(raw);
	}
	if (isDateObject(raw)) {
		const t = raw.getTime();
		if (isNaN(t)) return null;
		const y = raw.getUTCFullYear();
		const m = raw.getUTCMonth() + 1;
		const d = raw.getUTCDate();
		return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
	}
	return null;
}

function parseFlexibleDate(input: string): ParsedDate | null {
	if (typeof input !== 'string') return null;
	const s = input.trim();
	if (!s) return null;
	const normalized = s
		.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '')
		.replace(/[/.]/g, '-').replace(/-+$/, '').trim();
	const m = normalized.match(/^(-?\d{1,6})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
	if (!m) return null;
	const yearStr = m[1]; const monthStr = m[2]; const dayStr = m[3];
	if (yearStr === undefined) return null;
	const y = parseInt(yearStr, 10);
	if (!isFinite(y)) return null;
	if (dayStr !== undefined) {
		if (monthStr === undefined) return null;
		const mo = parseInt(monthStr, 10); const d = parseInt(dayStr, 10);
		if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
		const dt = makeUTCDate(y, mo - 1, d);
		if (isNaN(dt.getTime())) return null;
		return { ts: dt.getTime(), precision: 'day', raw: s };
	}
	if (monthStr !== undefined) {
		const mo = parseInt(monthStr, 10);
		if (mo < 1 || mo > 12) return null;
		const dt = makeUTCDate(y, mo - 1, 1);
		if (isNaN(dt.getTime())) return null;
		return { ts: dt.getTime(), precision: 'month', raw: s };
	}
	const dt = makeUTCDate(y, 0, 1);
	if (isNaN(dt.getTime())) return null;
	return { ts: dt.getTime(), precision: 'year', raw: s };
}

function parseWikiLink(raw: string): string {
	const m = raw.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
	if (m && m[1]) return m[1];
	return raw;
}

function formatDuration(ms: number): string {
	if (ms < 0) return '';
	const days = ms / ONE_DAY_MS;
	if (days < 1) return '不到 1 天';
	if (days < 60) return `已过 ${Math.floor(days)} 天`;
	if (days < 730) return `已过 ${Math.floor(days / 30.44)} 个月`;
	const years = days / 365.25;
	const wholeYears = Math.floor(years);
	const remainingDays = days - wholeYears * 365.25;
	const months = Math.floor(remainingDays / 30.44);
	if (months === 0) return `已过 ${wholeYears} 年`;
	return `已过 ${wholeYears} 年 ${months} 个月`;
}

function isoWeek(date: Date): number {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = (d.getUTCDay() + 6) % 7;
	d.setUTCDate(d.getUTCDate() - dayNum + 3);
	const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
	const fdNum = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - fdNum + 3);
	return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
}

export class TimelineView extends ItemView {
	plugin: StoryTimelinePlugin;
	private events: TimelineEvent[] = [];
	private zoomLevel: number;
	private cardWidth: number;

	private hiddenCategories: Set<string> = new Set();
	private hiddenTags: Set<string> = new Set();

	private baseTime: number = Date.UTC(2000, 0, 1);
	private readonly LEFT_PADDING = 100;
	private readonly RIGHT_PADDING = 300;
	private readonly LANE_UNIT_HEIGHT = 160;
	private readonly CARD_V_MARGIN = 10;
	private readonly CARD_H_GAP = 4;
	private readonly MIN_CARD_HEIGHT = 130;
	private readonly STICKY_LEFT = 12;
	private readonly BADGE_OFFSET_X = 8;

	// 无极缩放范围：0.5 ~ 500（每 30 天对应的像素数）
	private readonly MIN_ZOOM = 0.5;
	private readonly MAX_ZOOM = 500;
	// 点 +/- 时每次乘除的系数
	private readonly ZOOM_STEP_FACTOR = 1.25;
	// Ctrl+滚轮每格乘除的系数
	private readonly ZOOM_WHEEL_FACTOR = 1.12;

	private cursorTs: number | null = null;
	private stickyRafId = 0;
	private initialScrollDone = false;
	private autoRefreshTimer = 0;
	private autoRefreshPaused = false;

	constructor(leaf: WorkspaceLeaf, plugin: StoryTimelinePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.zoomLevel = plugin.settings.defaultZoom;
		this.cardWidth = plugin.settings.cardWidth;
	}

	getViewType(): string { return TIMELINE_VIEW_TYPE; }
	getDisplayText(): string { return '故事时间线'; }
	getIcon(): string { return 'clock'; }

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('story-timeline-container');

		this.initialScrollDone = false;

		this.renderToolbar(container);
		container.createDiv('timeline-filter-bar');
		const viewport = container.createDiv('timeline-viewport');

		this.registerDomEvent(viewport, 'dragstart', (e) => {
			e.preventDefault();
		});

		// 滚轮：普通滚动 = 横向滚动；Ctrl/⌘ + 滚轮 = 无极缩放
		this.registerDomEvent(viewport, 'wheel', (e: WheelEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;
			e.preventDefault();
			const factor = e.deltaY < 0 ? this.ZOOM_WHEEL_FACTOR : 1 / this.ZOOM_WHEEL_FACTOR;
			this.applyZoom(this.zoomLevel * factor);
		}, { passive: false });

		this.registerDomEvent(viewport, 'scroll', () => {
			if (this.stickyRafId) return;
			this.stickyRafId = window.requestAnimationFrame(() => {
				this.stickyRafId = 0;
				this.updateStickyContent();
			});
		});

		this.registerDomEvent(window, 'resize', () => {
			if (this.stickyRafId) return;
			this.stickyRafId = window.requestAnimationFrame(() => {
				this.stickyRafId = 0;
				this.updateStickyContent();
			});
		});

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (this.autoRefreshPaused) return;
				const cache = this.app.metadataCache.getFileCache(file);
				if (!cache?.frontmatter) return;
				const dateField = this.plugin.settings.dateField;
				if (cache.frontmatter[dateField] === undefined) return;
				this.scheduleAutoRefresh();
			})
		);

		this.registerEvent(
			this.app.vault.on('delete', () => {
				if (this.autoRefreshPaused) return;
				this.scheduleAutoRefresh();
			})
		);

		await this.refresh();
	}

	// ============ 工具栏 ============

	private renderToolbar(container: HTMLElement): void {
		const toolbar = container.createDiv('timeline-toolbar');

		const newBtn = toolbar.createEl('button', {
			cls: 'timeline-toolbar-new-btn',
			text: '+ 新建事件',
		});
		newBtn.onclick = () => this.openEventEditor();

		toolbar.createEl('button', { text: '←' }).onclick = () => this.pan(-200);
		toolbar.createEl('button', { text: '→' }).onclick = () => this.pan(200);
		toolbar.createEl('button', { text: '＋' }).onclick = () => this.zoomIn();
		toolbar.createEl('button', { text: '－' }).onclick = () => this.zoomOut();
		toolbar.createEl('button', { text: '刷新' }).onclick = () => void this.refresh();
		toolbar.createEl('button', { text: '导出图片' }).onclick = () => this.openExportModal();
		toolbar.createEl('button', { text: '清除游标' }).onclick = () => {
			this.cursorTs = null;
			this.updateCursorDisplay();
		};

		toolbar.createDiv('toolbar-spacer');

		// 缩放显示
		const zoomLabel = toolbar.createDiv('toolbar-zoom-label');
		zoomLabel.textContent = this.formatZoomLevel();

		const wrap = toolbar.createDiv('toolbar-slider');
		wrap.createSpan({ cls: 'toolbar-slider-label', text: '宽度' });
		const slider = wrap.createEl('input', { type: 'range' });
		slider.min = '60';
		slider.max = '240';
		slider.step = '10';
		slider.value = String(this.cardWidth);
		const valueDisplay = wrap.createSpan({
			cls: 'toolbar-slider-value',
			text: String(this.cardWidth),
		});
		slider.oninput = () => {
			const v = parseInt(slider.value, 10);
			this.cardWidth = v;
			valueDisplay.textContent = String(v);
			this.plugin.settings.cardWidth = v;
			void this.plugin.saveSettings();
			this.rerender();
		};
	}

	private formatZoomLevel(): string {
		// 显示一个友好的缩放级别数字
		const z = this.zoomLevel;
		if (z >= 100) return `×${Math.round(z)}`;
		if (z >= 10) return `×${z.toFixed(1)}`;
		return `×${z.toFixed(2)}`;
	}

	private updateZoomLabel(): void {
		const el = this.containerEl.querySelector<HTMLElement>('.toolbar-zoom-label');
		if (el) el.textContent = this.formatZoomLevel();
	}

	// ============ 无极缩放 ============

	private zoomIn(): void {
		this.applyZoom(this.zoomLevel * this.ZOOM_STEP_FACTOR);
	}

	private zoomOut(): void {
		this.applyZoom(this.zoomLevel / this.ZOOM_STEP_FACTOR);
	}

	private applyZoom(next: number): void {
		const clamped = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, next));
		if (Math.abs(clamped - this.zoomLevel) < 1e-9) return;
		this.zoomLevel = clamped;
		this.updateZoomLabel();
		void this.refresh();
	}

	// ============ 事件编辑器入口 ============

	private openEventEditor(event?: TimelineEvent): void {
		this.autoRefreshPaused = true;

		const data: Partial<EventEditorData> = event
			? {
				filePath: event.filePath,
				title: event.title,
				date: event.dateStr,
				endDate: event.endStr ?? '',
				category: event.category,
				color: event.color ?? '',
				tags: event.tags,
				description: event.description,
				subEvents: event.subEvents.map((s) => ({
					date: s.dateStr,
					endDate: s.endStr ?? '',
					title: s.title,
					link: s.link ?? '',
				})),
			}
			: {};

		const modal = new EventEditorModal(this.app, this.plugin, data, (saved) => {
			window.setTimeout(() => {
				this.autoRefreshPaused = false;
				if (saved) this.scheduleAutoRefresh();
			}, 100);
		});
		modal.open();
	}

	private showCardContextMenu(ev: MouseEvent, event: TimelineEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle('编辑事件').setIcon('pencil').onClick(() => this.openEventEditor(event))
		);
		menu.addItem((item) =>
			item.setTitle('打开笔记').setIcon('file-text').onClick(() => {
				const file = this.app.vault.getAbstractFileByPath(event.filePath);
				if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
			})
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('从时间线移除').setIcon('trash').onClick(() => void this.deleteEventFromTimeline(event))
		);
		menu.showAtMouseEvent(ev);
	}

	private async deleteEventFromTimeline(event: TimelineEvent): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(event.filePath);
		if (!(file instanceof TFile)) return;

		const content = await this.app.vault.read(file);
		const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
		const match = content.match(fmRegex);
		if (!match) {
			new Notice('该文件没有 frontmatter');
			return;
		}

		const managed = new Set([
			'timelineDate', 'timelineEndDate', 'timelineTitle', 'timelineDescription',
			'timelineCategory', 'timelineColor', 'timelineTags', 'timelineSubEvents',
		]);

		const oldLines = match[1]!.split(/\r?\n/);
		const kept: string[] = [];
		let i = 0;
		while (i < oldLines.length) {
			const line = oldLines[i]!;
			const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
			if (m && managed.has(m[1]!)) {
				i++;
				while (i < oldLines.length && /^\s+/.test(oldLines[i]!)) i++;
				continue;
			}
			kept.push(line);
			i++;
		}

		if (kept.length === 0) {
			const stripped = content.replace(fmRegex, '').replace(/^\s*\n/, '');
			await this.app.vault.modify(file, stripped);
		} else {
			const newContent = content.replace(fmRegex, `---\n${kept.join('\n')}\n---`);
			await this.app.vault.modify(file, newContent);
		}

		new Notice('已从时间线移除（笔记内容保留）');
		void this.refresh();
	}

	// ============ 刷新流程 ============

	async refresh(): Promise<void> {
		await this.scanEvents();
		await this.registerNewCategoriesFromEvents();
		this.updateBaseTime();
		this.rerender();
	}

	private scheduleAutoRefresh(): void {
		if (this.autoRefreshTimer) window.clearTimeout(this.autoRefreshTimer);
		this.autoRefreshTimer = window.setTimeout(() => {
			this.autoRefreshTimer = 0;
			void this.refresh();
		}, 400);
	}

	private rerender(): void {
		const filterBar = this.containerEl.querySelector<HTMLElement>('.timeline-filter-bar');
		if (filterBar) {
			filterBar.empty();
			this.renderFilterBarContent(filterBar);
		}

		const viewport = this.containerEl.querySelector<HTMLElement>('.timeline-viewport');
		if (!viewport) return;

		const savedScrollLeft = viewport.scrollLeft;
		const savedScrollTop = viewport.scrollTop;
		const wasInitialized = this.initialScrollDone;

		viewport.empty();
		this.renderTimeline(viewport);

		if (!wasInitialized) return;

		void viewport.scrollWidth;
		viewport.scrollLeft = savedScrollLeft;
		viewport.scrollTop = savedScrollTop;

		window.requestAnimationFrame(() => {
			if (savedScrollLeft > 20 && viewport.scrollLeft < 10) {
				viewport.scrollLeft = savedScrollLeft;
				viewport.scrollTop = savedScrollTop;
			}
		});
	}

	// ============ 粘性内容 ============

	private updateStickyContent(): void {
		const viewport = this.containerEl.querySelector<HTMLElement>('.timeline-viewport');
		if (!viewport) return;
		const scrollLeft = viewport.scrollLeft;
		const stickyLeft = scrollLeft + this.STICKY_LEFT;

		const sticks = this.containerEl.querySelectorAll<HTMLElement>(
			'.timeline-card.timeline-period > .card-sticky'
		);
		sticks.forEach((stick) => {
			const card = stick.parentElement;
			if (!card) return;
			const cardLeft = parseFloat(card.dataset.trackLeft ?? '0');
			const cardWidth = parseFloat(card.dataset.trackWidth ?? '0');
			const contentWidth = stick.offsetWidth || this.cardWidth;
			const desired = scrollLeft + this.STICKY_LEFT - cardLeft;
			const maxOffset = Math.max(0, cardWidth - contentWidth);
			const offset = Math.max(0, Math.min(desired, maxOffset));
			stick.style.transform = `translateX(${offset}px)`;
		});

		const badges = this.containerEl.querySelectorAll<HTMLElement>('.duration-badge');
		badges.forEach((badge) => {
			const cardEndX = parseFloat(badge.dataset.cardEndX ?? '0');
			const cursorX = parseFloat(badge.dataset.cursorX ?? '0');
			if (cardEndX <= scrollLeft) {
				badge.addClass('is-hidden');
			} else {
				badge.removeClass('is-hidden');
				const desiredLeft = cursorX + this.BADGE_OFFSET_X;
				badge.style.left = `${Math.max(desiredLeft, stickyLeft)}px`;
			}
		});
	}

	// ============ 分类规范化 ============

	private normalizeCategory(raw: string): string {
		if (!raw) return 'default';
		if (this.plugin.settings.categories.some((c) => c.id === raw)) return raw;
		const byLabel = this.plugin.settings.categories.find((c) => c.label === raw);
		if (byLabel) return byLabel.id;
		return raw;
	}

	private isCategoryTaken(value: string): boolean {
		return this.plugin.settings.categories.some(
			(c) => c.id === value || c.label === value
		);
	}

	private async registerNewCategoriesFromEvents(): Promise<void> {
		if (!this.plugin.settings.autoRegisterCategories) return;
		const used = new Set<string>();
		for (const e of this.events) used.add(e.category);
		let changed = false;
		for (const id of used) {
			if (id === 'default') continue;
			if (this.isCategoryTaken(id)) continue;
			this.plugin.settings.categories.push({
				id, label: id, color: this.pickAutoColor(),
			});
			changed = true;
		}
		if (changed) await this.plugin.saveSettings();
	}

	private pickAutoColor(): string {
		const idx = this.plugin.settings.categories.length % AUTO_COLOR_PALETTE.length;
		return AUTO_COLOR_PALETTE[idx] ?? '#95a5a6';
	}

	// ============ 筛选栏 ============

	private renderFilterBarContent(bar: HTMLElement): void {
		const categories = this.collectCategories();
		const tags = this.collectAllTags();

		if (categories.length > 0) {
			const group = bar.createDiv('filter-group');
			group.createSpan({ cls: 'filter-group-label', text: '分类' });
			for (const catId of categories) {
				const label = this.getCategoryLabel(catId);
				const color = this.getCategoryColor(catId);
				const hidden = this.hiddenCategories.has(catId);
				const btn = group.createEl('button', { cls: 'filter-chip', text: label });
				btn.style.borderColor = color;
				btn.style.color = color;
				if (!hidden) btn.style.background = this.hexToRgba(color, 0.15);
				if (hidden) btn.addClass('is-hidden');
				btn.onclick = () => {
					if (this.hiddenCategories.has(catId)) this.hiddenCategories.delete(catId);
					else this.hiddenCategories.add(catId);
					this.rerender();
				};
			}
		}

		if (tags.length > 0) {
			const group = bar.createDiv('filter-group');
			group.createSpan({ cls: 'filter-group-label', text: '标签' });
			for (const tag of tags) {
				const hidden = this.hiddenTags.has(tag);
				const btn = group.createEl('button', {
					cls: 'filter-chip filter-chip-tag', text: tag,
				});
				if (hidden) btn.addClass('is-hidden');
				btn.onclick = () => {
					if (this.hiddenTags.has(tag)) this.hiddenTags.delete(tag);
					else this.hiddenTags.add(tag);
					this.rerender();
				};
			}
		}

		if (this.hiddenCategories.size > 0 || this.hiddenTags.size > 0) {
			const resetBtn = bar.createEl('button', { cls: 'filter-reset', text: '重置' });
			resetBtn.onclick = () => {
				this.hiddenCategories.clear();
				this.hiddenTags.clear();
				this.rerender();
			};
		}
	}

	private isEventVisible(event: TimelineEvent): boolean {
		const known = this.plugin.settings.categories.some((c) => c.id === event.category);
		const effectiveCat = known ? event.category : 'default';
		if (this.hiddenCategories.has(effectiveCat)) return false;
		if (event.tags.some((t) => this.hiddenTags.has(t))) return false;
		return true;
	}

	// ============ 坐标基准 ============

	private updateBaseTime(): void {
		if (this.events.length === 0) {
			this.baseTime = Date.UTC(2000, 0, 1);
			return;
		}
		let minTs = Infinity;
		for (const e of this.events) {
			if (isFinite(e.dateTs)) minTs = Math.min(minTs, e.dateTs);
		}
		if (minTs === Infinity) {
			this.baseTime = Date.UTC(2000, 0, 1);
			return;
		}
		const d = new Date(minTs);
		d.setUTCMonth(d.getUTCMonth() - 6);
		this.baseTime = d.getTime();
	}

	// ============ 数据扫描 ============

	private async scanEvents(): Promise<void> {
		this.events = [];
		const files = this.app.vault.getMarkdownFiles();
		const dateField = this.plugin.settings.dateField;

		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (!fm) continue;

			const dateStr = normalizeDateValue(fm[dateField]);
			if (dateStr === null) continue;

			const parsedStart = parseFlexibleDate(dateStr);
			if (!parsedStart) {
				console.warn(`[Story Timeline] 无法解析日期 "${dateStr}"（${file.path}）`);
				continue;
			}

			const endDateStr = normalizeDateValue(fm.timelineEndDate);
			let parsedEnd: ParsedDate | null = null;
			if (endDateStr !== null) {
				parsedEnd = parseFlexibleDate(endDateStr);
				if (!parsedEnd) {
					console.warn(
						`[Story Timeline] 无法解析结束日期 "${endDateStr}"（${file.path}），已忽略`
					);
				}
			}

			const rawTitle: unknown = fm.timelineTitle;
			const rawDesc: unknown = fm.timelineDescription;
			const rawCat: unknown = fm.timelineCategory;
			const rawColor: unknown = fm.timelineColor;
			const rawTags: unknown = fm.timelineTags;

			const rawCatStr = typeof rawCat === 'string' ? rawCat : 'default';
			const normalizedCat = this.normalizeCategory(rawCatStr);

			const customColor =
				typeof rawColor === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(rawColor.trim())
					? rawColor.trim()
					: undefined;

			const event: TimelineEvent = {
				dateTs: parsedStart.ts,
				dateStr: parsedStart.raw,
				datePrecision: parsedStart.precision,
				title: typeof rawTitle === 'string' ? rawTitle : file.basename,
				description: typeof rawDesc === 'string' ? rawDesc : '',
				category: normalizedCat,
				color: customColor,
				tags: this.parseTags(rawTags),
				filePath: file.path,
				subEvents: this.parseSubEvents(fm.timelineSubEvents),
			};
			if (parsedEnd && parsedEnd.ts >= parsedStart.ts) {
				event.endTs = parsedEnd.ts;
				event.endStr = parsedEnd.raw;
				event.endPrecision = parsedEnd.precision;
			}
			this.events.push(event);
		}

		this.events.sort((a, b) => a.dateTs - b.dateTs);
	}

	private parseTags(raw: unknown): string[] {
		if (Array.isArray(raw)) {
			return raw
				.filter((t): t is string => typeof t === 'string')
				.map((t) => t.trim())
				.filter((t) => t.length > 0);
		}
		if (typeof raw === 'string') {
			return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
		}
		return [];
	}

	private parseSubEvents(raw: unknown): SubEvent[] {
		if (!Array.isArray(raw)) return [];
		const result: SubEvent[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') continue;
			const obj = item as Record<string, unknown>;
			const subDateStr = normalizeDateValue(obj.date);
			if (subDateStr === null) continue;
			const ps = parseFlexibleDate(subDateStr);
			if (!ps) continue;
			const sub: SubEvent = {
				dateTs: ps.ts, dateStr: ps.raw,
				title: typeof obj.title === 'string' ? obj.title : '',
			};
			const subEndStr = normalizeDateValue(obj.endDate);
			if (subEndStr !== null) {
				const pe = parseFlexibleDate(subEndStr);
				if (pe && pe.ts >= ps.ts) {
					sub.endTs = pe.ts; sub.endStr = pe.raw;
				}
			}
			if (typeof obj.link === 'string' && obj.link.trim().length > 0) {
				sub.link = parseWikiLink(obj.link.trim());
			}
			result.push(sub);
		}
		return result;
	}

	private collectAllTags(): string[] {
		const set = new Set<string>();
		for (const e of this.events) for (const t of e.tags) set.add(t);
		return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
	}

	// ============ 时间刻度（无极） ============

	/** 根据当前 zoomLevel 选择最合适的刻度规格 */
	private chooseTickSpec(): TickSpec {
		const pxPerDay = this.zoomLevel / 30;
		const MIN_PX = 70;
		for (const spec of TICK_SPECS) {
			if (spec.approxDays * pxPerDay >= MIN_PX) return spec;
		}
		return TICK_SPECS[TICK_SPECS.length - 1]!;
	}

	private getDateRange(): { startTs: number; endTs: number } | null {
		if (this.events.length === 0) return null;
		let minTs = Infinity;
		let maxTs = -Infinity;
		for (const e of this.events) {
			if (isFinite(e.dateTs)) minTs = Math.min(minTs, e.dateTs);
			const endTs = e.endTs ?? e.dateTs;
			if (isFinite(endTs)) maxTs = Math.max(maxTs, endTs);
		}
		if (minTs === Infinity || maxTs === -Infinity) return null;
		const startDate = new Date(minTs);
		startDate.setUTCMonth(startDate.getUTCMonth() - 6);
		const endDate = new Date(maxTs);
		endDate.setUTCMonth(endDate.getUTCMonth() + 6);
		return { startTs: startDate.getTime(), endTs: endDate.getTime() };
	}

	/** 找到 range 起点之后（或范围内）第一个刻度 */
	private getFirstTickStart(rangeStart: Date, spec: TickSpec): Date {
		const y = rangeStart.getUTCFullYear();
		const m = rangeStart.getUTCMonth();
		const d = rangeStart.getUTCDate();

		switch (spec.kind) {
			case 'week1':
			case 'week2': {
				const date = makeUTCDate(y, m, d);
				const dow = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
				const delta = dow === 0 ? -6 : 1 - dow;
				date.setUTCDate(date.getUTCDate() + delta);
				return date;
			}
			case 'month1':
				return makeUTCDate(y, m, 1);
			case 'month3': {
				const qm = Math.floor(m / 3) * 3;
				return makeUTCDate(y, qm, 1);
			}
			case 'month6':
				return makeUTCDate(y, m < 6 ? 0 : 6, 1);
			case 'year1':
				return makeUTCDate(y, 0, 1);
			case 'year5':
				return makeUTCDate(Math.floor(y / 5) * 5, 0, 1);
			case 'year10':
				return makeUTCDate(Math.floor(y / 10) * 10, 0, 1);
		}
	}

	private nextTick(cur: Date, spec: TickSpec): Date {
		const y = cur.getUTCFullYear();
		const m = cur.getUTCMonth();

		switch (spec.kind) {
			case 'week1': {
				const d = new Date(cur);
				d.setUTCDate(d.getUTCDate() + 7);
				return d;
			}
			case 'week2': {
				const d = new Date(cur);
				d.setUTCDate(d.getUTCDate() + 14);
				return d;
			}
			case 'month1':
				return makeUTCDate(y, m + 1, 1);
			case 'month3':
				return makeUTCDate(y, m + 3, 1);
			case 'month6':
				return makeUTCDate(y, m + 6, 1);
			case 'year1':
				return makeUTCDate(y + 1, 0, 1);
			case 'year5':
				return makeUTCDate(y + 5, 0, 1);
			case 'year10':
				return makeUTCDate(y + 10, 0, 1);
		}
	}

	private formatTickLabel(date: Date, spec: TickSpec): string {
		const y = date.getUTCFullYear();
		const m = date.getUTCMonth();

		switch (spec.kind) {
			case 'week1':
			case 'week2':
				return `${y}-W${String(isoWeek(date)).padStart(2, '0')}`;
			case 'month1':
				return `${y}-${String(m + 1).padStart(2, '0')}`;
			case 'month3':
				return `${y} Q${Math.floor(m / 3) + 1}`;
			case 'month6':
				return `${y} H${m < 6 ? 1 : 2}`;
			case 'year1':
				return `${y}`;
			case 'year5':
			case 'year10':
				return `${y}`;
		}
	}

	private renderScale(track: HTMLElement, trackWidth: number): void {
		const scale = track.createDiv('timeline-scale');
		scale.style.minWidth = `${trackWidth}px`;

		const range = this.getDateRange();
		if (!range) return;

		const spec = this.chooseTickSpec();
		const startDate = new Date(range.startTs);
		let cursor = this.getFirstTickStart(startDate, spec);

		let safety = 1000;
		while (
			cursor.getTime() < range.startTs - 366 * ONE_DAY_MS &&
			safety-- > 0
		) {
			cursor = this.nextTick(cursor, spec);
		}

		safety = 2000;
		while (cursor.getTime() <= range.endTs && safety-- > 0) {
			const x = this.tsToPixels(cursor.getTime());
			const tick = scale.createDiv('timeline-tick');
			tick.style.left = `${x}px`;
			tick.dataset.ts = String(cursor.getTime()); // 导出时用
			tick.createDiv('tick-line');
			const label = tick.createDiv('tick-label');
			label.textContent = this.formatTickLabel(cursor, spec);

			const tickTs = cursor.getTime();
			tick.addClass('is-clickable');
			tick.onclick = (ev) => {
				ev.stopPropagation();
				this.cursorTs = tickTs;
				this.updateCursorDisplay();
			};

			cursor = this.nextTick(cursor, spec);
		}
	}

	// ============ 游标 & 徽章 ============

	private formatCursorLabel(ts: number): string {
		const d = new Date(ts);
		const y = d.getUTCFullYear();
		const m = d.getUTCMonth() + 1;
		if (m === 1) return `${y}`;
		return `${y}-${String(m).padStart(2, '0')}`;
	}

	private updateCursorDisplay(): void {
		const track = this.containerEl.querySelector<HTMLElement>('.timeline-track');
		if (!track) return;
		track.querySelector('.timeline-cursor')?.remove();
		track.querySelector('.duration-badge-layer')?.remove();
		this.containerEl.querySelectorAll('.timeline-card.is-cursor-hit').forEach((c) => {
			c.removeClass('is-cursor-hit');
		});

		if (this.cursorTs === null) {
			this.updateStickyContent();
			return;
		}

		const cursorX = this.tsToPixels(this.cursorTs);
		const line = track.createDiv('timeline-cursor');
		line.style.left = `${cursorX}px`;
		line.createDiv('cursor-label').textContent = this.formatCursorLabel(this.cursorTs);

		this.renderCursorBadges(track, cursorX);
		this.updateStickyContent();
	}

	private renderCursorBadges(track: HTMLElement, cursorX: number): void {
		const cursorTs = this.cursorTs;
		if (cursorTs === null) return;
		const cards = track.querySelectorAll<HTMLElement>('.timeline-card.timeline-period');
		if (cards.length === 0) return;

		const layer = track.createDiv('duration-badge-layer');
		let count = 0;

		cards.forEach((card) => {
			const startTs = parseFloat(card.dataset.startTs ?? '0');
			const endTs = parseFloat(card.dataset.endTs ?? '0');
			if (cursorTs < startTs || cursorTs > endTs) return;

			const cardLeft = parseFloat(card.dataset.trackLeft ?? '0');
			const cardWidth = parseFloat(card.dataset.trackWidth ?? '0');
			const cardEndX = cardLeft + cardWidth;
			const cardTop = parseFloat(card.dataset.measuredTop ?? '0');
			const cardHeight = parseFloat(card.dataset.measuredHeight ?? '0');
			const laneEl = card.closest<HTMLElement>('.timeline-lane');
			const laneTop = laneEl ? laneEl.offsetTop : 0;

			const badge = layer.createDiv('duration-badge');
			badge.textContent = formatDuration(cursorTs - startTs);
			badge.dataset.cardEndX = String(cardEndX);
			badge.dataset.cursorX = String(cursorX);

			const centerY = laneTop + cardTop + cardHeight / 2;
			badge.style.top = `${centerY}px`;
			badge.style.left = `${cursorX + this.BADGE_OFFSET_X}px`;

			card.addClass('is-cursor-hit');
			count++;
		});

		if (count === 0) layer.remove();
	}

	// ============ 导出图片 ============

	private openExportModal(): void {
		const modal = new ExportModal(this.app, {}, (opts) => {
			void this.exportAsImage(opts);
		});
		modal.open();
	}

	private async exportAsImage(opts: ExportOptions): Promise<void> {
		const track = this.containerEl.querySelector<HTMLElement>('.timeline-track');
		if (!track) {
			new Notice('找不到时间线');
			return;
		}

		const range = this.getDateRange();
		if (!range) {
			new Notice('时间线为空，无法导出');
			return;
		}

		// ========== 1. 解析用户区间 ==========
		const startParsed = opts.startDate ? parseFlexibleDate(opts.startDate) : null;
		const endParsed = opts.endDate ? parseFlexibleDate(opts.endDate) : null;

		if (opts.startDate && !startParsed) {
			new Notice(`无法解析开始日期："${opts.startDate}"`);
			return;
		}
		if (opts.endDate && !endParsed) {
			new Notice(`无法解析结束日期："${opts.endDate}"`);
			return;
		}

		// ========== 2. 收集所有卡片的实际像素边界 ==========
		const allCards = Array.from(track.querySelectorAll<HTMLElement>('.timeline-card'));
		const cardBounds: Array<{ el: HTMLElement; left: number; right: number }> = [];

		for (const card of allCards) {
			const tl = parseFloat(card.dataset.trackLeft ?? 'NaN');
			const tw = parseFloat(card.dataset.trackWidth ?? 'NaN');
			if (!isFinite(tl) || !isFinite(tw)) continue;
			cardBounds.push({ el: card, left: tl, right: tl + tw });
		}

		if (cardBounds.length === 0) {
			new Notice('没有可导出的卡片');
			return;
		}

		// ========== 3. 确定实际导出边界 ==========
		// 规则：
		//   - 用户填了某侧日期 → 严格按该时间点截断（允许卡片被切）
		//   - 用户没填某侧     → 用事件范围 + 扩展到完整卡片避免被切
		let baseStartX: number;
		let baseEndX: number;

		if (startParsed) {
			baseStartX = this.tsToPixels(startParsed.ts);
		} else {
			baseStartX = this.tsToPixels(range.startTs);
			for (const { left, right } of cardBounds) {
				if (left < baseStartX && right > baseStartX) baseStartX = left;
			}
		}

		if (endParsed) {
			baseEndX = this.tsToPixels(endParsed.ts);
		} else {
			baseEndX = this.tsToPixels(range.endTs);
			for (const { left, right } of cardBounds) {
				if (left < baseEndX && right > baseEndX) baseEndX = right;
			}
		}

		// 用户填了区间时用较小 padding；没填时用较大 padding
		const PADDING_LEFT = startParsed ? 20 : 40;
		const PADDING_RIGHT = endParsed ? 20 : 40;

		const startX = Math.max(0, baseStartX - PADDING_LEFT);
		const endX = baseEndX + PADDING_RIGHT;
		const W = endX - startX;
		const H = Math.max(track.scrollHeight, 200);

		// ========== 4. 选择 dpr ==========
		const MAX_DIM = 16000;
		const MAX_AREA = 268_000_000;

		let dpr = 2;
		const candidates = [2, 1.5, 1.25, 1, 0.75, 0.5];
		for (const c of candidates) {
			if (W * c <= MAX_DIM && H * c <= MAX_DIM && W * c * H * c <= MAX_AREA) {
				dpr = c;
				break;
			}
		}

		const canvasW = Math.ceil(W * dpr);
		const canvasH = Math.ceil(H * dpr);

		if (canvasW > MAX_DIM || canvasH > MAX_DIM) {
			new Notice(
				`时间线太长（${W}×${H}px），超出浏览器 Canvas 尺寸上限（${MAX_DIM}px）。\n` +
				`建议：缩小时间轴，或缩短导出区间后再试。`,
				10000
			);
			return;
		}

		console.debug(
			`[Story Timeline] 导出: ${Math.round(W)}×${Math.round(H)}px, dpr=${dpr}, canvas=${canvasW}×${canvasH}`
		);

		// ========== 5. 初始化画布 ==========
		const canvas = document.createElement('canvas');
		canvas.width = canvasW;
		canvas.height = canvasH;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			new Notice('无法创建画布');
			return;
		}
		ctx.scale(dpr, dpr);

		const cs = getComputedStyle(document.body);
		const bgColor = cs.getPropertyValue('--background-primary').trim() || '#ffffff';
		const subColor = cs.getPropertyValue('--background-secondary').trim() || '#f5f5f5';
		const textColor = cs.getPropertyValue('--text-normal').trim() || '#222222';
		const textSecondary = cs.getPropertyValue('--text-secondary').trim() || '#666666';
		const mutedColor = cs.getPropertyValue('--text-muted').trim() || '#888888';
		const borderColor = cs.getPropertyValue('--background-modifier-border').trim() || '#dddddd';

		ctx.fillStyle = bgColor;
		ctx.fillRect(0, 0, W, H);

		// 文本截断工具
		const fitText = (text: string, maxW: number, font: string): string => {
			ctx.font = font;
			if (ctx.measureText(text).width <= maxW) return text;
			let s = text;
			while (s.length > 1 && ctx.measureText(s + '…').width > maxW) {
				s = s.slice(0, -1);
			}
			return s + '…';
		};

		// ========== 6. 绘制刻度条 ==========
		const scaleEl = track.querySelector<HTMLElement>('.timeline-scale');
		const scaleH = scaleEl?.offsetHeight ?? 26;

		ctx.fillStyle = bgColor;
		ctx.fillRect(0, 0, W, scaleH);
		ctx.strokeStyle = borderColor;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, scaleH);
		ctx.lineTo(W, scaleH);
		ctx.stroke();

		if (scaleEl) {
			const ticks = scaleEl.querySelectorAll<HTMLElement>('.timeline-tick');
			ticks.forEach((tick) => {
				const ts = parseFloat(tick.dataset.ts ?? 'NaN');
				if (!isFinite(ts)) return;
				const x = this.tsToPixels(ts) - startX;
				if (x < -1 || x > W + 1) return;

				ctx.strokeStyle = borderColor;
				ctx.beginPath();
				ctx.moveTo(x, 0);
				ctx.lineTo(x, scaleH);
				ctx.stroke();

				const label = tick.querySelector<HTMLElement>('.tick-label');
				if (label) {
					ctx.fillStyle = mutedColor;
					ctx.font = '11px sans-serif';
					ctx.textBaseline = 'top';
					ctx.fillText(label.textContent ?? '', x + 4, 6);
				}
			});
		}

		// ========== 7. 绘制每条轨道 ==========
		const lanes = track.querySelectorAll<HTMLElement>('.timeline-lane');

		lanes.forEach((lane) => {
			const laneTop = scaleH + lane.offsetTop;
			const laneH = lane.offsetHeight;

			// lane 背景
			ctx.fillStyle = subColor;
			ctx.fillRect(0, laneTop, W, laneH);

			// lane 底边虚线
			ctx.strokeStyle = borderColor;
			ctx.setLineDash([4, 4]);
			ctx.beginPath();
			ctx.moveTo(0, laneTop + laneH);
			ctx.lineTo(W, laneTop + laneH);
			ctx.stroke();
			ctx.setLineDash([]);

			// 该 lane 的卡片
			const cards = lane.querySelectorAll<HTMLElement>('.timeline-card');

			cards.forEach((card) => {
				const tl = parseFloat(card.dataset.trackLeft ?? 'NaN');
				const tw = parseFloat(card.dataset.trackWidth ?? 'NaN');
				if (!isFinite(tl) || !isFinite(tw)) return;

				const cardX = tl - startX;
				const cardW = tw;

				// 完全在区间外的卡片直接跳过
				if (cardX + cardW < 0 || cardX > W) return;

				// ====== 高度自适应：取屏幕测量高度和内容实际高度的较大值 ======
				const measuredTop = parseFloat(card.dataset.measuredTop ?? '0');
				const measuredH = parseFloat(card.dataset.measuredHeight ?? '0');

				const stickyEl = card.querySelector<HTMLElement>('.card-sticky');
				const subEventsEl = card.querySelector<HTMLElement>('.sub-events');

				const stickyContentH = stickyEl ? stickyEl.scrollHeight : 0;
				const subEventsH = subEventsEl ? subEventsEl.offsetHeight : 0;
				// 内容总高（padding 大概 6+6=12，加一点余量）
				const contentNeededH = stickyContentH + subEventsH + 16;
				const cardH = Math.max(measuredH, contentNeededH, 40);
				const cardY = laneTop + measuredTop;

				// 卡片背景
				const cardBg = getComputedStyle(card).backgroundColor;
				ctx.fillStyle = cardBg;
				ctx.fillRect(cardX, cardY, cardW, cardH);

				// 卡片边框
				const borderCol = card.style.borderColor || mutedColor;
				ctx.strokeStyle = borderCol;
				ctx.lineWidth = 2;
				ctx.strokeRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2);

				// ====== 绘制卡片内容（支持左侧截断时的粘性显示） ======
				const visibleLeft = Math.max(0, cardX);
				const visibleRight = Math.min(W, cardX + cardW);
				const visibleWidth = visibleRight - visibleLeft;
				const isLeftClipped = cardX < 0;

				if (visibleWidth <= 0) {
					ctx.restore();
					return;
				}

				ctx.save();
				ctx.beginPath();
				ctx.rect(visibleLeft, cardY, visibleWidth, cardH);
				ctx.clip();

				const contentLeft = visibleLeft + 10;
				const contentMaxW = Math.max(20, visibleWidth - 20);
				let contentY = cardY + 6;

				// 左边界被截断时，计算"已过 X"
				let elapsedText = '';
				if (isLeftClipped) {
					const cardStartTs = parseFloat(card.dataset.startTs ?? '0');
					const exportLeftTs = this.pixelsToTs(startX);
					const elapsedMs = exportLeftTs - cardStartTs;
					if (elapsedMs > 0) {
						elapsedText = formatDuration(elapsedMs);
					}
				}

				if (stickyEl) {
					// ====== 日期 + 时长徽章 ======
					const dateEl = stickyEl.querySelector<HTMLElement>('.card-date');
					const dateStr = dateEl?.textContent ?? '';

					if (dateStr || elapsedText) {
						ctx.textBaseline = 'top';
						let cursorX = contentLeft;

						if (dateStr) {
							const dateDisplay = fitText(dateStr, contentMaxW, '11px sans-serif');
							ctx.fillStyle = mutedColor;
							ctx.font = '11px sans-serif';
							ctx.fillText(dateDisplay, cursorX, contentY);
							cursorX += ctx.measureText(dateDisplay).width + 8;
						}

						// "已过 X" 胶囊徽章
						if (elapsedText) {
							ctx.font = 'bold 10px sans-serif';
							const textW = ctx.measureText(elapsedText).width;
							const badgeW = textW + 12;
							const badgeH = 14;

							if (cursorX + badgeW <= visibleRight - 8) {
								const accentColor =
									cs.getPropertyValue('--interactive-accent').trim() || '#4a9eff';
								const onAccent =
									cs.getPropertyValue('--text-on-accent').trim() || '#ffffff';

								// 圆角矩形
								const bx = cursorX;
								const by = contentY - 1;
								const r = badgeH / 2;
								ctx.fillStyle = accentColor;
								ctx.beginPath();
								ctx.moveTo(bx + r, by);
								ctx.lineTo(bx + badgeW - r, by);
								ctx.quadraticCurveTo(bx + badgeW, by, bx + badgeW, by + r);
								ctx.lineTo(bx + badgeW, by + badgeH - r);
								ctx.quadraticCurveTo(bx + badgeW, by + badgeH, bx + badgeW - r, by + badgeH);
								ctx.lineTo(bx + r, by + badgeH);
								ctx.quadraticCurveTo(bx, by + badgeH, bx, by + badgeH - r);
								ctx.lineTo(bx, by + r);
								ctx.quadraticCurveTo(bx, by, bx + r, by);
								ctx.closePath();
								ctx.fill();

								ctx.fillStyle = onAccent;
								ctx.textBaseline = 'middle';
								ctx.fillText(elapsedText, bx + 6, by + badgeH / 2);
							}
						}

						contentY += 16;
					}

					// ====== 标题 ======
					const titleEl = stickyEl.querySelector<HTMLElement>('.card-title');
					if (titleEl) {
						const t = titleEl.textContent ?? '';
						const display = fitText(t, contentMaxW, 'bold 13px sans-serif');
						ctx.fillStyle = textColor;
						ctx.font = 'bold 13px sans-serif';
						ctx.textBaseline = 'top';
						ctx.fillText(display, contentLeft, contentY);
						contentY += 20;
					}

					// ====== 描述 ======
					if (opts.includeDescription) {
						const descEl = stickyEl.querySelector<HTMLElement>('.card-desc');
						if (descEl) {
							const t = descEl.textContent ?? '';
							const display = fitText(t, contentMaxW, '11px sans-serif');
							ctx.fillStyle = textSecondary;
							ctx.font = '11px sans-serif';
							ctx.textBaseline = 'top';
							ctx.fillText(display, contentLeft, contentY);
							contentY += 16;
						}
					}

					// ====== 标签 ======
					if (opts.includeTags) {
						const tagRow = stickyEl.querySelector<HTMLElement>('.card-tags');
						if (tagRow) {
							let tagX = contentLeft;
							const tagY = contentY;
							const tagEls = tagRow.querySelectorAll<HTMLElement>('.card-tag');
							tagEls.forEach((tagEl) => {
								const tagText = tagEl.textContent ?? '';
								ctx.font = '10px sans-serif';
								const tagW = ctx.measureText(tagText).width + 12;
								if (tagX + tagW > visibleRight - 8) return;

								ctx.fillStyle = subColor;
								ctx.fillRect(tagX, tagY, tagW, 15);
								ctx.strokeStyle = borderColor;
								ctx.lineWidth = 1;
								ctx.strokeRect(tagX + 0.5, tagY + 0.5, tagW - 1, 14);

								ctx.fillStyle = mutedColor;
								ctx.textBaseline = 'middle';
								ctx.fillText(tagText, tagX + 6, tagY + 7.5);

								tagX += tagW + 3;
							});
						}
					}
				}

				// ====== 绘制子事件 ======
				if (opts.includeSubEvents && subEventsEl) {
					const subRowTop = cardY + subEventsEl.offsetTop;

					// 子事件区分隔线
					ctx.strokeStyle = borderColor;
					ctx.setLineDash([3, 3]);
					ctx.beginPath();
					ctx.moveTo(Math.max(cardX + 4, visibleLeft + 4), subRowTop);
					ctx.lineTo(Math.min(cardX + cardW - 4, visibleRight - 4), subRowTop);
					ctx.stroke();
					ctx.setLineDash([]);

					const blocks = subEventsEl.querySelectorAll<HTMLElement>('.sub-event-block');
					blocks.forEach((block) => {
						const bx = cardX + block.offsetLeft;
						const by = subRowTop + block.offsetTop;
						const bw = block.offsetWidth;
						const bh = block.offsetHeight;

						// 完全在可见区域外则跳过
						if (bx + bw < visibleLeft || bx > visibleRight) return;

						const blockCs = getComputedStyle(block);
						const blockBg = blockCs.backgroundColor;
						if (blockBg && blockBg !== 'transparent' && blockBg !== 'rgba(0, 0, 0, 0)') {
							ctx.fillStyle = blockBg;
							ctx.fillRect(bx, by, bw, bh);
						}

						const blockText = block.textContent ?? '';
						if (blockText && bw > 20) {
							ctx.save();
							ctx.beginPath();
							ctx.rect(bx, by, bw, bh);
							ctx.clip();

							const display = fitText(blockText, bw - 8, '10px sans-serif');
							ctx.fillStyle = blockCs.color || mutedColor;
							ctx.font = '10px sans-serif';
							ctx.textBaseline = 'middle';
							ctx.textAlign = 'center';
							ctx.fillText(display, bx + bw / 2, by + bh / 2);

							ctx.textAlign = 'start';
							ctx.restore();
						}
					});
				}

				ctx.restore();
			});

			// ====== 轨道标签（固定在 lane 左上角，不随滚动） ======
			const labelEl = lane.querySelector<HTMLElement>('.timeline-lane-label');
			if (labelEl) {
				const labelText = labelEl.textContent ?? '';
				ctx.font = 'bold 12px sans-serif';
				const textW = ctx.measureText(labelText).width;
				const labelW = textW + 20;
				const labelH = 22;
				const labelX = 8;
				const labelY = laneTop + 6;

				ctx.fillStyle = bgColor;
				ctx.fillRect(labelX, labelY, labelW, labelH);
				ctx.strokeStyle = borderColor;
				ctx.lineWidth = 1;
				ctx.strokeRect(labelX + 0.5, labelY + 0.5, labelW - 1, labelH - 1);

				ctx.fillStyle = textColor;
				ctx.font = 'bold 12px sans-serif';
				ctx.textBaseline = 'middle';
				ctx.fillText(labelText, labelX + 10, labelY + labelH / 2);
			}
		});

		// ========== 8. 下载 ==========
		canvas.toBlob((blob) => {
			if (!blob) {
				console.debug('[Story Timeline] toBlob 返回 null，尺寸:', canvasW, '×', canvasH);
				new Notice(
					`导出失败：画布过大（${canvasW}×${canvasH}）。\n请缩小时间轴或缩短区间后重试。`,
					8000
				);
				return;
			}
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
			a.href = url;
			a.download = `story-timeline-${stamp}.png`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(() => URL.revokeObjectURL(url), 2000);
			new Notice(`时间线截图已导出（${canvasW}×${canvasH}）`);
		}, 'image/png');
	}

	// ============ 布局：重叠检测 ============

	private computeLayout(events: TimelineEvent[]): {
		boxes: LayoutBox[];
		maxLayer: number;
	} {
		const boxes: LayoutBox[] = events.map((e) => {
			const startX = this.tsToPixels(e.dateTs);
			let endX: number;
			if (e.endTs !== undefined) {
				const realEndX = this.tsToPixels(e.endTs);
				endX = Math.max(realEndX, startX + this.cardWidth * 0.6);
			} else {
				endX = startX + this.cardWidth;
			}
			return { event: e, startX, endX, layer: -1 };
		});

		boxes.sort((a, b) => a.startX - b.startX);
		const layers: LayoutBox[][] = [];

		for (const box of boxes) {
			let placed = false;
			for (let i = 0; i < layers.length; i++) {
				const layer = layers[i];
				if (!layer) continue;
				const conflict = layer.some(
					(other) =>
						!(
							box.endX + this.CARD_H_GAP < other.startX ||
							box.startX > other.endX + this.CARD_H_GAP
						)
				);
				if (!conflict) {
					box.layer = i;
					layer.push(box);
					placed = true;
					break;
				}
			}
			if (!placed) {
				box.layer = layers.length;
				layers.push([box]);
			}
		}

		return { boxes, maxLayer: Math.max(1, layers.length) };
	}

	// ============ 轨道渲染 ============

	private renderTimeline(viewport: HTMLElement): void {
		const track = viewport.createDiv('timeline-track');
		const trackWidth = this.calculateTrackWidth();
		track.style.minWidth = `${trackWidth}px`;

		this.renderScale(track, trackWidth);

		const visibleEvents = this.events.filter((e) => this.isEventVisible(e));
		const grouped = new Map<string, TimelineEvent[]>();
		for (const event of visibleEvents) {
			const known = this.plugin.settings.categories.some((c) => c.id === event.category);
			const key = known ? event.category : 'default';
			if (!grouped.has(key)) grouped.set(key, []);
			grouped.get(key)?.push(event);
		}

		const order = this.plugin.settings.categories.map((c) => c.id);
		const categories = Array.from(grouped.keys()).filter(
			(cat) => !this.hiddenCategories.has(cat)
		);
		categories.sort((a, b) => {
			const ai = order.indexOf(a);
			const bi = order.indexOf(b);
			if (ai >= 0 && bi >= 0) return ai - bi;
			if (ai >= 0) return -1;
			if (bi >= 0) return 1;
			if (a === 'default') return 1;
			if (b === 'default') return -1;
			return a.localeCompare(b);
		});

		for (const cat of categories) {
			const laneEvents = grouped.get(cat) ?? [];
			const { boxes } = this.computeLayout(laneEvents);

			const lane = track.createDiv('timeline-lane');
			lane.dataset.category = cat;
			lane.style.minWidth = `${trackWidth}px`;
			lane.style.height = `${this.LANE_UNIT_HEIGHT}px`;

			const label = lane.createDiv('timeline-lane-label');
			label.textContent = this.getCategoryLabel(cat);

			for (const box of boxes) {
				this.createCard(lane, box);
			}
		}

		window.requestAnimationFrame(() => {
			this.finalizeLaneLayout(track);
			this.updateCursorDisplay();
			this.updateStickyContent();
		});

		this.autoScrollToFirst(viewport);
	}

	private finalizeLaneLayout(track: HTMLElement): void {
		const lanes = track.querySelectorAll<HTMLElement>('.timeline-lane');
		lanes.forEach((lane) => {
			const cards = Array.from(lane.querySelectorAll<HTMLElement>('.timeline-card'));
			if (cards.length === 0) {
				lane.style.height = `${this.LANE_UNIT_HEIGHT}px`;
				return;
			}

			const byLayer = new Map<number, HTMLElement[]>();
			for (const card of cards) {
				const layer = parseInt(card.dataset.layer ?? '0', 10);
				if (!byLayer.has(layer)) byLayer.set(layer, []);
				byLayer.get(layer)!.push(card);
			}

			const layerNums = Array.from(byLayer.keys()).sort((a, b) => a - b);

			const layerHeights: number[] = [];
			for (const ln of layerNums) {
				let maxH = this.MIN_CARD_HEIGHT;
				for (const card of byLayer.get(ln)!) {
					const h = card.offsetHeight;
					if (h > maxH) maxH = h;
				}
				layerHeights.push(maxH);
			}

			let top = 0;
			for (let i = 0; i < layerNums.length; i++) {
				const ln = layerNums[i]!;
				const h = layerHeights[i]!;
				for (const card of byLayer.get(ln)!) {
					const cardTop = top + this.CARD_V_MARGIN;
					card.style.setProperty('--card-top', `${cardTop}px`);
					card.style.setProperty('--card-height', `${h}px`);
					card.dataset.measuredTop = String(cardTop);
					card.dataset.measuredHeight = String(h);
					card.removeClass('is-measuring');
				}
				top += h + this.CARD_V_MARGIN * 2;
			}
			lane.style.height = `${top}px`;
		});
	}

	private calculateTrackWidth(): number {
		const range = this.getDateRange();
		if (!range) return 2000;
		const endX = this.tsToPixels(range.endTs);
		return Math.max(2000, endX + this.RIGHT_PADDING);
	}

	private collectCategories(): string[] {
		const set = new Set<string>();
		for (const cat of this.plugin.settings.categories) {
			if (cat.id !== 'default') set.add(cat.id);
		}
		for (const event of this.events) {
			if (event.category !== 'default') set.add(event.category);
		}
		const order = this.plugin.settings.categories.map((c) => c.id);
		const arr = Array.from(set);
		arr.sort((a, b) => {
			const ai = order.indexOf(a);
			const bi = order.indexOf(b);
			if (ai >= 0 && bi >= 0) return ai - bi;
			if (ai >= 0) return -1;
			if (bi >= 0) return 1;
			return a.localeCompare(b);
		});
		arr.push('default');
		return arr;
	}

	private getCategoryLabel(id: string): string {
		return this.plugin.settings.categories.find((c) => c.id === id)?.label ?? id;
	}

	private getCategoryColor(id: string): string {
		const cat = this.plugin.settings.categories.find((c) => c.id === id);
		if (cat) return cat.color;
		const def = this.plugin.settings.categories.find((c) => c.id === 'default');
		return def?.color ?? '#95a5a6';
	}

	private createCard(lane: HTMLElement, box: LayoutBox): void {
		const event = box.event;
		const hasPeriod = event.endTs !== undefined;

		const card = lane.createDiv('timeline-card');
		if (hasPeriod) card.addClass('timeline-period');
		card.addClass(`card-precision-${event.datePrecision}`);
		if (box.layer > 0) card.addClass('is-layered');
		card.addClass('is-measuring');

		const cardWidthPx = box.endX - box.startX;

		card.dataset.trackLeft = String(box.startX);
		card.dataset.trackWidth = String(cardWidthPx);
		card.dataset.layer = String(box.layer);
		card.dataset.startTs = String(event.dateTs);
		card.dataset.endTs = String(event.endTs ?? event.dateTs);

		const color = event.color ?? this.getCategoryColor(event.category);
		card.style.left = `${box.startX}px`;
		card.style.width = `${cardWidthPx}px`;
		card.style.borderColor = color;

		if (hasPeriod) {
			card.style.background = this.hexToRgba(color, 0.08);
		}

		const sticky = card.createDiv('card-sticky');
		sticky.style.width = `${Math.min(this.cardWidth, cardWidthPx)}px`;

		const dateStr = hasPeriod
			? `${event.dateStr} → ${event.endStr ?? ''}`
			: event.dateStr;
		const dateEl = sticky.createDiv({ cls: 'card-date', text: dateStr });
		if (hasPeriod) dateEl.addClass('card-date-range');
		if (event.datePrecision !== 'day') dateEl.addClass('card-date-fuzzy');

		sticky.createDiv({ cls: 'card-title', text: event.title });

		if (this.plugin.settings.showDescription && event.description) {
			sticky.createDiv({ cls: 'card-desc', text: event.description });
		}

		if (this.plugin.settings.showTags && event.tags.length > 0) {
			const tagRow = sticky.createDiv('card-tags');
			for (const tag of event.tags) {
				tagRow.createSpan({ cls: 'card-tag', text: tag });
			}
		}

		if (hasPeriod && event.subEvents.length > 0 && event.endTs !== undefined) {
			const subRow = card.createDiv('sub-events');
			const totalSpan = event.endTs - event.dateTs;
			const parentStart = event.dateTs;

			for (const sub of event.subEvents) {
				const subStart = sub.dateTs;
				const subEnd = sub.endTs ?? event.endTs;

				const leftPct = ((subStart - parentStart) / totalSpan) * 100;
				const widthPct = ((subEnd - subStart) / totalSpan) * 100;
				const block = subRow.createDiv('sub-event-block');
				block.style.setProperty('--sub-left', `${leftPct}%`);
				block.style.setProperty('--sub-width', `${widthPct}%`);
				block.style.setProperty('--sub-bg', this.hexToRgba(color, 0.32));
				block.style.setProperty('--sub-bg-hover', this.hexToRgba(color, 0.5));
				block.style.setProperty('--sub-border', this.hexToRgba(color, 0.55));
				block.textContent = sub.title;
				block.title = sub.endStr ? `${sub.dateStr} → ${sub.endStr}` : sub.dateStr;

				if (sub.link) {
					const link = sub.link;
					block.addClass('has-link');
					block.onclick = (ev) => {
						ev.stopPropagation();
						void this.openSubEventLink(link);
					};
				}
			}
		}

		card.onclick = () => {
			const file = this.app.vault.getAbstractFileByPath(event.filePath);
			if (file instanceof TFile) {
				void this.app.workspace.getLeaf(false).openFile(file);
			}
		};

		card.addEventListener('contextmenu', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.showCardContextMenu(ev, event);
		});
	}

	private async openSubEventLink(link: string): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		const target = files.find(
			(f) =>
				f.basename === link ||
				f.path === link ||
				f.path === `${link}.md` ||
				f.basename === link.replace(/\.md$/, '')
		);
		if (target) {
			await this.app.workspace.getLeaf(false).openFile(target);
		} else {
			await this.app.workspace.openLinkText(link, '', false);
		}
	}

	private autoScrollToFirst(viewport: HTMLElement): void {
		if (this.initialScrollDone) return;
		if (this.events.length === 0) return;
		const first = this.events[0];
		if (!first) return;
		this.initialScrollDone = true;
		const targetLeft = Math.max(0, this.tsToPixels(first.dateTs) - 100);
		void viewport.scrollWidth;
		viewport.scrollLeft = targetLeft;
	}

	// ============ 工具方法 ============

	private tsToPixels(ts: number): number {
		if (!isFinite(ts)) return this.LEFT_PADDING;
		const days = (ts - this.baseTime) / ONE_DAY_MS;
		return this.LEFT_PADDING + (days * this.zoomLevel) / 30;
	}
	/** 像素 → 时间戳（tsToPixels 的逆运算） */
	private pixelsToTs(px: number): number {
		const days = (px - this.LEFT_PADDING) * 30 / this.zoomLevel;
		return this.baseTime + days * ONE_DAY_MS;
	}
	private hexToRgba(hex: string, alpha: number): string {
		const m = hex.replace('#', '');
		if (m.length !== 6) return `rgba(149,165,166,${alpha})`;
		const r = parseInt(m.substring(0, 2), 16);
		const g = parseInt(m.substring(2, 4), 16);
		const b = parseInt(m.substring(4, 6), 16);
		return `rgba(${r},${g},${b},${alpha})`;
	}

	private pan(offset: number): void {
		const viewport = this.containerEl.querySelector<HTMLElement>('.timeline-viewport');
		if (viewport) viewport.scrollLeft += offset;
	}

	async onClose(): Promise<void> {
		if (this.stickyRafId) {
			window.cancelAnimationFrame(this.stickyRafId);
			this.stickyRafId = 0;
		}
		if (this.autoRefreshTimer) {
			window.clearTimeout(this.autoRefreshTimer);
			this.autoRefreshTimer = 0;
		}
	}
}
