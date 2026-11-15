// Minimal, stateful ANSI SGR → HTML converter (16/256/truecolor, bold, dim, italic, underline).

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[([0-9;?]*)([A-Za-z])/g;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function xterm256(n) {
  if (n < 16) return null;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  n -= 16;
  const c = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
}

export function stripAnsi(s) {
  return String(s).replace(OSC, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Normalise carriage returns: keep only the last segment of progress-bar style lines. */
export function normalizeCR(s) {
  return s.replace(/\r\n/g, '\n').replace(/[^\n]*\r(?!\n)/g, '');
}

export function createAnsi() {
  const fresh = () => ({ b: 0, d: 0, i: 0, u: 0, fg: null, bg: null });
  let st = fresh();

  function colorAttr(v, kind, cls, sty) {
    if (v == null) return;
    if (typeof v === 'number' && v < 16) cls.push(`a-${kind}${v}`);
    else sty.push(`${kind === 'fg' ? 'color' : 'background'}:${typeof v === 'number' ? xterm256(v) : v}`);
  }

  function span(s) {
    if (!s) return '';
    s = esc(s.replace(/\x1b/g, ''));
    const cls = [];
    const sty = [];
    if (st.b) cls.push('a-b');
    if (st.d) cls.push('a-d');
    if (st.i) cls.push('a-i');
    if (st.u) cls.push('a-u');
    colorAttr(st.fg, 'fg', cls, sty);
    colorAttr(st.bg, 'bg', cls, sty);
    if (!cls.length && !sty.length) return s;
    return `<span${cls.length ? ` class="${cls.join(' ')}"` : ''}${sty.length ? ` style="${sty.join(';')}"` : ''}>${s}</span>`;
  }

  function apply(params) {
    const c = params === '' ? [0] : params.split(';').map((x) => Number(x) || 0);
    for (let i = 0; i < c.length; i++) {
      const n = c[i];
      if (n === 0) st = fresh();
      else if (n === 1) st.b = 1;
      else if (n === 2) st.d = 1;
      else if (n === 3) st.i = 1;
      else if (n === 4) st.u = 1;
      else if (n === 22) st.b = st.d = 0;
      else if (n === 23) st.i = 0;
      else if (n === 24) st.u = 0;
      else if (n >= 30 && n <= 37) st.fg = n - 30;
      else if (n >= 90 && n <= 97) st.fg = n - 90 + 8;
      else if (n === 39) st.fg = null;
      else if (n >= 40 && n <= 47) st.bg = n - 40;
      else if (n >= 100 && n <= 107) st.bg = n - 100 + 8;
      else if (n === 49) st.bg = null;
      else if (n === 38 || n === 48) {
        const key = n === 38 ? 'fg' : 'bg';
        if (c[i + 1] === 5) {
          st[key] = c[i + 2];
          i += 2;
        } else if (c[i + 1] === 2) {
          st[key] = `rgb(${c[i + 2]},${c[i + 3]},${c[i + 4]})`;
          i += 4;
        }
      }
    }
  }

  return function toHtml(text) {
    text = normalizeCR(String(text).replace(OSC, ''));
    let out = '';
    let last = 0;
    let m;
    CSI.lastIndex = 0;
    while ((m = CSI.exec(text))) {
      out += span(text.slice(last, m.index));
      last = CSI.lastIndex;
      if (m[2] === 'm') apply(m[1]);
    }
    return out + span(text.slice(last));
  };
}
