import * as vscode from 'vscode';

let statusBarItem: vscode.StatusBarItem;

let timer: NodeJS.Timeout | undefined;
let blinkTimer: NodeJS.Timeout | undefined;

let remainingSeconds = 10;
const countdownSeconds = 10;

let state: 'running' | 'timeoutBlinking' | 'timeoutPaused' = 'running';
let blinkVisible = true;

export function activate(context: vscode.ExtensionContext) {
	console.log('vsext is now active');

	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.command = 'vsext.toggleAlarm';
	statusBarItem.tooltip = 'Countdown alarm';
	statusBarItem.show();

	const disposable = vscode.commands.registerCommand('vsext.toggleAlarm', () => {
		handleClick();
	});

	context.subscriptions.push(statusBarItem, disposable);

	startCountdown();
}

function startCountdown() {
	clearAllTimers();

	state = 'running';
	remainingSeconds = countdownSeconds;

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

	blinkTimer = setInterval(() => {
		blinkVisible = !blinkVisible;
		statusBarItem.text = blinkVisible ? '$(bell) Time out' : '$(bell)';
		statusBarItem.tooltip = 'Time out. Click to pause.';
	}, 500);
}

function handleClick() {
	if (state === 'timeoutBlinking') {
		clearBlinkTimer();

		state = 'timeoutPaused';
		statusBarItem.text = '$(bell) Time out';
		statusBarItem.tooltip = 'Paused. Click to restart.';
		return;
	}

	if (state === 'timeoutPaused') {
		startCountdown();
	}
}

function updateCountdownText() {
	statusBarItem.text = `$(watch) ${formatTime(remainingSeconds)}`;
	statusBarItem.tooltip = 'Countdown is running';
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