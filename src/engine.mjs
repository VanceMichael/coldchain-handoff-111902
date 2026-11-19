// 逐件（托盘）的证据链推理。
//
// 硬约束：
// 1. 读数只在“传感器安装段 ∩ 箱封/工位归属段 ∩ 货件在箱时段”内才归给某件货；
//    传感器留在原箱，不能证明已经搬出的货。
// 2. 卸空后的箱封读数不自动分摊给任何托盘。
// 3. 换装台独立温控只覆盖“确实经过该工位、且交接时段已明确”的货。
// 4. 校时误差区间重叠、先后无法判定时，不出具两份互相矛盾的证明，只标待认定。
// 5. 待归档段与“已确认无记录”严格分开；取件暂缺要说明卡在哪一类。

import {
  union, intersect, intersectMany, intersectOne, subtract, span, formatTime,
} from './time.mjs';
import {
  compareIntervals, latestMovesForUnit, unitSignature,
} from './picture.mjs';

export const STATE = Object.freeze({
  BREACH: '越限',
  MISSING: '尚缺覆盖',
  RELEASABLE: '有依据可放行',
  UNKNOWN: '待认定',
});

const BLOCKER_TEXT = Object.freeze({
  'awaiting-archive': '棚端待归档',
  'no-record': '尚未领取该时段的记录',
  'unverified-window': '该时段没有可归属的覆盖',
  'order-uncertain': '交接先后不能确定',
  'bay-unknown': '不能认定经过哪个工位',
  'route-unknown': '无法认定转运路径',
  'sensor-scope': '传感器归属不成立',
  'no-exit-scan': '缺少卸空扫码',
  'ambiguous-scan': '扫码内容互相冲突',
});

export function blockerText(code) {
  return BLOCKER_TEXT[code] ?? code;
}

function toSeconds(value) {
  if (Array.isArray(value)) return value.map(toSeconds);
  if (typeof value !== 'string') return value;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return value;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

function toInterval(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const start = toSeconds(value[0]);
  const end = toSeconds(value[1]);
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return [start, end];
}

export function normalizeLoggerRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    key: raw.key ?? raw.seal ?? raw.workingBay ?? null,
    sensor: raw.sensor ?? null,
    seal: raw.seal ?? null,
    workingBay: raw.workingBay ?? null,
    mounted: Array.isArray(raw.mounted) ? toInterval(raw.mounted) : null,
    bands: Array.isArray(raw.bands)
      ? raw.bands.map(entry => {
        const interval = toInterval(entry);
        return interval ? [interval[0], interval[1], Number(entry[2])] : null;
      }).filter(Boolean)
      : [],
    covered: Array.isArray(raw.covered) ? raw.covered.map(toInterval).filter(Boolean) : [],
    pending: Array.isArray(raw.pending) ? raw.pending.map(toInterval).filter(Boolean) : [],
    unverified: Array.isArray(raw.unverified) ? raw.unverified.map(toInterval).filter(Boolean) : [],
    archived: raw.archived !== false,
    missing: Boolean(raw.missing),
    windows: Array.isArray(raw.windows) ? raw.windows.map(window => ({
      from: toSeconds(window.from ?? window[0]),
      to: toSeconds(window.to ?? window[1]),
    })) : [],
    source: raw.source ?? 'logger/windows',
  };
}

function windowText(interval) {
  return interval ? { from: formatTime(interval[0]), to: formatTime(interval[1]) } : null;
}

function windowsText(intervals) {
  return union(intervals).map(windowText);
}

function bandStatus(value, band) {
  return value >= band[0] && value <= band[1] ? 'in-band' : 'breach';
}

// ---------- 箱封/工位记录索引 ----------

// recordsByKey: Map<key, record[]>。同一箱封/工位可能有多次领件结果，
// 逐窗口合并它们，避免“后一次只补了一段”把前一次覆盖丢掉。
export function mergeRecords(records) {
  const normalized = (records ?? []).map(normalizeLoggerRecord).filter(Boolean);
  if (!normalized.length) return null;
  const base = normalized.at(-1);
  const merged = {
    key: base.key,
    sensor: null,
    seal: base.seal,
    workingBay: base.workingBay,
    mounted: null,
    bands: [],
    covered: [],
    pending: [],
    unverified: [],
    windows: [],
    archived: normalized.some(record => record.archived !== false),
    missing: normalized.every(record => record.missing),
    source: 'logger/windows',
    parts: normalized.length,
  };
  const mountedLow = [];
  const mountedHigh = [];
  const sensors = new Set();
  for (const record of normalized) {
    if (record.sensor) sensors.add(record.sensor);
    if (record.mounted) {
      mountedLow.push(record.mounted[0]);
      mountedHigh.push(record.mounted[1]);
    }
    merged.bands.push(...record.bands);
    merged.covered.push(...record.covered);
    merged.pending.push(...record.pending);
    merged.unverified.push(...record.unverified);
    merged.windows.push(...record.windows);
  }
  if (mountedLow.length) merged.mounted = [Math.min(...mountedLow), Math.max(...mountedHigh)];
  merged.sensor = sensors.size === 1 ? [...sensors][0] : (sensors.size ? [...sensors].join('/') : null);
  merged.covered = union(merged.covered);
  // 后续补领确认了覆盖的时段，早先的待归档/未核实登记不再保留；
  // 但没被覆盖的部分仍要继续显示为待归档，不能因新窗口而消失。
  merged.pending = subtract(union(merged.pending), merged.covered);
  merged.unverified = subtract(union(merged.unverified), union([...merged.covered, ...merged.pending]));
  merged.bands = unionBands(merged.bands);
  return merged;
}

function unionBands(bands) {
  const sorted = [...bands].sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const [start, end, value] of sorted) {
    const last = merged.at(-1);
    if (last && last[1] === start && last[2] === value) last[1] = end;
    else merged.push([start, end, value]);
  }
  return merged;
}

export function recordFor(recordsByKey, key) {
  if (!key) return null;
  const value = recordsByKey instanceof Map ? recordsByKey.get(key) : recordsByKey?.[key];
  if (!value) return null;
  return mergeRecords(Array.isArray(value) ? value : [value]);
}

export function recordFingerprint(record) {
  if (!record) return 'none';
  return JSON.stringify({
    mounted: record.mounted,
    bands: record.bands,
    covered: record.covered,
    pending: record.pending,
    missing: record.missing,
    archived: record.archived,
  });
}

// ---------- 交接时刻 ----------

function findCustodyScans(picture, ref, action, seal) {
  const events = picture?.scans?.events ?? [];
  let candidates = [];
  let basis = null;
  if (Array.isArray(ref) && ref.length >= 2) {
    candidates = events.filter(event => event.origin === ref[0] && event.scanId === ref[1]);
    basis = ref.join('/');
  }
  if (!candidates.length && action) {
    candidates = events.filter(event => event.action === action && (!seal || event.seal === seal));
    basis = action + '事件';
  }
  if (!candidates.length) return { event: null, issue: 'missing', basis, candidates };
  const usable = candidates.filter(event => event.corrected && !event.conflictGroup);
  if (!usable.length) {
    const conflicted = candidates.some(event => event.conflictGroup);
    return {
      event: null,
      issue: conflicted ? 'ambiguous-scan' : (candidates[0].issue ?? 'missing'),
      basis,
      candidates,
    };
  }
  const identities = new Set(usable.map(event => event.origin + '|' + event.scanId + '|' + event.observed));
  const centers = new Set(usable.map(event => event.corrected.center));
  if (identities.size > 1 || centers.size > 1) {
    return { event: null, issue: 'ambiguous-scan', basis, candidates: usable };
  }
  return { event: usable[0], issue: null, basis, candidates: usable };
}

function scanView(event) {
  if (!event) return null;
  return {
    origin: event.origin,
    scanId: event.scanId,
    action: event.action,
    seal: event.seal,
    observed: event.observed,
    clockProof: event.clockProof,
    corrected: {
      from: formatTime(event.corrected.low),
      to: formatTime(event.corrected.high),
      center: formatTime(event.corrected.center),
      uncertaintySeconds: event.corrected.uncertaintySeconds,
    },
    source: 'scanner/events',
  };
}

// ---------- 单路段判定 ----------

function missingClasses(pieces, pending, unverified = []) {
  const pendingUnion = union(pending);
  const unverifiedUnion = union(unverified);
  const rest = union(pieces);
  const archivedMissing = subtract(rest, pendingUnion);
  return [
    ...intersectMany(rest, pendingUnion).map(piece => ({ piece, blocker: 'awaiting-archive' })),
    ...intersectMany(archivedMissing, unverifiedUnion)
      .map(piece => ({ piece, blocker: 'unverified-window' })),
    ...subtract(archivedMissing, unverifiedUnion)
      .map(piece => ({ piece, blocker: 'no-record' })),
  ];
}

function assessSegment({ role, key, record, need, band, applies = true, notes = [] }) {
  const segment = {
    role,
    key,
    source: record?.source ?? 'logger/windows',
    sensor: record?.sensor ?? null,
    workingBay: record?.workingBay ?? null,
    applies,
    window: windowText(need),
    coverage: [],
    pending: [],
    missing: [],
    unattributed: null,
    breaches: [],
    readings: [],
    notes: [...notes],
    blockers: [],
    verdict: STATE.RELEASABLE,
  };
  if (!need || need[0] >= need[1]) {
    segment.notes.push('该路段没有可评估的时间区间');
    segment.blockers = [role === 'transfer' ? 'bay-unknown' : 'no-record'];
    segment.verdict = applies ? STATE.MISSING : STATE.UNKNOWN;
    return segment;
  }
  if (!record) {
    if (role === 'transfer' && !applies) {
      segment.missing = [{
        window: windowText(need),
        blocker: 'order-uncertain',
        detail: '该工位没有已取到的原始记录，交接时段也不能确定，无法认定是否经过该工位',
      }];
      segment.blockers = ['order-uncertain'];
      segment.verdict = STATE.UNKNOWN;
      return segment;
    }
    const blocker = 'no-record';
    segment.missing = [{ window: windowText(need), blocker }];
    segment.blockers = [blocker];
    segment.verdict = STATE.MISSING;
    if (role === 'transfer' && key) {
      segment.notes.push('工位 ' + key + ' 已由装箱动作认定，但还没有领取到该工位的原始温控记录');
    }
    return segment;
  }

  let coverage = union(record.covered);
  if (record.mounted) coverage = intersect(coverage, record.mounted);
  coverage = intersect(coverage, need);
  const pending = intersect(union(record.pending), need);
  const unverified = intersect(union(record.unverified), need);
  const classified = missingClasses(subtract([need], union([...coverage, ...pending])), pending, unverified);
  segment.coverage = windowsText(coverage);
  segment.pending = windowsText(pending);
  segment.missing = classified.map(entry => ({ window: windowText(entry.piece), blocker: entry.blocker }));

  let uncertainReading = null;
  for (const [start, end, value] of record.bands) {
    const clipped = intersectOne([start, end], need);
    if (!clipped) {
      if (start >= need[1] && bandStatus(value, band) === 'breach') {
        segment.notes.push('记录在 ' + formatTime(start) + '–' + formatTime(end) + ' 的读数 ' + value +
          '℃ 超出温区，但发生在该件已经离开之后，不归属本托盘');
      }
      continue;
    }
    const spanSeconds = end - start;
    const presentSeconds = clipped[1] - clipped[0];
    const attributed = spanSeconds > 0 && presentSeconds * 2 >= spanSeconds; // 至少一半区间对得上
    if (!attributed) {
      const status = bandStatus(value, band);
      segment.readings.push({
        from: formatTime(start), to: formatTime(end), c: value,
        status: status === 'breach' ? 'boundary-breach' : 'boundary',
        note: status === 'breach'
          ? '读数区间大部分不在该件在场期间，无法确定越限是否发生在托盘在场时'
          : '读数区间大部分不在该件在场期间，数值在温区内，不影响结论',
      });
      if (status === 'breach') uncertainReading = segment.readings.at(-1);
      continue;
    }
    const status = bandStatus(value, band);
    const truncated = clipped[0] !== start || clipped[1] !== end;
    segment.readings.push({
      from: formatTime(start), to: formatTime(end), c: value, status,
      attributed: windowText(clipped),
      ...(truncated ? { note: '读数区间部分落在该件在场期间之外，仅按重叠部分归属' } : {}),
    });
    if (status === 'breach') segment.breaches.push(clipped);
  }
  segment.breaches = windowsText(segment.breaches);

  if (!applies) {
    // 记录存在，但该件是否经过此工位、何时经过尚不能认定：只登记窗口，不当作证明。
    // 越限读数同样不能作为对该托盘的证明，移入 unattributed 供复核。
    segment.unattributed = {
      coverage: segment.coverage, pending: segment.pending,
      missing: segment.missing, readings: segment.readings, breaches: segment.breaches,
    };
    segment.breaches = [];
    segment.blockers = [...new Set([
      ...(role === 'transfer'
        ? [key ? 'order-uncertain' : 'bay-unknown']
        : ['route-unknown']),
      ...(pending.length ? ['awaiting-archive'] : []),
    ])];
    segment.verdict = STATE.UNKNOWN;
    segment.notes.push(key
      ? '工位/箱封记录存在，但交接时段未明确，不能归属该托盘'
      : '无法认定托盘经过哪个工位');
    return segment;
  }

  segment.blockers = [...new Set([
    ...classified.map(entry => entry.blocker),
    ...(pending.length ? ['awaiting-archive'] : []),
  ])];

  if (segment.breaches.length) {
    segment.verdict = STATE.BREACH;
  } else if (segment.missing.length || segment.pending.length) {
    segment.verdict = STATE.MISSING;
  } else if (uncertainReading) {
    segment.verdict = STATE.UNKNOWN;
    segment.blockers = [...new Set([...segment.blockers, 'sensor-scope'])];
    segment.notes.push('跨越边界的越限读数不足以归属，避免出具互相矛盾的证明');
  } else {
    segment.verdict = STATE.RELEASABLE;
  }
  return segment;
}

// ---------- 数据视野 ----------

function dataHorizon(recordsByKey, picture, fallback) {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  const consider = record => {
    if (!record) return;
    for (const interval of [...record.covered, ...record.pending, ...record.unverified]) {
      earliest = Math.min(earliest, interval[0]);
      latest = Math.max(latest, interval[1]);
    }
    if (record.mounted) {
      earliest = Math.min(earliest, record.mounted[0]);
      latest = Math.max(latest, record.mounted[1]);
    }
  };
  const values = recordsByKey instanceof Map
    ? [...recordsByKey.values()]
    : Object.values(recordsByKey ?? {});
  for (const value of values) consider(mergeRecords(Array.isArray(value) ? value : [value]));
  for (const event of picture?.scans?.events ?? []) {
    if (!event.corrected) continue;
    earliest = Math.min(earliest, event.corrected.low);
    latest = Math.max(latest, event.corrected.high);
  }
  if (!Number.isFinite(earliest)) earliest = fallback ?? 0;
  if (!Number.isFinite(latest)) latest = fallback ?? earliest + 3600;
  return { earliest, latest };
}

// ---------- 路段划分与整条路径 ----------

export function evaluateRoute({ picture, unit, band, recordsByKey, fallbackHorizon }) {
  const empty = (blockers, conflicts, notes) => ({
    route: null,
    state: blockers.includes('order-uncertain') ? STATE.UNKNOWN : STATE.MISSING,
    blockers,
    conflicts,
    notes,
    segments: [],
    horizon: null,
  });
  const moves = latestMovesForUnit(picture.packing, unit);
  if (!moves.length) {
    return empty(['route-unknown'], [], ['原始资料中没有该托盘的换装归属']);
  }
  if (moves.length > 1) {
    return empty(['route-unknown'], [{
      kind: 'route-conflict',
      unit,
      moves: moves.map(move => move.move),
      detail: '最新装箱资料把同一托盘归入多条动作，须以实物标签复核',
    }], ['最新装箱资料对同一托盘存在多条归属，暂不判定']);
  }

  const move = moves[0];
  const history = picture.packing.history.get(move.move) ?? [];
  const previous = history.length > 1 ? history.at(-2) : null;
  const { earliest, latest } = dataHorizon(recordsByKey, picture, fallbackHorizon);
  const exitScan = findCustodyScans(picture, move.exit, '卸空', move.oldSeal);
  const enterScan = findCustodyScans(picture, move.enter, '装箱', move.newSeal);
  const exitEvent = exitScan.event;
  const enterEvent = enterScan.event;
  const conflicts = [];
  const notes = [];

  let order = 'unknown';
  if (exitEvent && enterEvent) order = compareIntervals(exitEvent.corrected, enterEvent.corrected);
  if (exitEvent && enterEvent && order === 'after') {
    conflicts.push({
      kind: 'order-reversed', unit,
      detail: '装箱扫码早于卸空扫码，原始资料互相矛盾，不据此放行',
      scans: [scanView(exitEvent), scanView(enterEvent)],
    });
    notes.push('交接顺序与资料矛盾，涉及该托盘的两个路段都按待认定处理');
  }
  if (exitEvent && enterEvent && order === 'overlap') {
    conflicts.push({
      kind: 'order-uncertain', unit,
      detail: '两次扫码的校时误差区间重叠，无法判定卸空与装箱的先后',
      scans: [scanView(exitEvent), scanView(enterEvent)],
    });
    notes.push('交接先后不能确定，换装台独立温控不用于该托盘');
  }
  if (!exitEvent) {
    const ambiguous = exitScan.issue === 'ambiguous-scan';
    conflicts.push({
      kind: ambiguous ? 'scan-id-conflict' : 'exit-scan-missing',
      unit,
      detail: ambiguous
        ? '同一扫码编号存在不同的原始内容，无法认定哪条才是卸空原件'
        : '无法认定托盘离开原箱的时刻，原箱温控不能按托盘截断',
    });
    notes.push('未见可用的卸空扫码：' + blockerText(ambiguous ? 'ambiguous-scan' : 'no-exit-scan'));
  }
  if (!enterEvent) {
    notes.push('未见可用的换入扫码，进入新箱的时刻按工位记录窗边界处理');
  }

  const originSeal = move.oldSeal ?? exitEvent?.seal ?? null;
  const destinationSeal = move.newSeal ?? enterEvent?.seal ?? null;
  const originRecord = recordFor(recordsByKey, originSeal);
  const bayRecord = recordFor(recordsByKey, move.bay);
  const destinationRecord = recordFor(recordsByKey, destinationSeal);

  const exitLow = exitEvent ? exitEvent.corrected.low : null;
  const exitHigh = exitEvent ? exitEvent.corrected.high : null;
  const enterLow = enterEvent ? enterEvent.corrected.low : null;
  const enterHigh = enterEvent ? enterEvent.corrected.high : null;
  const originStart = originRecord?.mounted?.[0] ?? earliest;

  const bayRange = span([...(bayRecord?.covered ?? []), ...(bayRecord?.pending ?? [])]);
  const horizon = latest || fallbackHorizon || (enterHigh ?? exitHigh ?? 0) + 3600;
  const orderKnown = order === 'before';

  const originEnd = orderKnown ? exitLow : Math.min(exitLow ?? horizon, enterLow ?? horizon);
  const transferStart = originEnd;
  let transferEnd = orderKnown && enterHigh !== null ? enterHigh : (bayRange?.[1] ?? horizon);
  let destinationStart = orderKnown && enterLow !== null ? enterLow : transferEnd;

  const orderProblem = conflicts.some(conflict => conflict.kind === 'order-uncertain' || conflict.kind === 'order-reversed');
  const routeFatal = !exitEvent;

  // 换装台独立温控的适用条件：确实经过该工位，且交接时段已明确。
  // - 两次扫码都有且先后可判：交接时段 = [卸空下界, 装箱上界]。
  // - 只有卸空扫码：开始时刻明确，结束时刻取工位记录窗边界，仍算有界，
  //   但 definite=false，并在说明里写明依据。
  // - 只有装箱扫码或顺序不明：不适用，只登记工位记录，不出证明。
  const handoverBasis = (() => {
    if (!exitEvent || !move.bay || orderProblem) return null;
    if (enterEvent) return orderKnown ? '两次扫码交接' : null;
    if (bayRange) return '工位记录窗边界';
    return null;
  })();
  const transferApplies = Boolean(handoverBasis);
  // 没有换入扫码时，工位记录窗的边界就是转入新箱的最早可行时刻；
  // 交接窗随后续记录延伸（不是提前封死），转入段从交接窗末端开始。
  if (!enterEvent && bayRange) {
    transferEnd = Math.max(transferEnd, Math.min(bayRange[1], horizon));
    destinationStart = Math.max(destinationStart, transferEnd);
  }

  const originSegment = assessSegment({
    role: 'origin',
    key: originSeal,
    record: originRecord,
    need: [originStart, originEnd],
    band,
    applies: !routeFatal,
    notes: routeFatal ? ['卸空时刻未认定，原箱读数不能按托盘截断'] : [],
  });
  const transferNotes = !move.bay
    ? ['装箱动作未记录工位，无法领取换装台独立温控']
    : !transferApplies
      ? ['交接时段不明确，换装台独立温控不适用，只登记工位记录（不作证明）']
      : enterEvent
        ? []
        : ['没有换入扫码，交接结束时刻按工位记录窗边界，恢复后应补扫'];
  const transferSegment = assessSegment({
    role: 'transfer',
    key: move.bay,
    record: bayRecord,
    need: [transferStart, transferEnd],
    band,
    applies: transferApplies,
    notes: transferNotes,
  });
  const destinationSegment = assessSegment({
    role: 'destination',
    key: destinationSeal,
    record: destinationRecord,
    need: [destinationStart, horizon],
    band,
    applies: true,
    notes: destinationRecord
      ? ['换入箱观测早于实际进入箱内的部分已按进入时刻截取']
      : [],
  });

  const segments = [originSegment, transferSegment, destinationSegment];
  const anyBreach = segments.some(segment => segment.verdict === STATE.BREACH);
  const hasMissing = segments.some(segment => segment.missing.length || segment.pending.length);
  let state = STATE.RELEASABLE;
  if (anyBreach) state = STATE.BREACH;
  else if (orderProblem) state = STATE.UNKNOWN;
  else if (hasMissing) state = STATE.MISSING;
  else if (segments.some(segment => segment.verdict === STATE.UNKNOWN)) state = STATE.UNKNOWN;

  const blockers = [...new Set(segments.flatMap(segment => segment.blockers))];

  const route = {
    move: move.move,
    revision: move.revision,
    previousRevision: previous?.revision ?? null,
    oldSeal: originSeal,
    newSeal: destinationSeal,
    bay: move.bay,
    exit: scanView(exitEvent),
    enter: scanView(enterEvent),
    order,
    handover: {
      from: formatTime(transferStart),
      to: formatTime(transferEnd),
      basis: handoverBasis,
      definite: orderKnown,
    },
    segments,
    signature: unitSignature(move, unit),
  };

  if (exitScan.issue === 'ambiguous-scan') blockers.push('ambiguous-scan');
  if (transferSegment.blockers.includes('bay-unknown')) blockers.push('bay-unknown');

  return {
    route,
    state,
    blockers: [...new Set(blockers)],
    conflicts,
    notes,
    horizon: { earliest: formatTime(earliest), latest: formatTime(latest) },
  };
}

// ---------- 处置 ----------

function dispositionFor(evaluation, custody) {
  const blockers = evaluation.blockers ?? [];
  const accepted = custody.acceptedBy;
  const receipted = custody.receipts;
  const base = { acceptedBy: accepted, receipts: receipted.map(receipt => receipt.requestKey) };
  if (accepted.length > 1) {
    return {
      ...base,
      code: 'conflict-hold',
      label: '接手资料冲突，先核对实际持有人',
      detail: accepted.join('、') + ' 都记录了实际签收',
      actions: accepted.map(desk => ({ type: 'inquire', party: desk, detail: '核对是否实际接手' })),
    };
  }
  if (evaluation.state === STATE.BREACH) {
    if (accepted.length) {
      return {
        ...base,
        code: 'recall',
        label: '温控越限且已签收：通知持有者复验或召回',
        detail: '当前由 ' + accepted[0] + ' 签收',
        actions: accepted.map(desk => ({ type: 'recall-or-reverify', party: desk })),
      };
    }
    if (receipted.length) {
      return {
        ...base,
        code: 'suspend-unsigned',
        label: '温控越限且放行凭据未签收：暂停',
        detail: '发出的放行凭据涉及越限货件，签收前暂停使用',
        actions: receipted.map(receipt => ({
          type: 'suspend-release', party: receipt.desk, requestKey: receipt.requestKey,
        })),
      };
    }
    return {
      ...base, code: 'do-not-release', label: '温控越限，不得放行', detail: '按越限流程复验该托盘',
      actions: [{ type: 'do-not-release' }],
    };
  }
  if (evaluation.state === STATE.UNKNOWN) {
    return {
      ...base,
      code: 'hold-await-identification',
      label: '证据不足以认定，暂不出具证明',
      detail: (evaluation.conflicts ?? []).map(conflict => conflict.detail).join('；') ||
        '资料不足以判定路段或交接顺序',
      actions: [{ type: 'hold', reason: '补证后再判定' }],
    };
  }
  if (evaluation.state === STATE.MISSING) {
    if (blockers.includes('order-uncertain')) {
      return {
        ...base,
        code: 'hold-await-identification',
        label: '交接先后不能确定，暂不出具证明',
        detail: '校时精度不足，无法确定托盘经过工位的时间',
        actions: [{ type: 'hold', reason: '补站端校时或交接记录' }],
      };
    }
    if (blockers.includes('awaiting-archive')) {
      return {
        ...base,
        code: 'hold-awaiting-archive',
        label: '等待棚端归档后复核',
        detail: '仍有待归档的原始温控段，归档前不能认定',
        actions: [{ type: 'await-archive', reason: '棚端待归档' }],
      };
    }
    if (blockers.includes('bay-unknown') || blockers.includes('route-unknown')) {
      return {
        ...base,
        code: 'hold-route-unclear',
        label: '还不能认定托盘经过哪个工位',
        detail: '换装路径或工位归属不足，须补证',
        actions: [{ type: 'request-scan', reason: '补扫或补录换装动作' }],
      };
    }    return {
      ...base,
      code: 'hold-missing-record',
      label: '尚缺覆盖，须补领原始记录',
      detail: '至少一个路段没有可归属的温控依据',
      actions: [{ type: 'request-record' }],
    };
  }
  if (accepted.length) {
    return {
      ...base,
      code: 'handover-continuing',
      label: '有依据可放行，已由收货台签收',
      detail: '完整覆盖且在货品温区内，原交接依据可继续查询',
      actions: [{ type: 'continue', party: accepted[0] }],
    };
  }
  if (receipted.length) {
    return {
      ...base,
      code: 'release-unsigned',
      label: '有依据可放行，等待收货台签收',
      detail: '放行凭据已经发出，签收前以台前清点为准',
      actions: receipted.map(receipt => ({
        type: 'await-signoff', party: receipt.desk, requestKey: receipt.requestKey,
      })),
    };
  }
  return {
    ...base,
    code: 'release-ready',
    label: '有依据可放行',
    detail: '完整覆盖且在货品温区内，可按拣货单领取放行凭据',
    actions: [{ type: 'may-release' }],
  };
}

// ---------- 补证指引 ----------

function inquiryForSegment(route, segment, entry) {
  if (entry.blocker === 'awaiting-archive') {
    return {
      station: segment.role === 'transfer' ? '换装棚' : (route?.enter?.origin ?? route?.exit?.origin ?? '棚端'),
      key: segment.key,
      window: entry.window,
      action: 'await-archive',
      reason: '棚端待归档段，归档后按箱封或工位补领',
    };
  }
  if (entry.blocker === 'order-uncertain') {
    return {
      station: route?.exit?.origin ?? '扫码站',
      key: route?.exit?.scanId ?? null,
      action: 'request-clock-proof',
      reason: '校时精度不足以确定交接顺序，须补站端校时或交接记录',
    };
  }
  if (entry.blocker === 'bay-unknown' || entry.blocker === 'route-unknown') {
    return {
      station: '换装棚',
      key: segment.key ?? route?.bay ?? null,
      action: 'request-bay-record',
      reason: '不能认定该托盘经过的工位或交接时段，须补换装动作与工位记录',
    };
  }
  return {
    station: segment.role === 'transfer'
      ? '换装棚'
      : (route?.enter?.origin ?? route?.exit?.origin ?? '棚端'),
    key: segment.key,
    window: entry.window,
    action: 'request-record',
    reason: entry.blocker === 'unverified-window'
      ? '已取到的记录未覆盖该时段，且没有登记待归档段；须补领该窗口或确认是否确无记录'
      : '该时段还没有归到本托盘的原始读数',
  };
}

export function buildInquiries(evaluation) {
  const inquiries = [];
  const seen = new Set();
  const push = inquiry => {
    const identity = JSON.stringify(inquiry);
    if (seen.has(identity)) return;
    seen.add(identity);
    inquiries.push(inquiry);
  };
  const route = evaluation.route;
  for (const segment of route?.segments ?? []) {
    for (const entry of segment.missing) {
      push(inquiryForSegment(route, segment, entry));
    }
    // 待归档段同样要能领取：现场班组需要知道“在等归档”而不是“已经认定没问题”
    for (const entry of segment.pending) {
      push(inquiryForSegment(route, segment, {
        blocker: 'awaiting-archive',
        window: { from: entry.from, to: entry.to },
      }));
    }
    // 交接时段不明确时，该工位即使有记录也不能归属，须先补站端校时/交接记录
    if (segment.applies === false && segment.blockers.includes('order-uncertain') &&
      route?.exit && route?.enter) {
      push(inquiryForSegment(route, segment, { blocker: 'order-uncertain' }));
    }
  }
  for (const blocker of evaluation.blockers ?? []) {
    if (blocker === 'ambiguous-scan') {
      push({
        station: '扫码站', key: route?.exit?.scanId ?? null,
        action: 'request-original-scan',
        reason: '同一扫码编号存在不同原始内容，须取站端原始记录核对',
      });
    }
    if (blocker === 'no-exit-scan') {
      push({
        station: '扫码站', key: route?.move ?? null,
        action: 'request-exit-scan',
        reason: '缺少卸空扫码，无法认定托盘离开原箱的时间',
      });
    }
  }
  return inquiries;
}

// ---------- 单件汇总 ----------

export function evaluateUnit({
  picture, unit, band, recordsByKey, fallbackHorizon, acceptances, receipts, picklists, arrival,
}) {
  const evaluation = evaluateRoute({ picture, unit, band, recordsByKey, fallbackHorizon });
  const route = evaluation.route;
  const claims = (acceptances ?? []).filter(claim => claim.unit === unit);
  const acceptedBy = [...new Set(claims.map(claim => claim.desk))];
  const custody = {
    arrival,
    picklists: (picklists ?? []).filter(picklist => picklist.units.includes(unit))
      .map(picklist => ({ desk: picklist.desk, sheet: picklist.sheet })),
    claims: claims.map(claim => ({
      desk: claim.desk,
      sheet: claim.sheet,
      claimId: claim.claimId,
      arrival: claim.arrival,
      source: claim.source ?? 'receiver/acceptances',
    })),
    acceptedBy,
    unclaimed: acceptedBy.length === 0,
    receipts: (receipts ?? []).filter(receipt => receipt.arrival === arrival && receipt.units.includes(unit))
      .map(receipt => ({
        requestKey: receipt.requestKey,
        desk: receipt.desk,
        sheet: receipt.sheet,
        finding: receipt.finding,
        state: receipt.state ?? '已受理',
      })),
  };
  if (acceptedBy.length > 1) {
    custody.conflict = {
      kind: 'acceptance-conflict',
      units: [unit],
      desks: acceptedBy,
      detail: '多个收货台都记录了实际签收',
      inquire: acceptedBy,
    };
  }

  const evidence = {
    state: evaluation.state,
    verdict: evaluation.state,
    segments: route?.segments ?? [],
    breaches: (route?.segments ?? []).flatMap(segment =>
      segment.breaches.map(entry => ({ segment: segment.role, key: segment.key, ...entry }))),
    missing: (route?.segments ?? []).flatMap(segment => segment.missing.map(entry => ({
      segment: segment.role, key: segment.key, window: entry.window,
      blocker: entry.blocker, blockerText: blockerText(entry.blocker),
    }))),
    pending: (route?.segments ?? []).flatMap(segment => segment.pending.map(entry => ({
      segment: segment.role, key: segment.key, ...entry,
    }))),
    blockers: evaluation.blockers,
    blockerText: evaluation.blockers.map(blockerText),
    observations: (route?.segments ?? []).flatMap(segment => segment.readings
      .filter(reading => reading.status !== 'boundary')
      .map(reading => ({ ...reading, segment: segment.role, key: segment.key }))),
    notes: [...(evaluation.notes ?? []), ...((route?.segments ?? []).flatMap(segment => segment.notes))],
    conflicts: evaluation.conflicts ?? [],
  };

  return {
    unit,
    arrival,
    state: evaluation.state,
    band,
    route,
    evidence,
    custody,
    disposition: dispositionFor(evaluation, custody),
    inquiries: buildInquiries(evaluation),
    horizon: evaluation.horizon ?? null,
    signature: route?.signature ?? null,
  };
}

// ---------- 已发凭据的受影响范围 ----------

export function assessReceipt({ picture, receipt, acceptances, band, recordsByKey, fallbackHorizon }) {
  const reports = receipt.units.map(unit => {
    const evaluation = evaluateRoute({ picture, unit, band, recordsByKey, fallbackHorizon });
    const claims = (acceptances ?? []).filter(claim => claim.unit === unit);
    const desks = [...new Set(claims.map(claim => claim.desk))];
    const snapshot = receipt.signatures?.[unit] ?? null;
    const signature = evaluation.route?.signature ?? null;
    const routeChanged = snapshot !== null && snapshot !== signature;
    return { unit, evaluation, claims, desks, snapshot, signature, routeChanged };
  });

  const acceptedUnits = reports.filter(report => report.desks.includes(receipt.desk)).map(report => report.unit);
  const unacceptedUnits = reports.filter(report => !report.desks.includes(receipt.desk)).map(report => report.unit);
  const laterHandoffs = reports.flatMap(report => report.desks
    .filter(desk => desk !== receipt.desk)
    .map(desk => ({
      unit: report.unit,
      desk,
      claimIds: report.claims.filter(claim => claim.desk === desk).map(claim => claim.claimId),
    })));
  const routeChangedUnits = reports.filter(report => report.routeChanged).map(report => report.unit);

  const actions = [];
  for (const report of reports) {
    const here = report.desks.includes(receipt.desk);
    const elsewhere = report.desks.filter(desk => desk !== receipt.desk);
    const breach = report.evaluation.state === STATE.BREACH;
    const missing = report.evaluation.state === STATE.MISSING;
    const unknown = report.evaluation.state === STATE.UNKNOWN;
    if (report.desks.length > 1) {
      actions.push({
        type: 'conflict-hold', unit: report.unit, desks: report.desks,
        detail: '多个收货台都记录接手，先核对实际持有人，再决定复验或召回',
      });
    } else if (report.routeChanged && here) {
      actions.push({
        type: breach ? 'notify-recall' : 'notify-reverify', unit: report.unit, party: receipt.desk,
        detail: breach
          ? '拼箱范围更正后该件已越限，通知持有者复验或召回'
          : '拼箱范围已更正，通知持有者按新归属复验原交接依据',
      });
    } else if (report.routeChanged && elsewhere.length) {
      actions.push({
        type: 'wrong-holder', unit: report.unit, party: receipt.desk, actualHolder: elsewhere[0],
        detail: '该件已由 ' + elsewhere[0] + ' 实际接手，' + receipt.desk + ' 的凭据须更正',
      });
      if (breach) {
        actions.push({
          type: 'notify-recall', unit: report.unit, party: elsewhere[0],
          detail: '该件实际由 ' + elsewhere[0] + ' 接手且拼箱更正后已越限，通知其复验或召回',
        });
      }
    } else if (report.routeChanged) {
      actions.push({
        type: 'suspend-unsigned', unit: report.unit, party: receipt.desk,
        detail: '拼箱范围更正且尚未签收，暂停该件放行',
      });
    } else if (breach && here) {
      actions.push({
        type: 'notify-recall', unit: report.unit, party: receipt.desk,
        detail: '已签收后发现越限，通知持有者复验或召回',
      });
    } else if (breach && elsewhere.length) {
      // 凭据写的是本台，但实物已由另一台实际接手：本台暂停，同时通知实际持有人
      actions.push({
        type: 'suspend-unsigned', unit: report.unit, party: receipt.desk,
        detail: '该件已由 ' + elsewhere[0] + ' 实际接手且越限，本台暂缓该件',
      });
      actions.push({
        type: 'notify-recall', unit: report.unit, party: elsewhere[0],
        detail: '该件由 ' + elsewhere[0] + ' 实际接手且越限，通知其复验或召回',
      });
    } else if (breach || missing || unknown) {
      actions.push({
        type: breach ? 'suspend-unsigned' : 'hold-until-evidence', unit: report.unit, party: receipt.desk,
        detail: breach ? '该件越限，签收前暂停放行' : '该件证据不足，签收前保持暂停并补证',
      });
    }
  }

  return {
    requestKey: receipt.requestKey,
    desk: receipt.desk,
    sheet: receipt.sheet,
    arrival: receipt.arrival,
    finding: receipt.finding,
    state: receipt.state ?? '已受理',
    units: receipt.units,
    acceptedUnits,
    unacceptedUnits,
    laterHandoffs,
    routeChangedUnits,
    actions,
    unaffected: reports
      .filter(report => !report.routeChanged && report.evaluation.state === STATE.RELEASABLE)
      .map(report => report.unit),
  };
}

// ---------- 更正后的补领/沿用 ----------

// priorClaims: Map<claimKey, {unit, role, key, window, segmentSignature, fingerprint, verdict}>
//
// 沿用以“路段”为单位判断：只要该托盘在这一路段上的箱封/工位、时间窗和原始记录
// 都没有变化，即使整条路径因更正改了别的路段，这一节的已核实结果仍然可沿用。
export function reconcileClaims({ units, current, priorClaims, priorSignatures }) {
  const reused = [];
  const reacquired = [];
  const invalidated = [];
  const next = new Map();
  const wanted = new Set(units);
  const segmentSignature = segment => JSON.stringify({
    role: segment.role,
    key: segment.key,
    window: segment.window,
    applies: segment.applies,
  });
  for (const report of current) {
    const unit = report.unit;
    if (!wanted.has(unit)) continue;
    const route = report.route;
    const signature = route?.signature ?? null;
    const previousSignature = priorSignatures instanceof Map
      ? priorSignatures.get(unit) ?? null
      : priorSignatures?.[unit] ?? null;
    const routeChanged = previousSignature !== null && previousSignature !== signature;
    const coveredKeys = new Set();
    for (const segment of route?.segments ?? []) {
      const window = segment.window ? segment.window.from + '–' + segment.window.to : null;
      const key = unit + '|' + segment.role + '|' + segment.key;
      coveredKeys.add(key);
      const record = recordFor(report.recordsByKey, segment.key);
      const fingerprint = recordFingerprint(record);
      const signatureOfSegment = segmentSignature(segment);
      const prior = priorClaims?.get?.(key) ?? null;
      const claim = {
        unit, role: segment.role, key: segment.key, window, signature,
        segmentSignature: signatureOfSegment, fingerprint,
        verdict: segment.verdict, state: report.state,
      };
      const sameSegment = prior && prior.segmentSignature !== undefined
        ? prior.segmentSignature === signatureOfSegment
        : prior && prior.window === window;
      if (prior && sameSegment && prior.fingerprint === fingerprint) {
        // 原始记录没变就可以沿用领取结果；但只有此前已经核实到可放行的，才算“已核实结论”沿用。
        const verified = prior.verdict === STATE.RELEASABLE && claim.verdict === STATE.RELEASABLE;
        reused.push({
          ...claim,
          previousVerdict: prior.verdict,
          verified,
          reason: verified
            ? '路段与原始记录均未变，沿用已核实结论'
            : '路段与原始记录均未变，沿用已领取记录（结论按当前资料重算）',
        });
      } else if (prior && !sameSegment) {
        invalidated.push({
          ...prior, unit, role: segment.role, key: segment.key,
          reason: '该托盘在此路段的归属或时间窗已更正，原领取结果不再适用',
        });
        reacquired.push({
          ...claim,
          reason: prior.fingerprint === fingerprint
            ? '按新路径重领同一份原始记录'
            : '按新路径补领原始记录',
        });
      } else {
        reacquired.push({ ...claim, reason: prior ? '原始记录已变化，重新核对' : '首次领取' });
      }
      next.set(key, claim);
    }
    if (routeChanged) {
      for (const [key, prior] of priorClaims ?? []) {
        if (prior.unit !== unit || coveredKeys.has(key)) continue;
        invalidated.push({ ...prior, unit, reason: '该路段已被更正移出当前路径，原领取结果作废' });
      }
    }
  }
  // 本次没有追查的托盘，原领取结果原样保留，不能因一次局部追查而作废。
  for (const [key, prior] of priorClaims ?? []) {
    if (!next.has(key) && !wanted.has(prior.unit)) next.set(key, prior);
  }
  return { reused, reacquired, invalidated, claims: next };
}

export { unitSignature };
