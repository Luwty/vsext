import * as vscode from 'vscode';

let statusBarItem: vscode.StatusBarItem;

let timer: NodeJS.Timeout | undefined;
let blinkTimer: NodeJS.Timeout | undefined;

const countdownSeconds = 10;
let remainingSeconds = countdownSeconds;

let state: 'idle' | 'running' | 'timeoutBlinking' | 'timeoutPaused' = 'idle';
let blinkVisible = true;
let timeoutNotified = false;

export function activate(context: vscode.ExtensionContext) {
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.command = 'vsext.toggleAlarm';
	statusBarItem.tooltip = 'Click to control countdown alarm';
	statusBarItem.text = formatStatusText('$(watch)', '--:--');
	statusBarItem.show();

	const clickDisposable = vscode.commands.registerCommand('vsext.toggleAlarm', () => {
		handleClick();
	});

	const focusDisposable = vscode.window.onDidChangeWindowState((event) => {
		if (event.focused) {
			startWhenEditorIsActive();
		}
	});

	const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
		startWhenEditorIsActive();
	});

	context.subscriptions.push(
		statusBarItem,
		clickDisposable,
		focusDisposable,
		editorDisposable
	);
}

function startWhenEditorIsActive() {
	if (state !== 'idle') {
		return;
	}

	if (!vscode.window.activeTextEditor) {
		return;
	}

	startCountdown();
}

function startCountdown() {
	clearAllTimers();

	state = 'running';
	remainingSeconds = countdownSeconds;
	timeoutNotified = false;

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
	blinkVisible = true;

	if (!timeoutNotified) {
		timeoutNotified = true;
		vscode.window.showWarningMessage('超时警告');
	}

	statusBarItem.text = formatStatusText('$(warning)', 'Time out');
	statusBarItem.tooltip = 'Time out. Click to pause.';

	blinkTimer = setInterval(() => {
		blinkVisible = !blinkVisible;
		// VS Code 状态栏文本渲染会折叠/忽略尾部空白，不能把空格当布局约束
		// statusBarItem.text = blinkVisible
		// 	? formatStatusText('$(warning)', 'Time out')
		// 	: formatStatusText('$(warning)', '        '); 
		statusBarItem.text = formatStatusText('$(warning)', 'NNNNNNN');

		statusBarItem.backgroundColor = blinkVisible
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;
	}, 500);
}

function handleClick() {
	if (state === 'timeoutBlinking') {
		clearBlinkTimer();

		state = 'timeoutPaused';
		statusBarItem.text = formatStatusText('$(warning)', 'Time out');
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		statusBarItem.tooltip = 'Paused. Click to restart.';
		return;
	}

	if (state === 'timeoutPaused') {
		statusBarItem.backgroundColor = undefined;
		startCountdown();
		return;
	}

	if (state === 'idle') {
		startCountdown();
	}
}

function updateCountdownText() {
	statusBarItem.backgroundColor = undefined;
	statusBarItem.text = formatStatusText('$(watch)', formatTime(remainingSeconds));
	statusBarItem.tooltip = 'Countdown is running';
}

function formatStatusText(icon: string, text: string): string {
	return `${icon} ${text.padEnd(8, ' ')}`;
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