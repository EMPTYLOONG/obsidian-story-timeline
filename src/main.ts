import { Plugin, WorkspaceLeaf } from 'obsidian';
import { TimelineView, TIMELINE_VIEW_TYPE } from './TimelineView';
import { TimelineSettingTab, migrateSettings, TimelineSettings } from './settings';

export default class StoryTimelinePlugin extends Plugin {
	settings!: TimelineSettings;

	async onload() {
		await this.loadSettings();

		// 注册自定义视图
		this.registerView(
			TIMELINE_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new TimelineView(leaf, this)
		);

		// 左侧 Ribbon 图标
		this.addRibbonIcon('clock', '打开故事时间线', () => {
			void this.activateTimelineView();
		});

		// 命令面板命令
		this.addCommand({
			id: 'open-story-timeline',
			name: '打开故事时间线',
			callback: () => void this.activateTimelineView(),
		});

		// 设置面板
		this.addSettingTab(new TimelineSettingTab(this.app, this));
	}

	async activateTimelineView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(TIMELINE_VIEW_TYPE)[0] ?? null;

		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({
					type: TIMELINE_VIEW_TYPE,
					active: true,
				});
				leaf = rightLeaf;
			}
		}

		if (leaf) void workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = migrateSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
