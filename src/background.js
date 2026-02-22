const DEFAULTS = {
  enabled: true,
  pollMs: 5000,
  alertCooldownMs: 120000,
  telegramBotToken: "",
  telegramChatId: "",
  discordWebhookUrl: ""
};

const frameStateByTab = new Map(); // tabId -> Map(frameId -> status)
const alertSentAtByKey = new Map();
const alertSeenOnceKeys = new Set();
const lastMainScanByTab = new Map();

async function getSettings() {
  const obj = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...obj };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

function canSendAlertKey(key, cooldownMs) {
  if (alertSeenOnceKeys.has(key)) return false;
  const now = Date.now();
  const last = alertSentAtByKey.get(key) || 0;
  if (now - last < (cooldownMs || DEFAULTS.alertCooldownMs)) return false;
  alertSentAtByKey.set(key, now);
  alertSeenOnceKeys.add(key);
  return true;
}

function setFrameState(tabId, frameId, status) {
  if (tabId == null || frameId == null) return;
  if (!frameStateByTab.has(tabId)) frameStateByTab.set(tabId, new Map());
  const prev = frameStateByTab.get(tabId).get(frameId) || {};
  frameStateByTab.get(tabId).set(frameId, { ...prev, ...status, ts: Date.now() });
}

function pickBestFrameStatus(tabId) {
  const m = frameStateByTab.get(tabId);
  if (!m || m.size === 0) return null;
  const all = [...m.values()];

  const withTowns = all.filter(s => s?.hasTowns && s?.townCount > 0);
  if (withTowns.length > 0) return withTowns.sort((a, b) => b.townCount - a.townCount)[0];

  const withWofh = all.filter(s => s?.hasWofh);
  if (withWofh.length > 0) return withWofh[0];

  const top = all.find(s => s?.isTop);
  return top || all[0];
}

chrome.tabs.onRemoved.addListener((tabId) => frameStateByTab.delete(tabId));

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULTS, ...current });
});

async function createChromeNotification(title, message) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title,
        message
      }, (id) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message || String(err) });
        else resolve({ ok: true, id });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

async function dispatchAlert(msg = {}) {
  const s = await getSettings();
  const title = msg.title || 'WoH Alert';
  const detail = msg.detail || '';

  const result = {
    notification: await createChromeNotification(title, detail.slice(0, 250) || 'Event detected.'),
    telegram: null,
    discord: null
  };

  if (s.telegramBotToken && s.telegramChatId) {
    const text = `${msg.emoji || '⚔️'} <b>${title}</b>\n${detail}\n🕐 ${new Date().toLocaleString()}`;
    try {
      const ok = await postJson(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, {
        chat_id: s.telegramChatId,
        text,
        parse_mode: 'HTML'
      });
      result.telegram = { ok };
    } catch (e) {
      result.telegram = { ok: false, error: String(e) };
    }
  }

  if (s.discordWebhookUrl) {
    try {
      const ok = await postJson(s.discordWebhookUrl, {
        content: `${msg.emoji || '⚔️'} **${title}**\n${detail}\n🕐 ${new Date().toLocaleString()}`
      });
      result.discord = { ok };
    } catch (e) {
      result.discord = { ok: false, error: String(e) };
    }
  }

  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'WOH_ALERT') {
      await dispatchAlert(msg);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'WOH_TEST_ALERT') {
      const testMsg = {
        emoji: '✅',
        title: 'WoH Test Alert',
        detail: `Pipeline check from extension popup (${new Date().toLocaleTimeString()})`
      };
      const result = await dispatchAlert(testMsg);
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === 'WOH_MAIN_SCAN') {
      const tabId = sender?.tab?.id;
      const frameId = sender?.frameId;
      if (tabId == null || frameId == null) {
        sendResponse({ ok: false, error: 'missing tab/frame' });
        return;
      }

      let entries = [];
      try {
        entries = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'MAIN',
          func: () => {
            const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
            const toTown = (v) => {
              if (v == null) return '';
              if (typeof v === 'object') return String(v.id ?? v.townId ?? v.town ?? '');
              return String(v);
            };
            const pickTown = (obj, keys) => {
              for (const k of keys) {
                const id = toTown(obj?.[k]);
                if (id) return id;
              }
              return '';
            };

            const W = window.wofh;
            if (!W) return { hasWofh: false, townCount: 0, alerts: [] };

            const myTownIds = new Set(Object.keys(W.towns || {}).map(String));
            const alerts = [];
            const seenKeys = new Set();
            const pushAlert = (key, title, detail) => {
              if (seenKeys.has(key)) return;
              seenKeys.add(key);
              alerts.push({ key, emoji: '🚨', title, detail });
            };

            const readEtaRaw = (e) =>
              e?.arrive ?? e?.arrival ?? e?.arrivalTime ?? e?.time ?? e?.end ?? e?.eta ??
              e?.data?.arrive ?? e?.data?.arrival ?? e?.data?.arrivalTime ?? e?.data?.time ?? e?.data?.end ?? e?.data?.eta;

            const readSpeedRaw = (e) =>
              e?.speed ?? e?.spd ?? e?.velocity ?? e?.v ??
              e?.data?.speed ?? e?.data?.spd ?? e?.data?.velocity ?? e?.data?.v;

            const etaToMs = (v) => {
              if (v == null || v === '') return null;
              const n = Number(v);
              if (!Number.isFinite(n)) return null;
              if (n > 1e12) return n;      // already ms
              if (n > 1e9) return n * 1000; // epoch sec
              return null;
            };

            const fmtCountdown = (etaMs) => {
              if (!etaMs) return 'unknown';
              const delta = Math.max(0, Math.floor((etaMs - Date.now()) / 1000));
              const h = Math.floor(delta / 3600);
              const m = Math.floor((delta % 3600) / 60);
              const s = delta % 60;
              return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            };

            const townNameById = (() => {
              const map = new Map();
              const add = (id, name) => {
                const k = toTown(id);
                if (!k || !name) return;
                if (!map.has(k)) map.set(k, String(name));
              };
              for (const t of Object.values(W.towns || {})) add(t?.id, t?.name || t?.n);
              for (const t of Object.values(W.map?.towns || {})) add(t?.id, t?.name || t?.n);
              for (const t of Object.values(W.world?.towns || {})) add(t?.id, t?.name || t?.n);
              return map;
            })();

            const labelTown = (id) => {
              if (!id) return '?';
              const name = townNameById.get(String(id));
              return name ? `${name} (${id})` : String(id);
            };

            const scanIncomingFleets = (list) => {
              for (const e of asArray(list)) {
                if (!e || typeof e !== 'object') continue;
                const src = pickTown(e, ['t1', 'town1', 'src', 'source', 'from', 'fromTown', 'town2']) || pickTown(e?.data || {}, ['t1', 'town1', 'src', 'source', 'from', 'fromTown', 'town2']);
                const dest = pickTown(e, ['t2', 'town2', 'dest', 'destination', 'to', 'toTown', 'town', 'townId']) || pickTown(e?.data || {}, ['t2', 'town2', 'dest', 'destination', 'to', 'toTown', 'town', 'townId']);
                const atMyTown = !!dest && myTownIds.has(dest);
                const fromMyTown = !!src && myTownIds.has(src);
                if (!(atMyTown && !fromMyTown)) continue;

                // Noise filter: ignore synthetic/unknown origin town id 0.
                if (String(src) === '0') continue;

                const etaRaw = readEtaRaw(e);
                const etaMs = etaToMs(etaRaw);
                const etaText = etaMs ? new Date(etaMs).toLocaleString() : 'unknown';
                const cd = fmtCountdown(etaMs);
                const speedRaw = readSpeedRaw(e);
                const speedText = speedRaw == null || speedRaw === '' ? 'unknown' : String(speedRaw);
                const typeText = String(e?.type ?? e?.kind ?? e?.name ?? e?.title ?? e?.data?.type ?? 'movement');

                // Filter non-military movements (merchant/trade/transport).
                const blob = JSON.stringify(e).toLowerCase();
                const merchantLike = /(merchant|trade|trader|market|caravan|transport|shipment|resource)/i.test(blob + ' ' + typeText);
                const typeNum = Number(typeText);
                const knownNonCombatType = Number.isFinite(typeNum) && [102, 108, 201].includes(typeNum);
                // Type-level hard block for known non-combat movements.
                if (knownNonCombatType) continue;
                const hasArmySignal = /(army|troop|unit|soldier|infantry|cavalry|archer|siege)/i.test(blob);
                if (merchantLike && !hasArmySignal) continue;

                // Deduplicate same incoming shown in multiple sources/lists.
                const dedupe = `main:fleet:${src || '?'}:${dest}:${etaMs || 'na'}`;
                pushAlert(
                  dedupe,
                  'Incoming fleet',
                  `${labelTown(src)} -> ${labelTown(dest)} | ETA: ${etaText} (T-${cd}) | Speed: ${speedText} | Type: ${typeText}`
                );
              }
            };

            const scanBattles = (list) => {
              for (const b of asArray(list)) {
                if (!b || typeof b !== 'object') continue;
                const townId = pickTown(b, ['town', 'townId', 't1', 'to', 'dest']) || pickTown(b?.data || {}, ['town', 'townId']);
                if (!townId || !myTownIds.has(townId)) continue;
                const id = String(b.id ?? b.battleId ?? `${townId}:${b.time ?? 'battle'}`);
                if (!id) continue;
                pushAlert(`main:battle:${id}`, 'Battle at your town', `Battle #${id} at town ${townId}`);
              }
            };

            scanIncomingFleets(W.fleets?.list);
            scanIncomingFleets(W.events?.list);
            scanIncomingFleets(W.movements?.list);
            scanIncomingFleets(W.units?.movements);
            scanBattles(W.battles?.list);

            // UI fallback disabled due to false positives.

            return { hasWofh: true, townCount: myTownIds.size, alerts };
          }
        });
      } catch (e) {
        const err = String(e);
        lastMainScanByTab.set(tabId, { ok: false, error: err, ts: Date.now() });
        sendResponse({ ok: false, error: err });
        return;
      }

      const scan = entries?.[0]?.result || { hasWofh: false, townCount: 0, alerts: [] };
      const s = await getSettings();
      let sent = 0;
      for (const a of (scan.alerts || [])) {
        if (!canSendAlertKey(a.key, s.alertCooldownMs)) continue;
        await dispatchAlert(a);
        sent += 1;
      }

      const info = { ok: true, hasWofh: !!scan.hasWofh, townCount: scan.townCount || 0, alerts: (scan.alerts || []).length, sent, ts: Date.now() };
      lastMainScanByTab.set(tabId, info);
      sendResponse(info);
      return;
    }

    if (msg?.type === 'WOH_GET_SETTINGS') {
      sendResponse(await getSettings());
      return;
    }

    if (msg?.type === 'WOH_SAVE_SETTINGS') {
      const patch = msg.payload || {};
      await chrome.storage.sync.set(patch);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'WOH_FRAME_STATUS') {
      setFrameState(sender?.tab?.id, sender?.frameId, msg.payload || {});
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'WOH_GET_TAB_STATUS') {
      const tabId = msg.tabId;
      const best = pickBestFrameStatus(tabId);
      if (!best) {
        sendResponse({ ok: true, status: 'NO_FRAME_DATA', running: false, checks: 0, towns: 0 });
        return;
      }

      const statusLabel = best.hasTowns
        ? 'WORLD_READY'
        : best.hasWofh
          ? 'WAITING_FOR_TOWNS'
          : 'WAITING_FOR_WORLD_FRAME';

      sendResponse({
        ok: true,
        status: statusLabel,
        running: !!best.running,
        checks: best.checks || 0,
        towns: best.townCount || 0,
        hasWofh: !!best.hasWofh,
        frameHref: best.href || '',
        isTop: !!best.isTop,
        lastSeenTs: best.ts || null,
        mainScan: lastMainScanByTab.get(tabId) || null
      });
      return;
    }

    if (msg?.type === 'WOH_SCAN_TAB') {
      const tabId = msg.tabId;
      let entries = [];
      try {
        entries = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          func: () => ({
            href: location.href,
            isTop: window.top === window,
            hasWofh: typeof window.wofh !== 'undefined',
            townCount: (typeof window.wofh !== 'undefined' && window.wofh?.towns) ? Object.keys(window.wofh.towns).length : 0
          })
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
        return;
      }

      const frames = entries.map(e => ({
        frameId: e.frameId,
        href: e.result?.href || '',
        isTop: !!e.result?.isTop,
        hasWofh: !!e.result?.hasWofh,
        townCount: e.result?.townCount || 0
      }));

      const tabMap = frameStateByTab.get(tabId) || new Map();
      for (const f of frames) {
        const prev = tabMap.get(f.frameId) || {};
        const nextChecks = f.hasWofh ? ((prev.checks || 0) + 1) : (prev.checks || 0);
        setFrameState(tabId, f.frameId, {
          running: true,
          checks: nextChecks,
          hasWofh: f.hasWofh,
          hasTowns: f.townCount > 0,
          townCount: f.townCount,
          href: f.href,
          isTop: f.isTop
        });
      }

      const best = pickBestFrameStatus(tabId);
      const status = !best ? 'NO_FRAME_DATA' : (best.hasTowns ? 'WORLD_READY' : best.hasWofh ? 'WAITING_FOR_TOWNS' : 'WAITING_FOR_WORLD_FRAME');
      sendResponse({ ok: true, status, best, frames });
      return;
    }
  })();

  return true;
});
