// 三处演练系统的只读取数客户端。来源是合成演练资料，全部在本机回环地址。
// 取数失败不伪造资料：调用方拿到错误后应把范围标成“尚缺/待补”，而不是“无记录”。

export class SourceError extends Error {
  constructor(message, { status = null, path = null, body = null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export function createSourceClient(baseUrl, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function getJson(path, { retries = 2 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(base + path, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        const text = await response.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        if (!response.ok) {
          throw new SourceError('来源接口返回 ' + response.status + '：' + path, {
            status: response.status, path, body,
          });
        }
        return body;
      } catch (error) {
        lastError = error instanceof SourceError
          ? error
          : new SourceError('来源接口不可用：' + path, { path, body: String(error.message || error) });
        if (lastError.status && lastError.status < 500) throw lastError;
        if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  return {
    base,
    getJson,
    async scannerEvents() {
      const value = await getJson('/scanner/events');
      return Array.isArray(value) ? value : [];
    },
    async scannerClocks() {
      const value = await getJson('/scanner/clocks');
      return Array.isArray(value) ? value : [];
    },
    async dockPacking() {
      const value = await getJson('/dock/packing');
      return Array.isArray(value) ? value : [];
    },
    async loggerWindow(key, from, to, { retries = 1 } = {}) {
      const query = new URLSearchParams({ key, from, to });
      return getJson('/logger/windows?' + query, { retries });
    },
    async acceptances() {
      const value = await getJson('/receiver/acceptances');
      return Array.isArray(value) ? value : [];
    },
    async postReceipt(body) {
      const response = await fetchImpl(base + '/receiver/receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let value = null;
      try {
        value = text ? JSON.parse(text) : null;
      } catch {
        value = text;
      }
      if (!response.ok) {
        throw new SourceError('回执站返回 ' + response.status, { status: response.status, path: '/receiver/receipts', body: value });
      }
      return value;
    },
    async receipt(requestKey) {
      const query = new URLSearchParams({ requestKey });
      return getJson('/receiver/receipts?' + query);
    },
  };
}
