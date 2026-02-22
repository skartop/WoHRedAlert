(() => {
  if (window.__WOH_EXTENSION_MONITOR__) return;

  const state = {
    running: false,
    checks: 0,
    myTownIds: new Set(),
    knownFleetIds: new Set(),
    knownBattleIds: new Set(),
    knownEventIds: new Set(),
    cooldown: new Map(),
    timer: null,
    reportTimer: null,
    cfg: { enabled: true, pollMs: 5000, alertCooldownMs: 120000 },
    domIncomingSig: ''
  };

  const now = () => Date.now();
  const asArray = (list) => (Array.isArray(list) ? list : Object.values(list || {}));

  function hasWofh() {
    return typeof window.wofh !== 'undefined';
  }

  function toTownId(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
      const nested = v.id ?? v.townId ?? v.town ?? v.t;
      return nested == null ? '' : String(nested);
    }
    return String(v);
  }

  function pickTownId(obj, keys) {
    for (const k of keys) {
      const val = obj?.[k];
      const id = toTownId(val);
      if (id) return id;
    }
    return '';
  }

  function getFleetMeta(fleet = {}) {
    const src = pickTownId(fleet, ['t1', 'town1', 'src', 'source', 'from', 'fromTown', 'town2']);
    const dest = pickTownId(fleet, ['t2', 'town2', 'dest', 'destination', 'to', 'toTown', 'town']);
    const id = String(
      fleet.id ?? fleet.fleetId ?? fleet.uuid ?? `${src}->${dest}:${fleet.arrive ?? fleet.time ?? fleet.end ?? ''}`
    );
    return { id, src, dest };
  }

  function getEventMeta(evt = {}) {
    const townId = pickTownId(evt, ['town', 'townId', 't1', 'to', 'dest', 'destination']) ||
      pickTownId(evt?.data || {}, ['town', 'townId', 't1', 'to', 'dest', 'destination']);

    const src = pickTownId(evt, ['town2', 'from', 'src', 'source', 't2']) ||
      pickTownId(evt?.data || {}, ['town2', 'from', 'src', 'source', 't2']);

    const id = String(
      evt.id ?? evt.eventId ?? evt.uuid ?? `${townId}<-${src}:${evt.type ?? evt.kind ?? evt.time ?? ''}`
    );

    const typeText = String(evt.type ?? evt.kind ?? evt.name ?? evt.title ?? '').toLowerCase();
    const hasArmyData = !!(evt?.data?.army || evt?.army || evt?.data?.troops || evt?.troops || evt?.data?.units || evt?.units);
    const hostileType = /(attack|raid|assault|battle|invad|hostile|army|troop|siege)/i.test(typeText);

    return { id, townId, src, hasArmyData, hostileType, typeText };
  }

  function reportFrameStatus() {
    const has = hasWofh();
    const townCount = has && wofh?.towns ? Object.keys(wofh.towns).length : 0;

    try {
      chrome.runtime.sendMessage({
        type: 'WOH_FRAME_STATUS',
        payload: {
          running: state.running,
          checks: state.checks,
          hasWofh: has,
          hasTowns: townCount > 0,
          townCount,
          href: location.href,
          isTop: window.top === window
        }
      }, () => void chrome.runtime.lastError);
    } catch {
      // Happens when extension reload invalidates old content-script context.
      // Avoid noisy uncaught errors; fresh script instance will take over.
    }
  }

  function canAlert(key) {
    const last = state.cooldown.get(key) || 0;
    return now() - last >= (state.cfg.alertCooldownMs || 120000);
  }

  function markAlert(key) {
    state.cooldown.set(key, now());
  }

  function sendAlert(key, emoji, title, detail) {
    if (!canAlert(key)) return;
    markAlert(key);
    chrome.runtime.sendMessage({ type: 'WOH_ALERT', key, emoji, title, detail }, () => void chrome.runtime.lastError);
    console.log('[WOH EXT ALERT]', emoji, title, detail);
  }

  function detectMyTowns() {
    if (!hasWofh() || !wofh.towns) return false;
    state.myTownIds = new Set(Object.keys(wofh.towns || {}).map(String));
    return state.myTownIds.size > 0;
  }

  function checkFleets() {
    const fleets = asArray(wofh?.fleets?.list);
    for (const fleet of fleets) {
      if (!fleet) continue;
      const { id, src, dest } = getFleetMeta(fleet);
      if (!id) continue;
      if (state.knownFleetIds.has(id)) continue;

      const isIncoming = !!dest && state.myTownIds.has(dest);
      const isMine = !!src && state.myTownIds.has(src);
      if (!(isIncoming && !isMine)) continue;

      state.knownFleetIds.add(id);
      const etaTs = fleet.arrive ?? fleet.time ?? fleet.end;
      const eta = etaTs ? new Date(Number(etaTs) * 1000).toLocaleString() : 'unknown';
      sendAlert(`fleet:${id}`, '🚨', 'Incoming fleet', `Fleet #${id} ${src || '?'} -> ${dest || '?'}\nETA: ${eta}`);
    }
  }

  function checkBattles() {
    const battles = asArray(wofh?.battles?.list);
    for (const b of battles) {
      if (!b) continue;
      const bid = String(b.id ?? b.battleId ?? b.uuid ?? '');
      if (!bid) continue;
      if (state.knownBattleIds.has(bid)) continue;
      state.knownBattleIds.add(bid);
      const townId = pickTownId(b, ['town', 'townId', 't1', 'to', 'dest']) || '?';
      const mine = state.myTownIds.has(townId);
      sendAlert(`battle:${bid}`, '⚔️', mine ? 'Battle at your town' : 'Battle detected', `Battle #${bid} at town ${townId}`);
    }
  }

  function checkEventsList(list, sourceLabel = 'events') {
    const events = asArray(list);
    for (const e of events) {
      if (!e) continue;
      const { id, townId, src, hasArmyData, hostileType, typeText } = getEventMeta(e);
      if (!id || state.knownEventIds.has(id)) continue;

      // Noise control: event-level movement alerts disabled.
      // Keep only Incoming fleet + Battle at your town.
      void hasArmyData; void hostileType; void sourceLabel; void typeText;
      void townId; void src;
      state.knownEventIds.add(id);
    }
  }

  function checkEvents() {
    checkEventsList(wofh?.events?.list, 'events');
    checkEventsList(wofh?.movements?.list, 'movements');
    checkEventsList(wofh?.units?.movements, 'units.movements');
  }

  function checkBuildQueue() {
    const towns = wofh?.towns;
    if (!towns) return;
    for (const [id, t] of Object.entries(towns)) {
      if (!Array.isArray(t?.buildQueue)) continue;
      if (t.buildQueue.length === 0) {
        const name = t.name || t.n || `Town ${id}`;
        sendAlert(`build:empty:${id}`, '🏗️', 'Build queue empty', `${name} (${id}) has no active construction.`);
      }
    }
  }

  function checkDomIncomingFallback() {
    const txt = (document.body?.innerText || '').replace(/\s+/g, ' ');
    if (!txt) return;

    const m = txt.match(/\bx\s*(\d+)\s+(\d{1,2}:\d{2}:\d{2})\b/i);
    if (!m) return;

    const count = Number(m[1] || 0);
    const eta = m[2] || '';
    if (!count || count <= 0) return;

    const sig = `${count}|${location.href}`;
    if (state.domIncomingSig === sig) return;
    state.domIncomingSig = sig;

    sendAlert(
      `dom:incoming:${sig}`,
      '🚨',
      'Incoming attack (DOM fallback)',
      `Detected incoming marker x${count} ETA ${eta} on ${location.href}`
    );
  }

  function tick() {
    if (!state.running) {
      reportFrameStatus();
      return;
    }

    // UI fallback disabled due to false positives.

    chrome.runtime.sendMessage({ type: 'WOH_MAIN_SCAN' }, () => void chrome.runtime.lastError);

    if (!hasWofh()) {
      reportFrameStatus();
      return;
    }

    detectMyTowns();

    state.checks += 1;
    try {
      // Alerting is handled centrally by MAIN-world background scan.
      // Keep content script focused on status + scan trigger.
    } catch (e) {
      console.warn('[WOH EXT] tick error', e);
    }

    if (state.checks % 3 === 0) reportFrameStatus();
  }

  async function loadSettings() {
    const cfg = await chrome.runtime.sendMessage({ type: 'WOH_GET_SETTINGS' }).catch(() => null);
    if (cfg) state.cfg = cfg;
  }

  async function start() {
    await loadSettings();
    if (!state.cfg.enabled) {
      state.running = false;
      reportFrameStatus();
      return;
    }

    if (state.timer) clearInterval(state.timer);
    if (state.reportTimer) clearInterval(state.reportTimer);

    state.running = true;
    state.timer = setInterval(tick, state.cfg.pollMs || 5000);
    state.reportTimer = setInterval(reportFrameStatus, 3000);
    tick();
    console.log('[WOH EXT] monitor active', location.href);
  }

  function stop() {
    state.running = false;
    if (state.timer) clearInterval(state.timer);
    if (state.reportTimer) clearInterval(state.reportTimer);
    state.timer = null;
    state.reportTimer = null;
    reportFrameStatus();
  }

  window.addEventListener('pagehide', () => stop());
  window.addEventListener('beforeunload', () => stop());

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    const keys = ['enabled', 'pollMs', 'alertCooldownMs'];
    if (keys.some(k => changes[k])) start();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'WOH_TOGGLE') {
      if (msg.enabled) start(); else stop();
      sendResponse({ ok: true, running: state.running });
      return;
    }
    if (msg?.type === 'WOH_PING') {
      sendResponse({
        ok: true,
        running: state.running,
        checks: state.checks,
        towns: state.myTownIds.size,
        hasWofh: hasWofh(),
        href: location.href,
        isTop: window.top === window
      });
      return;
    }
  });

  window.__WOH_EXTENSION_MONITOR__ = { start, stop, state };
  start();
})();
