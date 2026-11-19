// 把三处演练系统的原始资料整理成可推理的“现场图”：
// 扫码事件（含站端校时凭证）、换装动作（含修订历史）、收货台签收。
// 这里只做归一化，不补造任何时间、读数或归属。

import { tryParseTime } from './time.mjs';

export function normalizeClocks(raw) {
  const clocks = new Map();
  for (const clock of Array.isArray(raw) ? raw : []) {
    if (!clock || typeof clock.id !== 'string') continue;
    const offset = Number(clock.offsetSeconds);
    const uncertainty = Number(clock.uncertaintySeconds);
    if (!Number.isFinite(offset) || !Number.isFinite(uncertainty) || uncertainty < 0) {
      clocks.set(clock.id, { id: clock.id, usable: false, reason: '校时凭证不完整' });
      continue;
    }
    clocks.set(clock.id, { id: clock.id, offsetSeconds: offset, uncertaintySeconds: uncertainty, usable: true });
  }
  return clocks;
}

// 校时：秒差加到设备时刻，误差范围落在结果两侧。结果保留成闭区间，
// 只在“一个区间的上界早于另一个的下界”时才认定先后顺序。
export function correctScan(observed, clock) {
  if (observed === null) return { corrected: null, issue: '设备时刻无法解析' };
  if (!clock) return { corrected: null, issue: '缺少站端校时凭证' };
  if (!clock.usable) return { corrected: null, issue: clock.reason };
  const center = observed + clock.offsetSeconds;
  return {
    corrected: {
      low: center - clock.uncertaintySeconds,
      high: center + clock.uncertaintySeconds,
      center,
      uncertaintySeconds: clock.uncertaintySeconds,
    },
    issue: null,
  };
}

export function compareIntervals(left, right) {
  if (left.high < right.low) return 'before';
  if (right.high < left.low) return 'after';
  return 'overlap';
}

export function normalizeScans(raw, clocks) {
  const seen = new Map();
  const events = [];
  const anomalies = [];
  for (const scan of Array.isArray(raw) ? raw : []) {
    if (!scan || typeof scan.origin !== 'string' || typeof scan.scanId !== 'string') continue;
    const identity = [scan.origin, scan.scanId, scan.observed, scan.action, scan.seal].join('|');
    if (seen.has(identity)) continue; // 离线重传会带回旧扫描，同一事件只认一次
    seen.set(identity, scan);
    const observed = tryParseTime(scan.observed);
    const clock = clocks.get(scan.clockProof) ?? null;
    const { corrected, issue } = correctScan(observed, clock);
    events.push({
      origin: scan.origin,
      scanId: scan.scanId,
      action: scan.action ?? null,
      seal: scan.seal ?? null,
      observed: scan.observed,
      observedSeconds: observed,
      clockProof: scan.clockProof ?? null,
      clock: clock ? { ...clock } : null,
      corrected,
      issue,
      source: 'scanner/events',
    });
    if (issue) {
      anomalies.push({ kind: 'scan-without-proof', origin: scan.origin, scanId: scan.scanId, detail: issue });
    }
  }
  // 同一站、同一扫码编号却出现不同内容：无法判定哪条才是原件。
  const byId = new Map();
  for (const event of events) {
    const id = event.origin + '|' + event.scanId;
    const group = byId.get(id) ?? [];
    group.push(event);
    byId.set(id, group);
  }
  for (const [id, group] of byId) {
    if (group.length > 1) {
      for (const event of group) event.conflictGroup = id;
      anomalies.push({ kind: 'scan-id-conflict', id, detail: '同一扫码编号存在不同的原始内容，经过顺序待认定' });
    }
  }
  return { events, anomalies };
}

export function buildPacking(raw) {
  const history = new Map();
  const conflicts = [];
  for (const record of Array.isArray(raw) ? raw : []) {
    if (!record || typeof record.move !== 'string') continue;
    const revision = Number(record.revision);
    const normalized = {
      move: record.move,
      revision: Number.isFinite(revision) ? revision : 0,
      oldSeal: record.oldSeal ?? null,
      newSeal: record.newSeal ?? null,
      units: [...new Set(Array.isArray(record.units) ? record.units.filter(unit => typeof unit === 'string') : [])],
      bay: record.bay ?? null,
      exit: Array.isArray(record.exit) ? record.exit : null,
      enter: Array.isArray(record.enter) ? record.enter : null,
      source: 'dock/packing',
    };
    const list = history.get(record.move) ?? [];
    const same = list.find(entry => entry.revision === normalized.revision);
    if (same) {
      if (JSON.stringify({ ...same, source: undefined }) !== JSON.stringify({ ...normalized, source: undefined })) {
        conflicts.push({ kind: 'packing-revision-conflict', move: record.move, revision: normalized.revision });
      }
      continue;
    }
    list.push(normalized);
    history.set(record.move, list);
  }
  const latest = new Map();
  for (const [move, list] of history) {
    list.sort((left, right) => left.revision - right.revision);
    latest.set(move, list.at(-1));
  }
  return { latest, history, conflicts };
}

export function unitSignature(record, unit) {
  if (!record || !record.units.includes(unit)) return null;
  return JSON.stringify({
    move: record.move,
    unit,
    oldSeal: record.oldSeal,
    newSeal: record.newSeal,
    bay: record.bay,
    exit: record.exit,
    enter: record.enter,
  });
}

export function latestMovesForUnit(packing, unit) {
  const matches = [];
  for (const record of packing.latest.values()) {
    if (record.units.includes(unit)) matches.push(record);
  }
  return matches;
}

// 修订前后逐件货的路段差异。拆托、混拼、作废旧封签都会在这里显形。
export function packingChanges(previous, next) {
  const changes = [];
  const moves = new Set([...previous.history.keys(), ...next.history.keys()]);
  for (const move of moves) {
    const before = previous.latest.get(move) ?? null;
    const after = next.latest.get(move) ?? null;
    const units = new Set([...(before?.units ?? []), ...(after?.units ?? [])]);
    for (const unit of units) {
      const beforeSignature = before?.units.includes(unit) ? unitSignature(before, unit) : null;
      const afterSignature = after?.units.includes(unit) ? unitSignature(after, unit) : null;
      if (beforeSignature !== afterSignature) {
        changes.push({
          move,
          unit,
          fromRevision: before?.revision ?? null,
          toRevision: after?.revision ?? null,
          before: before && before.units.includes(unit) ? before : null,
          after: after && after.units.includes(unit) ? after : null,
          kind: !beforeSignature ? 'added' : !afterSignature ? 'removed' : 'reassigned',
        });
      }
    }
  }
  return changes;
}

export function normalizeAcceptances(raw) {
  const claims = [];
  const conflicts = [];
  const byClaim = new Map();
  for (const claim of Array.isArray(raw) ? raw : []) {
    if (!claim || typeof claim.desk !== 'string') continue;
    const units = Array.isArray(claim.units) ? claim.units.filter(unit => typeof unit === 'string') : [];
    const identity = [claim.desk, claim.sheet, claim.claimId].join('|');
    const prior = byClaim.get(identity);
    if (prior && JSON.stringify(prior.units) !== JSON.stringify(units)) {
      conflicts.push({ kind: 'acceptance-conflict', identity, detail: '同一签收编号的货件清单前后不一致' });
    }
    byClaim.set(identity, { ...claim, units });
    for (const unit of units) {
      claims.push({
        desk: claim.desk,
        sheet: claim.sheet ?? null,
        claimId: claim.claimId ?? null,
        arrival: claim.arrival ?? null,
        unit,
        source: 'receiver/acceptances',
      });
    }
  }
  return { claims, conflicts };
}
