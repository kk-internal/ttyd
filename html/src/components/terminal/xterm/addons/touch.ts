// KK: touch support for mobile browsers.
// xterm.js renders its screen on top of the native scroll viewport, so touch devices can't scroll
// the scrollback and taps don't reliably bring up the soft keyboard. This addon:
//   - scrolls the scrollback on vertical swipes (with momentum)
//   - sends arrow keys on swipes in the alternate screen (less, vim, man, ...)
//   - focuses the terminal on tap, which opens the soft keyboard
import { bind } from 'decko';
import { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

const TAP_MAX_MOVE = 10; // px
const TAP_MAX_DURATION = 300; // ms
const MOMENTUM_FRICTION = 0.95;
const MOMENTUM_MIN_VELOCITY = 0.05; // px per ms

export class TouchAddon implements ITerminalAddon {
    private terminal: Terminal;
    private disposables: IDisposable[] = [];

    private startX = 0;
    private startY = 0;
    private startTime = 0;
    private lastY = 0;
    private lastTime = 0;
    private velocity = 0;
    private remainder = 0;
    private moved = false;
    private momentumFrame?: number;

    activate(terminal: Terminal): void {
        this.terminal = terminal;
        const element = terminal.element;
        if (!element) return;

        element.style.touchAction = 'none';
        this.listen(element, 'touchstart', this.onTouchStart);
        this.listen(element, 'touchmove', this.onTouchMove);
        this.listen(element, 'touchend', this.onTouchEnd);
        this.listen(element, 'touchcancel', this.stopMomentum);
    }

    dispose(): void {
        this.stopMomentum();
        for (const d of this.disposables) d.dispose();
        this.disposables.length = 0;
    }

    private listen(element: HTMLElement, type: string, handler: (e: TouchEvent) => void) {
        const listener = handler as EventListener;
        // capture + non-passive so we see the events before xterm and can block page bounce
        element.addEventListener(type, listener, { capture: true, passive: false });
        this.disposables.push({ dispose: () => element.removeEventListener(type, listener, true) });
    }

    @bind
    private onTouchStart(e: TouchEvent) {
        if (e.touches.length !== 1) return;
        this.stopMomentum();
        const t = e.touches[0];
        this.startX = t.clientX;
        this.startY = this.lastY = t.clientY;
        this.startTime = this.lastTime = e.timeStamp;
        this.velocity = 0;
        this.remainder = 0;
        this.moved = false;
    }

    @bind
    private onTouchMove(e: TouchEvent) {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (!this.moved) {
            const dist = Math.hypot(t.clientX - this.startX, t.clientY - this.startY);
            if (dist < TAP_MAX_MOVE) return;
            this.moved = true;
        }
        e.preventDefault();
        e.stopPropagation();

        const dy = this.lastY - t.clientY; // positive = finger moved up = scroll down
        const dt = Math.max(e.timeStamp - this.lastTime, 1);
        this.velocity = dy / dt;
        this.lastY = t.clientY;
        this.lastTime = e.timeStamp;
        this.scrollBy(dy);
    }

    @bind
    private onTouchEnd(e: TouchEvent) {
        if (e.touches.length > 0) return;
        const duration = e.timeStamp - this.startTime;
        if (!this.moved && duration < TAP_MAX_DURATION) {
            // focus inside the user gesture so iOS/Android open the soft keyboard
            this.terminal.focus();
            return;
        }
        if (this.moved) {
            e.preventDefault();
            this.startMomentum();
        }
    }

    private startMomentum() {
        if (Math.abs(this.velocity) < MOMENTUM_MIN_VELOCITY) return;
        let last = performance.now();
        const step = (now: number) => {
            const dt = now - last;
            last = now;
            this.scrollBy(this.velocity * dt);
            this.velocity *= Math.pow(MOMENTUM_FRICTION, dt / 16);
            this.momentumFrame =
                Math.abs(this.velocity) >= MOMENTUM_MIN_VELOCITY ? requestAnimationFrame(step) : undefined;
        };
        this.momentumFrame = requestAnimationFrame(step);
    }

    @bind
    private stopMomentum() {
        if (this.momentumFrame !== undefined) cancelAnimationFrame(this.momentumFrame);
        this.momentumFrame = undefined;
    }

    private scrollBy(px: number) {
        const lineHeight = this.lineHeight();
        this.remainder += px;
        const lines = Math.trunc(this.remainder / lineHeight);
        if (lines === 0) return;
        this.remainder -= lines * lineHeight;

        const { terminal } = this;
        if (terminal.buffer.active.type === 'alternate') {
            // full-screen apps have no scrollback; emulate the wheel -> arrow keys behaviour
            const app = terminal.modes.applicationCursorKeysMode;
            const key = lines > 0 ? (app ? '\x1bOB' : '\x1b[B') : app ? '\x1bOA' : '\x1b[A';
            terminal.input(key.repeat(Math.abs(lines)));
            return;
        }
        terminal.scrollLines(lines);
    }

    private lineHeight(): number {
        const screen = this.terminal.element?.querySelector('.xterm-screen') as HTMLElement | null;
        const h = screen ? screen.clientHeight / this.terminal.rows : 0;
        return h > 0 ? h : 16;
    }
}
