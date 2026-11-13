const WS_CONFIG = {
  assetsUrl: 'https://sg.bicoin.com.cn/98h/sp/alphaBalance',

  // Full instance identifies the socket; the prefix identifies the shared account.
  parseNumber(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{1,12})(?:-(\d{1,12}))?$/.exec(value);
    return match && match[0] === value ? { instance: value, account: match[1] } : null;
  },

  accountName(stored) {
    const number = stored.browserNumber
      ? String(stored.browserNumber)
      : /\/BINANCEALPHA-([^/?#]+)$/.exec(stored.wsUrl || '')?.[1];
    return this.parseNumber(number)?.account || '';
  },

  buildUrl(number) {
    if (!this.parseNumber(number)) throw Error('实例编号格式：23 或 23-1，每段1至12位数字');
    return `wss://sg.bicoin.com.cn/98a/weborder/BINANCEALPHA-${number}`;
  },

  async load() {
    const stored = await chrome.storage.local.get(['browserNumber', 'wsUrl']);
    return stored;
  }
};
