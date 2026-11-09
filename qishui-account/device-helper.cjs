'use strict';
// Prepares only plugin-owned device components. No browser is launched.
const readline = require('node:readline');
const { prepareSdk } = require('./native-sdk.cjs');
const { ensureDevice } = require('./device.cjs');
const { deviceName, scanLabel } = require('./local-env.cjs');
const controller = new AbortController();
const input = readline.createInterface({ input: process.stdin });
let started = false, cancelled = false;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
input.once('line', async line => {
  if (started) return; started = true;
  try {
    if (line.length > 262144) throw new Error('invalid');
    const message = JSON.parse(line);
    if (message.type !== 'start') throw new Error('invalid');
    await prepareSdk({ dataDir: message.dataDir, signal: controller.signal, onProgress: text => { if (!cancelled) emit({ type: 'progress', text }); } });
    if (cancelled) return;
    const device = await ensureDevice(message.device);
    if (!cancelled) emit({ type: 'device', device, computerName: deviceName(), osLabel: scanLabel() });
  } catch (error) {
    if (!cancelled) emit({ type: 'error', code: error.code === 'setup' ? 'setup' : 'device', description: error.code === 'setup' || error.code === 'QISHUI_DEVICE' ? error.message : '无法初始化汽水设备，请检查网络后重试。' });
    process.exitCode = 1;
  }
});
input.on('close', () => { cancelled = true; controller.abort(); });
