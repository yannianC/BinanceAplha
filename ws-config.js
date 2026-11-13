const WS_CONFIG = {
  assetsUrl: 'https://sg.bicoin.com.cn/98h/sp/alphaBalance',

  buildUrl(number) {
    return `wss://sg.bicoin.com.cn/98a/weborder/BINANCEALPHA-${number}`;
  },

  async load() {
    const stored = await chrome.storage.local.get(['browserNumber', 'wsUrl']);
    return stored;
  }
};
