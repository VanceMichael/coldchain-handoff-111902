// 冷链换装资料交换服务。
//
// 输入：
//   - 三处演练系统的原始资料（扫码事件与校时、换装动作、按窗口补领的温控记录）
//   - 收货台的签收与凭据
//   - 收货人的追查请求（到达批、货件、温区、各台拣货单）
// 输出：
//   - 按托盘的完整证据链、归属范围、当前处置
//   - 已发凭据的受影响件数、实际持有人、需要复验/召回/暂停的部分
//   - 更正后应沿用的已核实记录与需要按新路径补领的范围

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  normalizeClocks, normalizeScans, buildPacking, normalizeAcceptances,
} from './picture.mjs';
import {
  STATE, evaluateUnit, assessReceipt, reconcileClaims, blockerText,
} from './engine.mjs';
import { createSourceClient } from './client.mjs';
const MAX_BODY = 1024 * 1024;

class RequestError extends Error {
  constructor(status, message, detail = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function readJson(request) {
  let input = '';
  for await (const chunk of request) {
    input += chunk;
    if (input.length > MAX_BODY) throw new RequestError(413, '请求正文超出限制');
  }
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    throw new RequestError(400, '请求正文不是有效 JSON');
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateUnits(units, field) {
  if (!Array.isArray(units) || units.length === 0) {
    throw new RequestError(400, field + ' 应为非空货件清单');
  }
  for (const unit of units) {
    if (typeof unit !== 'string' || unit.trim() === '') {
      throw new RequestError(400, field + ' 含无效货件');
    }
  }
  return [...new Set(units)];
}

function validateBand(band) {
  if (!Array.isArray(band) || band.length !== 2) return [2, 8];
  const [low, high] = band.map(Number);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) {
    throw new RequestError(400, 'temperatureBandC 应为 [下限, 上限]');
  }
  return [low, high];
}

// 同一到货批的追查记录：用于对比更正前后哪些已核实结论还能沿用。
function createMemory() {
  return {
    clocks: [],
    clockConflicts: new Map(),
    scanEvents: [],
    packingRecords: [],
    loggerRecords: new Map(),
    acceptances: new Map(),
    acceptanceConflicts: [],
    receipts: new Map(),
    traces: new Map(),
    traceByArrival: new Map(),
  };
}

export function createService({ sourceUrl = null, fetchImpl = fetch } = {}) {
  const state = createMemory();
  const client = sourceUrl ? createSourceClient(sourceUrl, { fetchImpl }) : null;

  function picture() {
    const clocks = normalizeClocks(state.clocks);
    const scans = normalizeScans(state.scanEvents, clocks);
    const packing = buildPacking(state.packingRecords);
    return {
      clocks,
      scans,
      packing,
      conflicts: [
        ...scans.anomalies,
        ...packing.conflicts,
        ...state.acceptanceConflicts,
        ...state.clockConflicts.values(),
      ],
    };
  }

  function acceptances() {
    return [...state.acceptances.values()];
  }

  // 箱封/工位记录按窗口合并：补领只补一段，不能把先前覆盖抹掉。
  function recordsByKey() {
    const map = new Map();
    for (const [key, records] of state.loggerRecords) map.set(key, [...records]);
    return map;
  }

  function ingestScans(body) {
    const events = asArray(body.events ?? body.scans);
    const clocks = asArray(body.clocks);
    let clockAdded = 0;
    const clockConflicts = [];
    for (const clock of clocks) {
      const id = clock?.id;
      if (typeof id !== 'string') continue;
      const index = state.clocks.findIndex(existing => existing.id === id);
      if (index === -1) {
        state.clocks.push(clock);
        clockAdded += 1;
        continue;
      }
      const prior = state.clocks[index];
      if (prior.offsetSeconds !== clock.offsetSeconds ||
        prior.uncertaintySeconds !== clock.uncertaintySeconds) {
        // 同一校时凭证前后不一致：保留最新值用于取整，但必须让调用方看到
        const conflict = {
          kind: 'clock-conflict',
          id,
          before: { offsetSeconds: prior.offsetSeconds, uncertaintySeconds: prior.uncertaintySeconds },
          after: { offsetSeconds: clock.offsetSeconds, uncertaintySeconds: clock.uncertaintySeconds },
          detail: '同一站端校时凭证内容不一致，相关扫码顺序须复核',
        };
        clockConflicts.push(conflict);
        state.clockConflicts.set(id, conflict);
      }
      state.clocks[index] = clock;
    }
    const before = new Set(state.scanEvents.map(scan =>
      [scan.origin, scan.scanId, scan.observed, scan.action, scan.seal].join('|')));
    let added = 0;
    let duplicate = 0;
    for (const event of events) {
      if (!event || typeof event.origin !== 'string' || typeof event.scanId !== 'string') continue;
      const identity = [event.origin, event.scanId, event.observed, event.action, event.seal].join('|');
      if (before.has(identity)) {
        duplicate += 1;
        continue;
      }
      before.add(identity);
      state.scanEvents.push(event);
      added += 1;
    }
    const normalized = normalizeScans(state.scanEvents, normalizeClocks(state.clocks));
    return {
      accepted: added,
      duplicateIgnored: duplicate,
      clocks: clockAdded,
      anomalies: [...normalized.anomalies, ...clockConflicts],
    };
  }

  function ingestPacking(body) {
    const records = asArray(body.packing ?? body.moves ?? body);
    let added = 0;
    for (const record of records) {
      if (!record || typeof record.move !== 'string') continue;
      const same = state.packingRecords.find(existing =>
        existing.move === record.move && String(existing.revision) === String(record.revision));
      if (same) {
        // 修订号相同但内容不同：保留两条，由 buildPacking 报冲突，不静默覆盖
        if (JSON.stringify(same) === JSON.stringify(record)) continue;
        state.packingRecords.push(record);
        added += 1;
        continue;
      }
      state.packingRecords.push(record);
      added += 1;
    }
    const packing = buildPacking(state.packingRecords);
    return {
      accepted: added,
      revisions: [...packing.latest.values()].map(record => ({ move: record.move, revision: record.revision })),
      conflicts: packing.conflicts,
    };
  }

  function ingestLoggers(body) {
    const records = asArray(body.records ?? (body.key ? [body] : []));
    const accepted = [];
    for (const raw of records) {
      if (!raw || typeof raw !== 'object') continue;
      const key = raw.key ?? raw.seal ?? raw.workingBay;
      if (typeof key !== 'string' || !key) continue;
      const list = state.loggerRecords.get(key) ?? [];
      const next = {
        key,
        sensor: raw.sensor ?? null,
        seal: raw.seal ?? null,
        workingBay: raw.workingBay ?? null,
        mounted: raw.mounted ?? null,
        bands: asArray(raw.bands),
        covered: asArray(raw.covered),
        pending: asArray(raw.pending),
        unverified: asArray(raw.unverified),
        archived: raw.archived !== false,
        missing: Boolean(raw.missing),
        window: raw.window ?? (raw.from && raw.to ? { from: raw.from, to: raw.to } : null),
        source: raw.source ?? 'logger/windows',
      };
      const prior = list.findIndex(record =>
        JSON.stringify(record.covered) === JSON.stringify(next.covered) &&
        JSON.stringify(record.pending) === JSON.stringify(next.pending) &&
        JSON.stringify(record.bands) === JSON.stringify(next.bands));
      if (prior !== -1) list[prior] = next;
      else list.push(next);
      state.loggerRecords.set(key, list);
      accepted.push({ key, window: next.window, archived: next.archived });
    }
    return { accepted: accepted.length, records: accepted };
  }

  function ingestAcceptances(body) {
    const claims = normalizeAcceptances(asArray(body.acceptances ?? body.claims));
    let added = 0;
    const conflicts = [];
    for (const claim of claims.claims) {
      const identity = [claim.desk, claim.sheet, claim.claimId, claim.unit].join('|');
      if (state.acceptances.has(identity)) continue;
      state.acceptances.set(identity, claim);
      added += 1;
    }
    const byUnit = new Map();
    for (const claim of state.acceptances.values()) {
      const desks = byUnit.get(claim.unit) ?? new Set();
      desks.add(claim.desk);
      byUnit.set(claim.unit, desks);
    }
    for (const [unit, desks] of byUnit) {
      if (desks.size > 1) {
        conflicts.push({
          kind: 'acceptance-conflict',
          unit,
          desks: [...desks],
          detail: '多个收货台都记录了实际签收',
        });
      }
    }
    state.acceptanceConflicts = conflicts;
    return {
      accepted: added,
      claims: [...state.acceptances.values()],
      conflicts,
    };
  }

  function evaluate({ arrival, units, band, picklists }) {
    const snapshot = picture();
    const recs = recordsByKey();
    const ctx = {
      picture: snapshot,
      band,
      recordsByKey: recs,
      acceptances: acceptances(),
      receipts: [...state.receipts.values()],
      picklists,
      arrival,
    };
    return {
      snapshot,
      units: units.map(unit => evaluateUnit({ ...ctx, unit })),
    };
  }

  // 收货台的统一视角：每台按自己的拣货单看本单货件，同时标出别台已实际接手的部分。
  function receiversView(picklists, unitsView) {
    const byUnit = new Map(unitsView.map(unit => [unit.unit, unit]));
    const sheetsByUnit = new Map();
    for (const picklist of picklists) {
      for (const unit of picklist.units) {
        const list = sheetsByUnit.get(unit) ?? [];
        list.push({ desk: picklist.desk, sheet: picklist.sheet });
        sheetsByUnit.set(unit, list);
      }
    }
    return picklists.map(picklist => {
      const visible = picklist.units.map(unit => byUnit.get(unit)).filter(Boolean);
      const claimable = visible.filter(unit => unit.state === STATE.RELEASABLE && unit.custody.unclaimed)
        .map(unit => unit.unit);
      const held = visible.filter(unit => unit.state !== STATE.RELEASABLE)
        .map(unit => ({ unit: unit.unit, state: unit.state, disposition: unit.disposition.code }));
      const elsewhere = visible.filter(unit => unit.custody.acceptedBy.some(desk => desk !== picklist.desk))
        .map(unit => ({
          unit: unit.unit,
          heldBy: unit.custody.acceptedBy.filter(desk => desk !== picklist.desk),
        }));
      // 同一货件出现在多张拣货单上时，先到先得；后到的一台不能重复领取。
      const shared = picklist.units
        .filter(unit => (sheetsByUnit.get(unit) ?? []).length > 1)
        .map(unit => ({
          unit,
          alsoOn: sheetsByUnit.get(unit).filter(sheet => sheet.desk !== picklist.desk),
          alreadyAccepted: (byUnit.get(unit)?.custody.acceptedBy ?? []).length > 0,
        }));
      return {
        desk: picklist.desk,
        sheet: picklist.sheet,
        units: picklist.units,
        claimable,
        notClaimable: held,
        alreadyAcceptedElsewhere: elsewhere,
        sharedUnits: shared,
        conflicts: visible.filter(unit => unit.custody.conflict)
          .map(unit => unit.custody.conflict),
      };
    });
  }

  function trace(body) {
    const arrival = body.arrival;
    if (typeof arrival !== 'string' || !arrival) throw new RequestError(400, '缺少 arrival（到达批）');
    const units = validateUnits(body.units, 'units');
    const band = validateBand(body.temperatureBandC ?? [2, 8]);
    const picklists = asArray(body.receiverPicklists).map(picklist => ({
      desk: picklist.desk,
      sheet: picklist.sheet,
      units: asArray(picklist.units),
    }));
    const requestKey = typeof body.requestKey === 'string' && body.requestKey
      ? body.requestKey
      : 'Q-' + randomUUID().slice(0, 8);
    const signatureOfRequest = JSON.stringify({ arrival, units, band, picklists });
    if (state.traces.has(requestKey)) {
      const prior = state.traces.get(requestKey);
      if (prior.requestSignature !== signatureOfRequest) {
        throw new RequestError(409, '受理号对应不同的追查请求');
      }
      return { ...prior, state: '已受理（原请求）' };
    }

    const previous = state.traceByArrival.get(arrival) ?? null;
    const result = evaluate({ arrival, units, band, picklists });
    const receiptReports = [...state.receipts.values()]
      .filter(receipt => receipt.arrival === arrival)
      .map(receipt => assessReceipt({
        picture: result.snapshot,
        receipt,
        acceptances: acceptances(),
        band,
        recordsByKey: recordsByKey(),
      }));

    const reconciled = reconcileClaims({
      units,
      current: result.units.map(unit => ({ ...unit, recordsByKey: recordsByKey() })),
      priorClaims: previous?.claims ?? new Map(),
      priorSignatures: previous?.signatures ?? new Map(),
    });

    const unitsView = result.units.map(unit => ({
      unit: unit.unit,
      state: unit.state,
      disposition: unit.disposition,
      route: unit.route,
      evidence: unit.evidence,
      custody: unit.custody,
      inquiries: unit.inquiries,
      band: unit.band,
    }));

    const conflicts = [];
    for (const unit of result.units) {
      if (unit.custody.conflict) conflicts.push(unit.custody.conflict);
      for (const conflict of unit.evidence.conflicts) {
        conflicts.push({ unit: unit.unit, ...conflict });
      }
    }
    // 与具体托盘无关的原始资料异常（校时凭证前后不一致、修订号内容冲突等）也要让收货人看到
    const materialsConflicts = result.snapshot.conflicts.map(conflict => ({ scope: 'materials', ...conflict }));

    const signatures = new Map();
    for (const unit of result.units) signatures.set(unit.unit, unit.signature);
    const stored = {
      requestKey,
      requestSignature: signatureOfRequest,
      state: '已受理',
      arrival,
      band,
      picklists,
      units: unitsView,
      summary: summarize(unitsView),
      receivers: receiversView(picklists, unitsView),
      receipts: receiptReports,
      claims: {
        reused: reconciled.reused,
        reacquired: reconciled.reacquired,
        invalidated: reconciled.invalidated,
      },
      conflicts,
      materialsConflicts,
      materials: {
        scans: result.snapshot.scans.events.length,
        moves: result.snapshot.packing.latest.size,
        loggerKeys: [...state.loggerRecords.keys()],
        acceptances: acceptances().length,
      },
    };
    state.traces.set(requestKey, stored);
    state.traceByArrival.set(arrival, {
      claims: reconciled.claims,
      signatures,
      requestKey,
    });
    return stored;
  }

  function summarize(unitsView) {
    const byState = new Map();
    for (const unit of unitsView) {
      const list = byState.get(unit.state) ?? [];
      list.push(unit.unit);
      byState.set(unit.state, list);
    }
    return {
      total: unitsView.length,
      states: [...byState.entries()].map(([state, units]) => ({ state, units })),
      breach: unitsView.filter(unit => unit.state === STATE.BREACH).map(unit => unit.unit),
      missing: unitsView.filter(unit => unit.state === STATE.MISSING).map(unit => unit.unit),
      unknown: unitsView.filter(unit => unit.state === STATE.UNKNOWN).map(unit => unit.unit),
      releasable: unitsView.filter(unit => unit.state === STATE.RELEASABLE).map(unit => unit.unit),
      awaitingArchive: unitsView.filter(unit => unit.evidence.blockers.includes('awaiting-archive'))
        .map(unit => unit.unit),
      waitingArchiveOrBay: unitsView.filter(unit =>
        unit.evidence.blockers.includes('awaiting-archive') ||
        unit.evidence.blockers.includes('bay-unknown') ||
        unit.evidence.blockers.includes('order-uncertain'))
        .map(unit => ({
          unit: unit.unit,
          reason: unit.evidence.blockers.map(code => ({ code, text: blockerText(code) })),
        })),
      conflicts: unitsView.filter(unit => unit.custody.conflict).map(unit => unit.unit),
    };
  }

  function issueReceipt(body) {
    const { requestKey, desk, sheet, units, arrival, finding } = body;
    for (const [field, value] of Object.entries({ requestKey, desk, sheet, arrival, finding })) {
      if (typeof value !== 'string' || !value) throw new RequestError(400, '缺少 ' + field);
    }
    const unitList = validateUnits(units, 'units');
    if (state.receipts.has(requestKey)) {
      const existing = state.receipts.get(requestKey);
      if (JSON.stringify(existing.body) !== JSON.stringify(body)) {
        throw new RequestError(409, '经办号对应不同的提交');
      }
      return { state: '已受理（原凭据）', receipt: receiptView(existing) };
    }
    const snapshot = picture();
    const signatures = {};
    for (const unit of unitList) {
      const evaluation = evaluateUnit({
        picture: snapshot,
        unit,
        band: [2, 8],
        recordsByKey: recordsByKey(),
        acceptances: acceptances(),
        receipts: [],
        picklists: [],
        arrival,
      });
      signatures[unit] = evaluation.signature;
    }
    const receipt = {
      requestKey,
      desk,
      sheet,
      arrival,
      finding,
      units: unitList,
      signatures,
      state: '已受理',
      issuedAt: new Date().toISOString(),
      body,
    };
    state.receipts.set(requestKey, receipt);
    return { state: '已受理', receipt: receiptView(receipt) };
  }

  function receiptView(receipt) {
    return {
      requestKey: receipt.requestKey,
      desk: receipt.desk,
      sheet: receipt.sheet,
      arrival: receipt.arrival,
      finding: receipt.finding,
      units: receipt.units,
      state: receipt.state,
      issuedAt: receipt.issuedAt,
    };
  }

  async function collectLogger({ key, from, to }) {
    if (!client) throw new RequestError(503, '未配置演练来源，不能按窗口补领');
    if (!key || !from || !to) throw new RequestError(400, '按箱封或工位补领需提供 key、from、to');
    const record = await client.loggerWindow(key, from, to);
    const ingested = ingestLoggers({ records: [{ ...record, key: record.key ?? key, window: { from, to } }] });
    return {
      key,
      from,
      to,
      record,
      coverage: record.covered ?? [],
      pending: record.pending ?? [],
      unverified: record.unverified ?? [],
      ingested: ingested.records,
    };
  }

  async function collectAll() {
    if (!client) throw new RequestError(503, '未配置演练来源');
    const [events, clocks, packing, acceptancesRaw] = await Promise.all([
      client.scannerEvents(), client.scannerClocks(), client.dockPacking(), client.acceptances(),
    ]);
    return {
      scans: ingestScans({ events, clocks }),
      packing: ingestPacking({ packing }),
      acceptances: ingestAcceptances({ acceptances: acceptancesRaw }),
    };
  }

  function send(response, status, value) {
    const body = JSON.stringify(value, null, 2);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (request.method === 'GET' && path === '/health') {
        return send(response, 200, {
          ok: true,
          materials: {
            scans: state.scanEvents.length,
            moves: buildPacking(state.packingRecords).latest.size,
            loggerKeys: [...state.loggerRecords.keys()],
            acceptances: acceptances().length,
            receipts: state.receipts.size,
            traces: state.traces.size,
          },
        });
      }
      if (request.method === 'POST' && path === '/materials/scanner') {
        return send(response, 202, ingestScans(await readJson(request)));
      }
      if (request.method === 'POST' && path === '/materials/dock') {
        return send(response, 202, ingestPacking(await readJson(request)));
      }
      if (request.method === 'POST' && path === '/materials/logger') {
        return send(response, 202, ingestLoggers(await readJson(request)));
      }
      if (request.method === 'POST' && path === '/materials/receiver') {
        return send(response, 202, ingestAcceptances(await readJson(request)));
      }
      if (request.method === 'POST' && path === '/collect') {
        return send(response, 200, await collectAll());
      }
      if (request.method === 'POST' && path === '/collect/logger') {
        return send(response, 200, await collectLogger(await readJson(request)));
      }
      if (request.method === 'POST' && path === '/trace') {
        return send(response, 200, trace(await readJson(request)));
      }
      if (request.method === 'GET' && path.startsWith('/trace/')) {
        const requestKey = decodeURIComponent(path.slice('/trace/'.length));
        const found = state.traces.get(requestKey);
        if (!found) return send(response, 404, { error: '查无追查请求' });
        return send(response, 200, found);
      }
      if (request.method === 'POST' && path === '/receipts') {
        return send(response, 201, issueReceipt(await readJson(request)));
      }
      if (request.method === 'GET' && path === '/receipts') {
        const requestKey = url.searchParams.get('requestKey');
        const receipt = state.receipts.get(requestKey);
        if (!receipt) return send(response, 404, { error: '查无凭据' });
        return send(response, 200, { state: receipt.state, receipt: receiptView(receipt) });
      }
      if (request.method === 'GET' && path === '/') {
        return send(response, 200, {
          service: '冷链换装资料交换服务',
          endpoints: [
            'POST /materials/scanner', 'POST /materials/dock', 'POST /materials/logger',
            'POST /materials/receiver', 'POST /trace', 'GET /trace/:requestKey',
            'POST /receipts', 'GET /receipts?requestKey=', 'POST /collect', 'POST /collect/logger',
          ],
        });
      }
      return send(response, 404, { error: '查无此接口' });
    } catch (error) {
      if (error instanceof RequestError) {
        return send(response, error.status, { error: error.message, ...(error.detail ? { detail: error.detail } : {}) });
      }
      return send(response, 502, { error: '处理失败：' + error.message });
    }
  });

  return { server, state, trace, ingestScans, ingestPacking, ingestLoggers, ingestAcceptances, issueReceipt };
}

