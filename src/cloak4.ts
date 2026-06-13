import * as vscode from 'vscode';

type AlarmState = 'ready' | 'paused' | 'countingDown';

let statusBarItem: vscode.StatusBarItem;

let readyTimer: NodeJS.Timeout | undefined;
let countdownTimer: NodeJS.Timeout | undefined;
let blinkTimer: NodeJS.Timeout | undefined;

const readyDelayMs = 3000;
const countdownSeconds = 10;
const pauseBlinkMs = 500;
const activityDebounceMs = 300;

let state: AlarmState = 'ready';
let remainingSeconds = countdownSeconds;
let blinkHighlighted = false;
let lastActivityStartAt = 0;

// 暂停态使用一个更轻的状态栏主题色。主题没有定义时，VS Code 会走自身回退；
// 闪烁的另一半会清空背景色，保持状态栏原样。
const pausedBlinkBackground = new vscode.ThemeColor('statusBarItem.prominentBackground');

export function activate(context: vscode.ExtensionContext) {
	statusBarItem = vscode.window.createStatusBarItem(
		'vsext.countdownAlarm',
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.command = 'vsext.toggleAlarm';
	statusBarItem.show();

	const clickDisposable = vscode.commands.registerCommand('vsext.toggleAlarm', () => {
		handleStatusBarClick();
	});

	// 调试阶段先只保留一个典型的工作区聚焦事件，避免多个事件同时触发导致状态抖动。
	const focusDisposable = vscode.window.onDidChangeWindowState((event) => {
		if (event.focused) {
			activateByUserActivity();
		}
	});

	// 这些事件也能代表用户活动，但现在先注释掉，后续确认行为后再逐个打开。
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

	enterReadyState();
}

function enterReadyState() {
	clearAllTimers();

	state = 'ready';
	remainingSeconds = countdownSeconds;
	blinkHighlighted = false;

	statusBarItem.text = formatStatusText('$(check)', 'Ready');
	statusBarItem.tooltip = '准备就绪，3 秒后进入暂停状态。';
	statusBarItem.backgroundColor = undefined;

	void vscode.window.showInformationMessage('定时提示已准备就绪');

	readyTimer = setTimeout(() => {
		enterPausedState();
	}, readyDelayMs);
}

function enterPausedState() {
	clearReadyTimer();
	clearCountdownTimer();
	clearBlinkTimer();

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

	// VS Code 聚焦事件可能连续触发，给状态切换加一个很小的防抖。
	if (now - lastActivityStartAt < activityDebounceMs) {
		return;
	}

	lastActivityStartAt = now;
	startCountdown();
}

function handleStatusBarClick() {
	// VS Code 扩展没有通用的“点击窗口任意位置”事件。
	// 这里用状态栏按钮点击作为窗口点击的调试入口：暂停态启动倒计时，倒计时态提前中止。
	if (state === 'paused') {
		startCountdown();
		return;
	}

	// 倒计时过程中点击状态栏按钮，提前中止并回到暂停态。
	if (state === 'countingDown') {
		enterPausedState();
	}
}

function renderPausedStatus() {
	statusBarItem.text = formatStatusText('$(debug-pause)', 'Paused');
	statusBarItem.tooltip = '暂停中。点击状态栏项或重新聚焦 VS Code 窗口即可开始倒计时。';
	statusBarItem.backgroundColor = blinkHighlighted ? pausedBlinkBackground : undefined;
}

function updateCountdownText() {
	statusBarItem.text = formatStatusText('$(watch)', formatTime(remainingSeconds));
	statusBarItem.tooltip = '倒计时中。点击状态栏项可提前中止并回到暂停状态。';
	statusBarItem.backgroundColor = undefined;
}

function formatStatusText(icon: string, text: string): string {
	return `${icon} ${text}`;
}

function formatTime(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
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
}
