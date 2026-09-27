import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const DEFAULT_PLACEHOLDER_FILENAME = ".gitkeep";
const DEFAULT_PLACEHOLDER_CONTENT = "";

// ─────────────────────────────────────────────
// SVG icons
// ─────────────────────────────────────────────

const SVG_TRASH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

const SVG_SCAN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>`;

// ─────────────────────────────────────────────
// Types & Settings
// ─────────────────────────────────────────────

interface AutoPlaceholderSettings {
	/** Whether automatic placeholder creation is enabled */
	autoEnabled: boolean;

	/** Filename created inside each managed folder */
	placeholderFilename: string;

	/** Content to place inside newly created placeholder files */
	placeholderContent: string;

	/** Folder paths to skip, one per line */
	excludedPaths: string;
}

function getDefaultSettings(app: App): AutoPlaceholderSettings {
	return {
		autoEnabled: true,
		placeholderFilename: DEFAULT_PLACEHOLDER_FILENAME,
		placeholderContent: DEFAULT_PLACEHOLDER_CONTENT,
		excludedPaths: `${app.vault.configDir}\n.trash`,
	};
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Parse the excluded paths setting into a Set of normalized paths */
function parseExcluded(raw: string): Set<string> {
	return new Set(
		raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => normalizePath(line))
	);
}

/**
 * Validate a placeholder filename.
 *
 * The placeholder must be a filename only, not a path.
 */
function validatePlaceholderFilename(value: string): string | null {
	const filename = value.trim();

	if (!filename) {
		return "Placeholder filename cannot be empty.";
	}

	if (filename === "." || filename === "..") {
		return "Placeholder filename must be a valid filename.";
	}

	if (filename.includes("/") || filename.includes("\\")) {
		return "Placeholder filename cannot contain path separators.";
	}

	return null;
}

/** Return true if the given folder path should be skipped */
function isFolderExcluded(
	folderPath: string,
	excluded: Set<string>
): boolean {
	for (const ex of excluded) {
		if (
			folderPath === ex ||
			folderPath.startsWith(`${ex}/`)
		) {
			return true;
		}
	}

	return false;
}

/** Collect all TFolder instances in the vault recursively */
function getAllFolders(app: App): TFolder[] {
	const folders: TFolder[] = [];

	const recurse = (folder: TFolder) => {
		folders.push(folder);

		for (const child of folder.children) {
			if (child instanceof TFolder) {
				recurse(child);
			}
		}
	};

	recurse(app.vault.getRoot());

	return folders;
}

/** Build the vault-relative path for a placeholder inside a folder */
function getPlaceholderPath(
	folder: TFolder,
	filename: string
): string {
	return normalizePath(
		folder.isRoot()
			? filename
			: `${folder.path}/${filename}`
	);
}

/** Append one of our inline SVG icons to an element */
function appendSvg(
	target: HTMLElement,
	svg: string
): void {
	const doc = new DOMParser().parseFromString(
		svg,
		"image/svg+xml"
	);

	const node = doc.documentElement;

	if (
		node &&
		node.nodeName.toLowerCase() === "svg"
	) {
		target.appendChild(
			target.ownerDocument.importNode(node, true)
		);
	}
}

// ─────────────────────────────────────────────
// Core operations
// ─────────────────────────────────────────────

/**
 * Ensure the configured placeholder exists in a folder.
 *
 * Does nothing if:
 * - the folder is excluded
 * - the placeholder already exists
 *
 * Existing placeholder files are NEVER modified.
 *
 * Returns true only when a file was created.
 */
async function ensurePlaceholder(
	app: App,
	folder: TFolder,
	filename: string,
	content: string,
	excluded: Set<string>
): Promise<boolean> {
	if (isFolderExcluded(folder.path, excluded)) {
		return false;
	}

	const filePath = getPlaceholderPath(
		folder,
		filename
	);

	if (await app.vault.adapter.exists(filePath)) {
		return false;
	}

	await app.vault.create(
		filePath,
		content
	);

	return true;
}

/**
 * Remove the configured placeholder from a folder if it exists.
 *
 * Returns true only when a file was removed.
 */
async function removePlaceholder(
	app: App,
	folder: TFolder,
	filename: string
): Promise<boolean> {
	const filePath = getPlaceholderPath(
		folder,
		filename
	);

	if (!(await app.vault.adapter.exists(filePath))) {
		return false;
	}

	const file =
		app.vault.getAbstractFileByPath(filePath);

	if (!(file instanceof TFile)) {
		return false;
	}

	await app.fileManager.trashFile(file);

	return true;
}

/**
 * Add the configured placeholder to every non-excluded folder.
 *
 * IMPORTANT:
 * `content` comes from the user's settings. This means bulk scans use
 * the same configured content as placeholders created by folder events.
 *
 * Returns the number of files created.
 */
async function scanAndAddAll(
	app: App,
	filename: string,
	content: string,
	excluded: Set<string>
): Promise<number> {
	let count = 0;

	for (const folder of getAllFolders(app)) {
		if (
			await ensurePlaceholder(
				app,
				folder,
				filename,
				content,
				excluded
			)
		) {
			count++;
		}
	}

	return count;
}

/**
 * Remove the configured placeholder from every folder.
 *
 * Only the CURRENT configured filename is removed.
 * Previously configured placeholder filenames are left untouched.
 *
 * Returns the number of files removed.
 */
async function removeAll(
	app: App,
	filename: string
): Promise<number> {
	let count = 0;

	for (const folder of getAllFolders(app)) {
		if (
			await removePlaceholder(
				app,
				folder,
				filename
			)
		) {
			count++;
		}
	}

	return count;
}

/** Count folders containing the configured placeholder */
function countPlaceholders(
	app: App,
	filename: string
): number {
	let count = 0;

	for (const folder of getAllFolders(app)) {
		const hasPlaceholder =
			folder.children.some(
				(child) =>
					child instanceof TFile &&
					child.name === filename
			);

		if (hasPlaceholder) {
			count++;
		}
	}

	return count;
}

// ─────────────────────────────────────────────
// Main Plugin
// ─────────────────────────────────────────────

export default class AutoPlaceholderPlugin extends Plugin {
	settings!: AutoPlaceholderSettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(
			new AutoPlaceholderSettingTab(
				this.app,
				this
			)
		);

		// Initial scan once the vault/workspace is ready.
		this.app.workspace.onLayoutReady(
			async () => {
				if (!this.settings.autoEnabled) {
					return;
				}

				await this.addMissingPlaceholders(
					true
				);
			}
		);

		// Watch for newly created folders.
		this.registerEvent(
			this.app.vault.on(
				"create",
				async (file: TAbstractFile) => {
					if (
						!this.settings.autoEnabled
					) {
						return;
					}

					if (!(file instanceof TFolder)) {
						return;
					}

					const excluded =
						parseExcluded(
							this.settings
								.excludedPaths
						);

					await ensurePlaceholder(
						this.app,
						file,
						this.settings
							.placeholderFilename,
						this.settings
							.placeholderContent,
						excluded
					);
				}
			)
		);

		// Ensure renamed folders still contain the configured placeholder.
		this.registerEvent(
			this.app.vault.on(
				"rename",
				async (file: TAbstractFile) => {
					if (
						!this.settings.autoEnabled
					) {
						return;
					}

					if (!(file instanceof TFolder)) {
						return;
					}

					const excluded =
						parseExcluded(
							this.settings
								.excludedPaths
						);

					await ensurePlaceholder(
						this.app,
						file,
						this.settings
							.placeholderFilename,
						this.settings
							.placeholderContent,
						excluded
					);
				}
			)
		);
	}

	async loadSettings(): Promise<void> {
		const loaded =
			(await this.loadData()) as
				Partial<AutoPlaceholderSettings> | null;

		this.settings = Object.assign(
			{},
			getDefaultSettings(this.app),
			loaded ?? {}
		);

		// Protect against invalid data.json values.
		const error =
			validatePlaceholderFilename(
				this.settings
					.placeholderFilename
			);

		if (error) {
			this.settings.placeholderFilename =
				DEFAULT_PLACEHOLDER_FILENAME;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Add missing placeholders to all managed folders.
	 *
	 * This uses BOTH the configured filename and configured content.
	 */
	async addMissingPlaceholders(
		showNotice = false
	): Promise<number> {
		const excluded =
			parseExcluded(
				this.settings.excludedPaths
			);

		const count =
			await scanAndAddAll(
				this.app,
				this.settings
					.placeholderFilename,
				this.settings
					.placeholderContent,
				excluded
			);

		if (
			showNotice &&
			count > 0
		) {
			new Notice(
				`Auto Placeholder: added ${count} ` +
				`${this.settings.placeholderFilename} ` +
				`file${count === 1 ? "" : "s"}.`
			);
		}

		return count;
	}
}

// ─────────────────────────────────────────────
// Settings Tab
// ─────────────────────────────────────────────

class AutoPlaceholderSettingTab extends PluginSettingTab {
	plugin: AutoPlaceholderPlugin;

	constructor(
		app: App,
		plugin: AutoPlaceholderPlugin
	) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private desc(
		parts: Array<
			string |
			{
				strong?: string;
				code?: string;
			}
		>
	): DocumentFragment {
		const frag =
			activeDocument.createDocumentFragment();

		for (const part of parts) {
			if (typeof part === "string") {
				frag.appendText(part);
				continue;
			}

			if (part.strong) {
				const el =
					activeDocument.createElement(
						"span"
					);

				el.className =
					"agk-desc-strong";

				el.textContent =
					part.strong;

				frag.appendChild(el);

				continue;
			}

			if (part.code) {
				const el =
					activeDocument.createElement(
						"code"
					);

				el.className =
					"agk-desc-code";

				el.textContent =
					part.code;

				frag.appendChild(el);
			}
		}

		return frag;
	}

	display(): void {
		const { containerEl } = this;

		const filename =
			this.plugin.settings
				.placeholderFilename;

		containerEl.empty();

		// ─── General ──────────────────────────

		new Setting(containerEl)
			.setName("Automatic placeholders")
			.setDesc(
				this.desc([
					"When enabled, Auto Placeholder creates ",
					{ code: filename },
					" in new folders and scans the vault on startup.",
				])
			)
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings
							.autoEnabled
					)
					.onChange(async (value) => {
						this.plugin.settings
							.autoEnabled =
							value;

						await this.plugin
							.saveSettings();

						// When enabling, immediately bring
						// existing folders up to date.
						if (value) {
							await this.plugin
								.addMissingPlaceholders(
									true
								);
						}

						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Placeholder filename")
			.setDesc(
				this.desc([
					"The file created inside managed folders. ",
					"Examples: ",
					{ code: ".gitkeep" },
					", ",
					{ code: "_folder.md" },
					". Changing this setting does not delete placeholders created with the previous filename.",
				])
			)
			.addText((text) => {
				text
					.setPlaceholder(
						DEFAULT_PLACEHOLDER_FILENAME
					)
					.setValue(filename)
					.onChange(async (value) => {
						const candidate =
							value.trim();

						const error =
							validatePlaceholderFilename(
								candidate
							);

						if (error) {
							return;
						}

						this.plugin.settings
							.placeholderFilename =
							candidate;

						await this.plugin
							.saveSettings();
					});

				// Validate when the user leaves the field.
				text.inputEl.addEventListener(
					"blur",
					async () => {
						const candidate =
							text
								.getValue()
								.trim();

						const error =
							validatePlaceholderFilename(
								candidate
							);

						if (error) {
							new Notice(
								`Auto Placeholder: ${error}`
							);

							text.setValue(
								this.plugin
									.settings
									.placeholderFilename
							);

							return;
						}

						this.plugin.settings
							.placeholderFilename =
							candidate;

						await this.plugin
							.saveSettings();

						this.display();
					}
				);
			});

		new Setting(containerEl)
			.setName("Placeholder contents")
			.setDesc(
				"Contents written verbatim to newly created placeholder files. " +
				"Existing files are never modified."
			)
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder(
						"Optional content..."
					)
					.setValue(
						this.plugin.settings
							.placeholderContent
					)
					.onChange(async (value) => {
						this.plugin.settings
							.placeholderContent =
							value;

						await this.plugin
							.saveSettings();
					});

				textArea.inputEl.rows = 8;
			});

		new Setting(containerEl)
			.setName("Excluded paths")
			.setDesc(
				this.desc([
					"Vault-relative folder paths to skip — one per line. ",
					{
						strong:
							"Subdirectories are excluded automatically.",
					},
					" Example: ",
					{
						code:
							this.app.vault
								.configDir,
					},
					", ",
					{ code: ".trash" },
					".",
				])
			)
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder(
						`${this.app.vault.configDir}\n.trash`
					)
					.setValue(
						this.plugin.settings
							.excludedPaths
					)
					.onChange(async (value) => {
						this.plugin.settings
							.excludedPaths =
							value;

						await this.plugin
							.saveSettings();
					});

				textArea.inputEl.rows = 5;

				textArea.inputEl.addClass(
					"agk-excluded-textarea"
				);

				return textArea;
			});

		// ─── Actions ──────────────────────────

		new Setting(containerEl)
			.setName("Actions")
			.setHeading();

		containerEl.createEl("p", {
			text:
				"Run these operations on demand regardless " +
				"of the automatic toggle above.",
			cls: "setting-item-description",
		});

		const actionsRow =
			containerEl.createDiv({
				cls: "agk-actions",
			});

		// Add placeholders to all folders
		const addBtn =
			actionsRow.createEl("button", {
				cls: "agk-btn mod-cta",
			});

		appendSvg(addBtn, SVG_SCAN);

		const addLabel =
			`Add ${filename} to all folders`;

		addBtn.createSpan({
			text: addLabel,
		});

		addBtn.onclick = async () => {
			addBtn.setAttribute(
				"disabled",
				"true"
			);

			const span =
				addBtn.querySelector("span");

			if (span) {
				span.textContent = "Working…";
			}

			try {
				const count =
					await this.plugin
						.addMissingPlaceholders();

				new Notice(
					count > 0
						? `Auto Placeholder: added ${count} ${filename} file${count === 1 ? "" : "s"}.`
						: `Auto Placeholder: all managed folders already have ${filename}.`
				);
			} catch (error) {
				console.error(
					"Auto Placeholder: failed to add placeholders",
					error
				);

				new Notice(
					"Auto Placeholder: failed to add placeholders. Check the developer console for details."
				);
			} finally {
				addBtn.removeAttribute(
					"disabled"
				);

				if (span) {
					span.textContent =
						addLabel;
				}

				this.display();
			}
		};

		// Remove current placeholder from all folders
		const removeBtn =
			actionsRow.createEl("button", {
				cls: "agk-btn mod-danger",
			});

		appendSvg(removeBtn, SVG_TRASH);

		const removeLabel =
			`Remove all ${filename}`;

		removeBtn.createSpan({
			text: removeLabel,
		});

		removeBtn.onclick = async () => {
			removeBtn.setAttribute(
				"disabled",
				"true"
			);

			const span =
				removeBtn.querySelector("span");

			if (span) {
				span.textContent =
					"Removing…";
			}

			try {
				const count =
					await removeAll(
						this.app,
						filename
					);

				new Notice(
					count > 0
						? `Auto Placeholder: removed ${count} ${filename} file${count === 1 ? "" : "s"}.`
						: `Auto Placeholder: no ${filename} files found.`
				);
			} catch (error) {
				console.error(
					"Auto Placeholder: failed to remove placeholders",
					error
				);

				new Notice(
					"Auto Placeholder: failed to remove placeholders. Check the developer console for details."
				);
			} finally {
				removeBtn.removeAttribute(
					"disabled"
				);

				if (span) {
					span.textContent =
						removeLabel;
				}

				this.display();
			}
		};

		// ─── Status ───────────────────────────

		new Setting(containerEl)
			.setName("Status")
			.setHeading();

		const statusDiv =
			containerEl.createDiv({
				cls: "agk-status-block",
			});

		const folders =
			getAllFolders(this.app);

		const excluded =
			parseExcluded(
				this.plugin.settings
					.excludedPaths
			);

		const excludedCount =
			folders.filter(
				(folder) =>
					isFolderExcluded(
						folder.path,
						excluded
					)
			).length;

		const placeholderCount =
			countPlaceholders(
				this.app,
				filename
			);

		const statusLine = (
			label: string,
			value: string | number
		) => {
			const p =
				statusDiv.createEl("p");

			p.createEl("strong", {
				text: `${label}:`,
			});

			p.appendText(` ${value}`);
		};

		statusLine(
			"Automatic mode",
			this.plugin.settings.autoEnabled
				? "Enabled"
				: "Disabled"
		);

		statusLine(
			"Placeholder filename",
			filename
		);

		statusLine(
			"Total folders",
			folders.length
		);

		statusLine(
			"Excluded folders",
			excludedCount
		);

		statusLine(
			`${filename} files present`,
			placeholderCount
		);
	}
}