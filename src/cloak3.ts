import * as vscode from 'vscode';

let statusBarItem: vscode.StatusBarItem;

let timer: NodeJS.Timeout | undefined;
let blinkTimer: NodeJS.Timeout | undefined;

const countdownSeconds = 10;
let remainingSeconds = countdownSeconds;

let state: 'waitingForActivity' | 'running' | 'timeoutBlinking' | 'timeoutPaused' = 'waitingForActivity';

let blinkHighlighted = false;
let timeoutNotified = false;

/**
 * 防止多个 VS Code 事件在同一瞬间重复触发，导致连续重启倒计时。
 */
let lastActivityStartAt = 0;
const activityDebounceMs = 300;

export function activate(context: vscode.ExtensionContext) {
	statusBarItem = vscode.window.createStatusBarItem(
		'vsext.countdownAlarm',
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.command = 'vsext.toggleAlarm';
	statusBarItem.tooltip = 'Waiting for activity';
	statusBarItem.text = formatStatusText('$(watch)', 'Ready');
	statusBarItem.show();

	const clickDisposable = vscode.commands.registerCommand('vsext.toggleAlarm', () => {
		handleStatusBarClick();
	});

	const focusDisposable = vscode.window.onDidChangeWindowState((event) => {
		if (event.focused) {
			activateByUserActivity();
		}
	});

	const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
		activateByUserActivity();
	});

	const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(() => {
		activateByUserActivity();
	});

	const documentDisposable = vscode.workspace.onDidChangeTextDocument(() => {
		activateByUserActivity();
	});

	context.subscriptions.push(
		statusBarItem,
		clickDisposable,
		focusDisposable,
		editorDisposable,
		selectionDisposable,
		documentDisposable
	);

	/**
	 * 状态1：
	 * 打开 VS Code 窗口完成后，如果当前已有活动编辑器，则直接开始第一轮计时。
	 */
	if (vscode.window.activeTextEditor) {
		startCountdown();
	}
}

function activateByUserActivity() {
	if (!vscode.window.activeTextEditor) {
		return;
	}

	if (state !== 'waitingForActivity' && state !== 'timeoutPaused') {
		return;
	}

	const now = Date.now();

	if (now - lastActivityStartAt < activityDebounceMs) {
		return;
	}

	lastActivityStartAt = now;
	startCountdown();
}

function startCountdown() {
	clearAllTimers();

	state = 'running';
	remainingSeconds = countdownSeconds;
	timeoutNotified = false;
	blinkHighlighted = false;

	statusBarItem.backgroundColor = undefined;

	updateCountdownText();

	timer = setInterval(() => {
		remainingSeconds -= 1;

		if (remainingSeconds <= 0) {
			startTimeoutBlinking();
			return;
		}

		updateCountdownText();
	}, 1000);
}

function startTimeoutBlinking() {
	clearTimer();

	state = 'timeoutBlinking';
	blinkHighlighted = true;

	statusBarItem.text = formatStatusText('$(warning)', 'Time out');
	statusBarItem.tooltip = 'Time out. Click to pause.';
	statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

	if (!timeoutNotified) {
		timeoutNotified = true;
		vscode.window.showWarningMessage('超时警告');
	}

	blinkTimer = setInterval(() => {
		blinkHighlighted = !blinkHighlighted;

		/**
		 * 不再用空格占位。
		 * 保持文字完全一致，只闪烁背景色。
		 * 这样状态栏按钮宽度不会收缩，点击区域也不会抖动。
		 */
		statusBarItem.text = formatStatusText('$(warning)', 'Time out');
		statusBarItem.backgroundColor = blinkHighlighted
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;
	}, 500);
}

function handleStatusBarClick() {
	if (state === 'timeoutBlinking') {
		pauseTimeoutBlinking();
		return;
	}

	/**
	 * 状态2：
	 * 暂停后，用户可以主动点击状态栏开始下一轮倒计时。
	 */
	if (state === 'timeoutPaused' || state === 'waitingForActivity') {
		startCountdown();
		return;
	}

	/**
	 * running 状态下点击状态栏是否要做事，你原始代码没有定义。
	 * 这里保持“不处理”，避免误点导致重置。
	 */
}

function pauseTimeoutBlinking() {
	clearBlinkTimer();

	state = 'timeoutPaused';
	blinkHighlighted = false;

	statusBarItem.text = formatStatusText('$(warning)', 'Paused');
	statusBarItem.tooltip = 'Paused. Click status bar or interact with editor to restart countdown.';
	statusBarItem.backgroundColor = undefined;
}

function updateCountdownText() {
	statusBarItem.text = formatStatusText('$(watch)', formatTime(remainingSeconds));
	statusBarItem.tooltip = 'Countdown is running';
}

function formatStatusText(icon: string, text: string): string {
	return `${icon} ${text}`;
}

function formatTime(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function clearTimer() {
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
}

function clearBlinkTimer() {
	if (blinkTimer) {
		clearInterval(blinkTimer);
		blinkTimer = undefined;
	}
}

function clearAllTimers() {
	clearTimer();
	clearBlinkTimer();
}

export function deactivate() {
	clearAllTimers();
}