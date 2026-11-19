// 时间一律换算成“当日 UTC 秒”，区间统一使用左闭右开 [start, end)。
const DAY_SECONDS = 24 * 60 * 60;

function secondsFromClock(text) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') throw new Error('时间值应为字符串');
  const clock = secondsFromClock(value);
  if (clock !== null) return clock;
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) throw new Error('无法解析时间：' + value);
  const date = new Date(milliseconds);
  return date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
}

export function tryParseTime(value) {
  try {
    return parseTime(value);
  } catch {
    return null;
  }
}

export function formatTime(seconds, { seconds: withSeconds = true } = {}) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const normalized = ((Math.round(seconds) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const rest = normalized % 60;
  const pad = number => String(number).padStart(2, '0');
  return pad(hours) + ':' + pad(minutes) + (withSeconds ? ':' + pad(rest) : '');
}



export function union(intervals) {
  const sorted = intervals
    .filter(interval => interval && Number.isFinite(interval[0]) && Number.isFinite(interval[1]) && interval[0] < interval[1])
    .map(([start, end]) => [start, end])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

export function intersectOne(left, right) {
  if (!left || !right) return null;
  const start = Math.max(left[0], right[0]);
  const end = Math.min(left[1], right[1]);
  return start < end ? [start, end] : null;
}

export function intersect(intervals, boundary) {
  return intervals.map(interval => intersectOne(interval, boundary)).filter(Boolean);
}

// 两组区间的交集（不是单区间边界）。逐对求交后合并。
export function intersectMany(left, right) {
  const result = [];
  for (const first of union(left)) {
    for (const second of union(right)) {
      const piece = intersectOne(first, second);
      if (piece) result.push(piece);
    }
  }
  return union(result);
}

export function subtract(intervals, cuts) {
  let pieces = union(intervals);
  for (const cut of union(cuts)) {
    const next = [];
    for (const piece of pieces) {
      if (cut[1] <= piece[0] || cut[0] >= piece[1]) {
        next.push(piece);
        continue;
      }
      if (piece[0] < cut[0]) next.push([piece[0], cut[0]]);
      if (cut[1] < piece[1]) next.push([cut[1], piece[1]]);
    }
    pieces = next;
  }
  return pieces;
}




export function span(intervals) {
  const merged = union(intervals);
  if (!merged.length) return null;
  return [merged[0][0], merged.at(-1)[1]];
}

