// What a command is doing, written to stderr while it works, so stdout stays the result (tables or --json).
// Every finished repo gets a line. In between, a terminal gets a spinner; anything else (an agent, a log)
// cannot redraw a line, so it gets a "still running" line whenever nothing has been said for a while.

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export function progress({ stream = process.stderr, tty = !!stream.isTTY && process.env.TERM !== 'dumb', quietFor = 20_000, now = Date.now } = {}) {
  const running = new Map(); // name → { step, note, since }
  let total = 0;
  let finished = 0;
  let width = 0;
  let frame = 0;
  let drawn = false;
  let timer = null;
  let lastLineAt = now();

  const took = (since) => {
    const s = Math.round((now() - since) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  };
  const clear = () => {
    if (drawn) stream.write('\r\x1b[2K');
    drawn = false;
  };
  const line = (text) => {
    clear();
    stream.write(`${text}\n`);
    lastLineAt = now();
  };
  /** "a: clone 12s, b: fetch 3s". The newest line of output is shown only when one thing runs, where it fits. */
  const describe = () => {
    const parts = [...running].map(([name, t]) => `${name}${t.step ? `: ${t.step}` : ''} ${took(t.since)}`);
    const only = running.size === 1 ? [...running.values()][0] : null;
    return parts.join(', ') + (only?.note ? ` (${only.note.slice(0, 70)})` : '');
  };
  const tick = () => {
    if (!running.size) return;
    if (tty) {
      const text = `${FRAMES[frame++ % FRAMES.length]} ${describe()}`;
      stream.write(`\r\x1b[2K${text.slice(0, Math.max(20, (stream.columns ?? 80) - 1))}`);
      drawn = true;
    } else if (now() - lastLineAt >= quietFor) line(`        … still running: ${describe()}`);
  };
  // unref: the timer shows work that is going on, and must never be what keeps the process alive.
  const watch = () => {
    timer ??= setInterval(tick, tty ? 100 : 1000).unref();
  };
  const unwatch = () => {
    if (running.size || !timer) return;
    clearInterval(timer);
    timer = null;
    clear();
  };

  return {
    line,
    tick,
    /** Stop showing anything, whatever is still in flight: for the way out after an error. */
    close() {
      running.clear();
      unwatch();
    },
    /** A heading, and the names that will each finish with a line (for the counter and the column width). */
    begin(title, names = []) {
      total = names.length;
      finished = 0;
      width = Math.max(0, ...names.map((n) => n.length));
      line(title);
    },
    /** Something in flight. step() says what it is doing, note() passes on its newest output, done() prints its line, end() just stops. */
    task(name) {
      const t = { step: '', note: '', since: now() };
      running.set(name, t);
      watch();
      const end = () => {
        running.delete(name);
        unwatch();
      };
      return {
        step(text) {
          t.step = text;
          t.note = '';
        },
        note(text) {
          t.note = text;
        },
        end,
        done(text) {
          end();
          const count = total ? `[${String(++finished).padStart(String(total).length)}/${total}] ` : '';
          const seconds = now() - t.since >= 1000 ? `  (${took(t.since)})` : '';
          line(`${count}${name.padEnd(width)}  ${text}${seconds}`);
        },
      };
    },
  };
}
