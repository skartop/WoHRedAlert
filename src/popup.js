const $ = (id) => document.getElementById(id);
const BUILD = 'main-scan-0.1.1';
let lastTestLine = '';

async function getSettings() {
  return chrome.runtime.sendMessage({ type: 'WOH_GET_SETTINGS' });
}

async function saveSettings(payload) {
  return chrome.runtime.sendMessage({ type: 'WOH_SAVE_SETTINGS', payload });
}

async function getActiveTabStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    await chrome.runtime.sendMessage({ type: 'WOH_SCAN_TAB', tabId: tab.id });
    return await chrome.runtime.sendMessage({ type: 'WOH_GET_TAB_STATUS', tabId: tab.id });
  } catch {
    return null;
  }
}

async function load() {
  const s = await getSettings();
  $('enabled').checked = !!s.enabled;
  $('pollMs').value = s.pollMs || 5000;
  $('cooldown').value = s.alertCooldownMs || 120000;
  $('tgToken').value = s.telegramBotToken || '';
  $('tgChat').value = s.telegramChatId || '';
  $('dcWebhook').value = s.discordWebhookUrl || '';
  await refreshStatus();
}

async function refreshStatus() {
  const p = await getActiveTabStatus();
  const lastSeen = p?.lastSeenTs ? new Date(p.lastSeenTs).toLocaleTimeString() : 'n/a';
  const mainScan = p?.mainScan
    ? `\nMain scan: ${p.mainScan.ok ? 'ok' : 'err'} wofh=${!!p.mainScan.hasWofh} towns=${p.mainScan.townCount || 0} alerts=${p.mainScan.alerts || 0} sent=${p.mainScan.sent || 0}${p.mainScan.error ? `\nMain scan err: ${p.mainScan.error}` : ''}`
    : '';
  const body = p
    ? `Build: ${BUILD}\nStatus: ${p.status || (p.running ? 'running' : 'stopped')}\nChecks: ${p.checks || 0}\nTowns: ${p.towns || 0}\nHas wofh: ${!!p.hasWofh}\nLast seen: ${lastSeen}\nFrame: ${p.isTop ? 'top' : 'child'}\nURL: ${(p.frameHref || '').slice(0, 90)}${mainScan}`
    : `Build: ${BUILD}\nStatus: open a Ways of History game tab`;
  $('status').textContent = (lastTestLine ? `${lastTestLine}\n` : '') + body;
}

$('save').addEventListener('click', async () => {
  const payload = {
    enabled: $('enabled').checked,
    pollMs: Number($('pollMs').value || 5000),
    alertCooldownMs: Number($('cooldown').value || 120000),
    telegramBotToken: $('tgToken').value.trim(),
    telegramChatId: $('tgChat').value.trim(),
    discordWebhookUrl: $('dcWebhook').value.trim()
  };
  await saveSettings(payload);
  await refreshStatus();
});

$('refresh').addEventListener('click', refreshStatus);
$('testAlert').addEventListener('click', async () => {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'WOH_TEST_ALERT' });
    const n = r?.result?.notification;
    if (n?.ok) {
      lastTestLine = `Test alert: SENT (id: ${n.id})`;
    } else {
      lastTestLine = `Test alert failed: ${n?.error || 'unknown'}`;
    }
    await refreshStatus();
  } catch (e) {
    lastTestLine = `Test alert exception: ${String(e)}`;
    await refreshStatus();
  }
});

load();
setInterval(refreshStatus, 5000);
