import * as vscode from 'vscode';

type AlarmState = 'ready' | 'paused' | 'countingDown';

type DailyStats = {
	date: string;
	pauseCount: number;
	runCount: number;
	runSeconds: number;
};

type StatsFile = {
	days: Record<string, DailyStats>;
};

type StatsViewModel = {
	state: AlarmState;
	stateText: string;
	remainingText: string;
	totalText: string;
	progressPercent: number;
	pauseCount: number;
	runCount: number;
	runDurationText: string;
};

const CONFIG = {
	readyDelayMs: 3000,
	countdownSeconds: 10 * 60,
	pauseBlinkMs: 500,
	activityDebounceMs: 300,
	progressBarWidth: 18,

	commands: {
		toggleAlarm: 'vsext.toggleAlarm',
		openStatsPanel: 'vsext.openStatsPanel'
	},

	text: {
		readyStatus: 'Ready',
		pausedStatus: 'Paused',
		countingStatus: 'Running',

		readyMessage: '定时提示已准备就绪',
		timeoutMessage: '倒计时结束，请休息一下',

		hoverTitle: '今日记录',
		pauseCountLabel: '暂停次数',
		runCountLabel: '运行次数',
		runDurationLabel: '运行时长',
		remainingLabel: '剩余时间',
		progressLabel: '进度',

		readyLine: '当前状态: 准备就绪，3 秒后进入暂停状态',
		pausedLine: '当前状态: 暂停中',
		countingLine: '当前状态: 倒计时中',
		openStatsPanel: '打开统计面板'
	}
};

let extensionContext: vscode.ExtensionContext;
let statusBarItem: vscode.StatusBarItem;
let statsBarItem: vscode.StatusBarItem;
let statsPanel: vscode.WebviewPanel | undefined;

let readyTimer: NodeJS.Timeout | undefined;
let countdownTimer: NodeJS.Timeout | undefined;
let blinkTimer: NodeJS.Timeout | undefined;

let statsStore: DailyStatsStore | undefined;
let currentRunStartedAt: number | undefined;

let state: AlarmState = 'ready';
let remainingSeconds = CONFIG.countdownSeconds;
let blinkHighlighted = false;
let lastActivityStartAt = 0;
let lastHoverRenderKey = '';

const pausedBlinkBackground = new vscode.ThemeColor('statusBarItem.prominentBackground');

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	statsStore = new DailyStatsStore();

	statusBarItem = vscode.window.createStatusBarItem(
		'vsext.countdownAlarm',
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.command = CONFIG.commands.toggleAlarm;
	statusBarItem.show();

	statsBarItem = vscode.window.createStatusBarItem(
		'vsext.statsPanel',
		vscode.StatusBarAlignment.Right,
		99
	);

	statsBarItem.text = '$(graph)';
	statsBarItem.command = CONFIG.commands.openStatsPanel;
	statsBarItem.tooltip = CONFIG.text.openStatsPanel;
	statsBarItem.show();

	const clickDisposable = vscode.commands.registerCommand(CONFIG.commands.toggleAlarm, () => {
		handleStatusBarClick();
	});

	const openStatsPanelDisposable = vscode.commands.registerCommand(CONFIG.commands.openStatsPanel, () => {
		void openStatsPanel();
	});

	// Keep one typical activity trigger first. More editor events can be enabled later.
	const focusDisposable = vscode.window.onDidChangeWindowState((event) => {
		if (event.focused) {
			activateByUserActivity();
		}
	});

	// const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
	// 	activateByUserActivity();
	// });
	// const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(() => {
	// 	activateByUserActivity();
	// });
	// const documentDisposable = vscode.workspace.onDidChangeTextDocument(() => {
	// 	activateByUserActivity();
	// });

	context.subscriptions.push(
		statusBarItem,
		statsBarItem,
		clickDisposable,
		openStatsPanelDisposable,
		focusDisposable
	);

	// Avoid top-level await. VS Code loads the extension entry with require().
	void statsStore.init(context).then(() => {
		enterReadyState();
	});
}

function enterReadyState() {
	clearAllTimers();

	state = 'ready';
	remainingSeconds = CONFIG.countdownSeconds;
	blinkHighlighted = false;

	renderStatusIcon();
	updateStatsHover(CONFIG.text.readyLine);
	postStatsToPanel();

	void vscode.window.showInformationMessage(CONFIG.text.readyMessage);

	readyTimer = setTimeout(() => {
		enterPausedState();
	}, CONFIG.readyDelayMs);
}

function enterPausedState() {
	clearReadyTimer();
	clearCountdownTimer();
	clearBlinkTimer();

	void finishCurrentRun().then(() => {
		postStatsToPanel();
	});

	void statsStore?.recordPause().then(() => {
		updateStatsHover(CONFIG.text.pausedLine);
		postStatsToPanel();
	});

	state = 'paused';
	remainingSeconds = CONFIG.countdownSeconds;
	blinkHighlighted = true;

	renderPausedStatus();
	postStatsToPanel();

	blinkTimer = setInterval(() => {
		blinkHighlighted = !blinkHighlighted;
		renderPausedStatus();
	}, CONFIG.pauseBlinkMs);
}

function startCountdown() {
	clearAllTimers();

	state = 'countingDown';
	remainingSeconds = CONFIG.countdownSeconds;
	blinkHighlighted = false;
	currentRunStartedAt = Date.now();

	void statsStore?.recordRunStart().then(() => {
		updateStatsHover(CONFIG.text.countingLine);
		postStatsToPanel();
	});

	renderStatusIcon();
	postStatsToPanel();

	countdownTimer = setInterval(() => {
		remainingSeconds -= 1;

		if (remainingSeconds <= 0) {
			void vscode.window.showWarningMessage(CONFIG.text.timeoutMessage);
			enterPausedState();
			return;
		}

		// The status bar only switches icons. The live countdown is pushed to the Webview panel.
		renderStatusIcon();
		postStatsToPanel();
	}, 1000);
}

function activateByUserActivity() {
	if (state !== 'paused') {
		return;
	}

	const now = Date.now();

	if (now - lastActivityStartAt < CONFIG.activityDebounceMs) {
		return;
	}

	lastActivityStartAt = now;
	startCountdown();
}

function handleStatusBarClick() {
	if (state === 'ready') {
		startCountdown();
		return;
	}

	if (state === 'paused') {
		startCountdown();
		return;
	}

	if (state === 'countingDown') {
		enterPausedState();
	}
}

function renderPausedStatus() {
	renderStatusIcon();
	statusBarItem.backgroundColor = blinkHighlighted ? pausedBlinkBackground : undefined;
	updateStatsHover(CONFIG.text.pausedLine);
}

function renderStatusIcon() {
	if (state === 'ready') {
		statusBarItem.text = '$(check)';
		statusBarItem.backgroundColor = undefined;
		return;
	}

	if (state === 'paused') {
		statusBarItem.text = '$(debug-pause)';
		return;
	}

	statusBarItem.text = '$(watch)';
	statusBarItem.backgroundColor = undefined;
}

function updateStatsHover(statusLine: string) {
	const viewModel = createStatsViewModel(statusLine);
	const horizontalBar = renderHorizontalProgress(viewModel.progressPercent / 100);

	const hoverRenderKey = [
		statusLine,
		viewModel.pauseCount,
		viewModel.runCount,
		viewModel.runDurationText,
		state
	].join('|');

	if (hoverRenderKey === lastHoverRenderKey) {
		return;
	}

	lastHoverRenderKey = hoverRenderKey;

	const hover = new vscode.MarkdownString(undefined, true);
	hover.isTrusted = { enabledCommands: [CONFIG.commands.openStatsPanel] };
	hover.supportHtml = false;

	hover.appendMarkdown(`**${CONFIG.text.hoverTitle}**\n\n`);
	hover.appendMarkdown(`${CONFIG.text.pauseCountLabel}: ${viewModel.pauseCount}\n\n`);
	hover.appendMarkdown(`${CONFIG.text.runCountLabel}: ${viewModel.runCount}\n\n`);
	hover.appendMarkdown(`${CONFIG.text.runDurationLabel}: ${viewModel.runDurationText}\n\n`);
	hover.appendMarkdown('---\n\n');
	hover.appendMarkdown(`${statusLine}\n\n`);
	hover.appendMarkdown(`${CONFIG.text.remainingLabel}: ${viewModel.remainingText}\n\n`);
	hover.appendMarkdown(`${CONFIG.text.progressLabel}: ${horizontalBar} ${viewModel.progressPercent}%\n\n`);
	hover.appendMarkdown(`[${CONFIG.text.openStatsPanel}](command:${CONFIG.commands.openStatsPanel})`);

	statusBarItem.tooltip = hover;
	statsBarItem.tooltip = hover;
}

async function openStatsPanel() {
	if (statsPanel) {
		statsPanel.reveal(vscode.ViewColumn.Beside, true);
		postStatsToPanel();
		return;
	}

	statsPanel = vscode.window.createWebviewPanel(
		'vsextStatsPanel',
		'定时统计',
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(extensionContext.extensionUri, 'media')
			]
		}
	);

	statsPanel.onDidDispose(() => {
		statsPanel = undefined;
	});

	statsPanel.webview.html = await loadStatsPanelHtml(statsPanel.webview);
	postStatsToPanel();
}

async function loadStatsPanelHtml(webview: vscode.Webview): Promise<string> {
	const htmlUri = vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'stats.html');
	const nonce = createNonce();

	try {
		const bytes = await vscode.workspace.fs.readFile(htmlUri);
		const html = Buffer.from(bytes).toString('utf8');

		return html
			.replaceAll('{{cspSource}}', webview.cspSource)
			.replaceAll('{{nonce}}', nonce);
	} catch {
		return createFallbackStatsPanelHtml(webview.cspSource, nonce);
	}
}

function postStatsToPanel() {
	if (!statsPanel) {
		return;
	}

	void statsPanel.webview.postMessage({
		type: 'stats:update',
		payload: createStatsViewModel(getStateLine())
	});
}

function createStatsViewModel(statusLine: string = getStateLine()): StatsViewModel {
	const todayStats = statsStore?.getTodayStats();
	const progressPercent = Math.round(getCountdownProgressRatio() * 100);

	return {
		state,
		stateText: statusLine,
		remainingText: formatTime(remainingSeconds),
		totalText: formatTime(CONFIG.countdownSeconds),
		progressPercent,
		pauseCount: todayStats?.pauseCount ?? 0,
		runCount: todayStats?.runCount ?? 0,
		runDurationText: formatDuration(todayStats?.runSeconds ?? 0)
	};
}

function getStateLine(): string {
	if (state === 'ready') {
		return CONFIG.text.readyLine;
	}

	if (state === 'paused') {
		return CONFIG.text.pausedLine;
	}

	return CONFIG.text.countingLine;
}

function getCountdownProgressRatio(): number {
	if (state !== 'countingDown') {
		return 1;
	}

	return Math.max(0, Math.min(1, remainingSeconds / CONFIG.countdownSeconds));
}

function renderHorizontalProgress(ratio: number): string {
	const total = CONFIG.progressBarWidth;
	const filled = Math.round(total * ratio);
	const empty = total - filled;

	return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
}

async function finishCurrentRun() {
	if (!currentRunStartedAt) {
		return;
	}

	const elapsedSeconds = Math.floor((Date.now() - currentRunStartedAt) / 1000);
	currentRunStartedAt = undefined;

	await statsStore?.recordRunDuration(elapsedSeconds);
}

class DailyStatsStore {
	private fileUri: vscode.Uri | undefined;
	private stats: StatsFile = { days: {} };

	async init(context: vscode.ExtensionContext) {
		await vscode.workspace.fs.createDirectory(context.globalStorageUri);

		this.fileUri = vscode.Uri.joinPath(context.globalStorageUri, 'daily-stats.json');
		await this.load();
	}

	getTodayStats(): DailyStats {
		const today = getLocalDateKey();

		if (!this.stats.days[today]) {
			this.stats.days[today] = {
				date: today,
				pauseCount: 0,
				runCount: 0,
				runSeconds: 0
			};
		}

		return this.stats.days[today];
	}

	async recordPause() {
		const todayStats = this.getTodayStats();
		todayStats.pauseCount += 1;
		await this.save();
	}

	async recordRunStart() {
		const todayStats = this.getTodayStats();
		todayStats.runCount += 1;
		await this.save();
	}

	async recordRunDuration(seconds: number) {
		if (seconds <= 0) {
			return;
		}

		const todayStats = this.getTodayStats();
		todayStats.runSeconds += seconds;
		await this.save();
	}

	private async load() {
		if (!this.fileUri) {
			return;
		}

		try {
			const bytes = await vscode.workspace.fs.readFile(this.fileUri);
			const text = Buffer.from(bytes).toString('utf8');
			this.stats = JSON.parse(text) as StatsFile;
		} catch {
			this.stats = { days: {} };
			await this.save();
		}
	}

	private async save() {
		if (!this.fileUri) {
			return;
		}

		const text = JSON.stringify(this.stats, null, 2);
		await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(text, 'utf8'));
	}
}

function getLocalDateKey(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = `${now.getMonth() + 1}`.padStart(2, '0');
	const day = `${now.getDate()}`.padStart(2, '0');

	return `${year}-${month}-${day}`;
}

function formatTime(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}小时${minutes}分${seconds}秒`;
	}

	if (minutes > 0) {
		return `${minutes}分${seconds}秒`;
	}

	return `${seconds}秒`;
}

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';

	for (let i = 0; i < 32; i += 1) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}

	return nonce;
}

function createFallbackStatsPanelHtml(cspSource: string, nonce: string): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>定时统计</title>
</head>
<body>
	<h1>定时统计</h1>
	<p>找不到 media/stats.html，已使用内置备用页面。</p>
	<pre id="stats"></pre>
	<script nonce="${nonce}">
		window.addEventListener('message', (event) => {
			document.getElementById('stats').textContent = JSON.stringify(event.data.payload, null, 2);
		});
	</script>
</body>
</html>`;
}

function clearReadyTimer() {
	if (readyTimer) {
		clearTimeout(readyTimer);
		readyTimer = undefined;
	}
}

function clearCountdownTimer() {
	if (countdownTimer) {
		clearInterval(countdownTimer);
		countdownTimer = undefined;
	}
}

function clearBlinkTimer() {
	if (blinkTimer) {
		clearInterval(blinkTimer);
		blinkTimer = undefined;
	}
}

function clearAllTimers() {
	clearReadyTimer();
	clearCountdownTimer();
	clearBlinkTimer();
}

export function deactivate() {
	clearAllTimers();
	void finishCurrentRun();
}
