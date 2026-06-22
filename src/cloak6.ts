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

let statusBarItem: vscode.StatusBarItem;

let readyTimer: NodeJS.Timeout | undefined;
let countdownTimer: NodeJS.Timeout | undefined;
let blinkTimer: NodeJS.Timeout | undefined;

let statsStore: DailyStatsStore | undefined;
let currentRunStartedAt: number | undefined;

const readyDelayMs = 3000;
const countdownSeconds = 30 * 60;
const pauseBlinkMs = 500;
const activityDebounceMs = 300;

let state: AlarmState = 'ready';
let remainingSeconds = countdownSeconds;
let blinkHighlighted = false;
let lastActivityStartAt = 0;

// 用这个 key 缓存 tooltip 内容，避免鼠标悬浮时反复重绘悬浮板。
let lastHoverRenderKey = '';

const pausedBlinkBackground = new vscode.ThemeColor('statusBarItem.prominentBackground');

export function activate(context: vscode.ExtensionContext) {
	statusBarItem = vscode.window.createStatusBarItem(
		'vsext.countdownAlarm',
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.command = 'vsext.toggleAlarm';
	statusBarItem.show();

	statsStore = new DailyStatsStore();

	const clickDisposable = vscode.commands.registerCommand('vsext.toggleAlarm', () => {
		handleStatusBarClick();
	});

	// 调试阶段先只保留一个典型的窗口聚焦事件，避免多个事件同时触发状态切换。
	const focusDisposable = vscode.window.onDidChangeWindowState((event) => {
		if (event.focused) {
			activateByUserActivity();
		}
	});

	// 这些事件也可以代表用户活动，后续稳定后可以逐个打开。
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
		clickDisposable,
		focusDisposable
	);

	// 不使用顶层 await，避免 VS Code 用 require() 加载扩展入口时报 ESM top-level await 错误。
	void statsStore.init(context).then(() => {
		enterReadyState();
	});
}

function enterReadyState() {
	clearAllTimers();

	state = 'ready';
	remainingSeconds = countdownSeconds;
	blinkHighlighted = false;

	statusBarItem.text = formatStatusText('$(check)', 'Ready');
	statusBarItem.backgroundColor = undefined;
	updateStatsHover('当前状态: 准备就绪，3 秒后进入暂停状态');

	void vscode.window.showInformationMessage('定时提示已准备就绪');

	readyTimer = setTimeout(() => {
		enterPausedState();
	}, readyDelayMs);
}

function enterPausedState() {
	clearReadyTimer();
	clearCountdownTimer();
	clearBlinkTimer();

	void finishCurrentRun();
	void statsStore?.recordPause().then(() => {
		updateStatsHover('当前状态: 暂停中');
	});

	state = 'paused';
	remainingSeconds = countdownSeconds;
	blinkHighlighted = true;

	renderPausedStatus();

	blinkTimer = setInterval(() => {
		blinkHighlighted = !blinkHighlighted;
		renderPausedStatus();
	}, pauseBlinkMs);
}

function startCountdown() {
	clearAllTimers();

	state = 'countingDown';
	remainingSeconds = countdownSeconds;
	blinkHighlighted = false;
	currentRunStartedAt = Date.now();

	void statsStore?.recordRunStart().then(() => {
		updateStatsHover('当前状态: 倒计时中');
	});

	updateCountdownText();

	countdownTimer = setInterval(() => {
		remainingSeconds -= 1;

		if (remainingSeconds <= 0) {
			void vscode.window.showWarningMessage('倒计时结束，请休息一下');
			enterPausedState();
			return;
		}

		updateCountdownText();
	}, 1000);
}

function activateByUserActivity() {
	if (state !== 'paused') {
		return;
	}

	const now = Date.now();

	// VS Code 聚焦事件可能连续触发，这里做一个轻量防抖。
	if (now - lastActivityStartAt < activityDebounceMs) {
		return;
	}

	lastActivityStartAt = now;
	startCountdown();
}

function handleStatusBarClick() {
	// VS Code 扩展没有通用的“点击窗口任意位置”事件。
	// 这里用状态栏按钮点击作为可调试入口。
	if (state === 'paused') {
		startCountdown();
		return;
	}

	// 倒计时中点击状态栏，提前中止并回到暂停状态。
	if (state === 'countingDown') {
		enterPausedState();
	}
}

function renderPausedStatus() {
	statusBarItem.text = formatStatusText('$(debug-pause)', 'Paused');
	statusBarItem.backgroundColor = blinkHighlighted ? pausedBlinkBackground : undefined;

	// 暂停态会每 500ms 闪烁背景，但 tooltip 内容不变时不会重新赋值。
	updateStatsHover('当前状态: 暂停中');
}

function updateCountdownText() {
	statusBarItem.text = formatStatusText('$(watch)', formatTime(remainingSeconds));
	statusBarItem.backgroundColor = undefined;

	// 注意：这里不要更新 tooltip。
	// 倒计时每秒都会调用这个函数，如果每秒重设 tooltip，鼠标悬浮板会跟着闪。
}

function updateStatsHover(statusLine: string) {
	const todayStats = statsStore?.getTodayStats();
	const pauseCount = todayStats?.pauseCount ?? 0;
	const runCount = todayStats?.runCount ?? 0;
	const runSeconds = todayStats?.runSeconds ?? 0;

	const hoverRenderKey = [
		statusLine,
		pauseCount,
		runCount,
		runSeconds
	].join('|');

	if (hoverRenderKey === lastHoverRenderKey) {
		return;
	}

	lastHoverRenderKey = hoverRenderKey;

	const hover = new vscode.MarkdownString(undefined, true);
	hover.isTrusted = false;
	hover.supportHtml = false;

	hover.appendMarkdown('**今日记录**\n\n');
	hover.appendMarkdown(`暂停次数: ${pauseCount}\n\n`);
	hover.appendMarkdown(`运行次数: ${runCount}\n\n`);
	hover.appendMarkdown(`运行时长: ${formatDuration(runSeconds)}\n\n`);
	hover.appendMarkdown('---\n\n');
	hover.appendMarkdown(statusLine);

	statusBarItem.tooltip = hover;
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

function formatStatusText(icon: string, text: string): string {
	return `${icon} ${text}`;
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