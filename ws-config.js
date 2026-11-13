const WS_CONFIG = {
  assetsUrl: 'https://sg.bicoin.com.cn/98h/sp/alphaBalance',

  buildUrl(number) {
    return `wss://sg.bicoin.com.cn/98a/weborder/BINANCEALPHA-${number}`;
  },

  async load() {
    const stored = await chrome.storage.local.get(['browserNumber', 'wsUrl']);
    const freshInstall = !stored.browserNumber && !stored.wsUrl;
    const legacyOne = String(stored.browserNumber) === '1' &&
        (!stored.wsUrl || stored.wsUrl === 'wss://sg.bicoin.com.cn/98c/weborder/BINANCEALPHA-1');
    if (freshInstall || legacyOne) {
      const updated = { browserNumber: '23', wsUrl: this.buildUrl('23') };
      await chrome.storage.local.set(updated);
      Object.assign(stored, updated);
    }
    return stored;
  }
};
