// Script de contenu, injecté dans TOUTES les frames (all_frames + match_about_blank).
// Rôles : détecter les <video> significatives, se signaler au service worker,
// afficher les sous-titres par-dessus la vidéo (overlay ou piste native), gérer les raccourcis.
//
// Script classique (pas de module) : tout est encapsulé dans une IIFE.
(() => {
  if (window.__subsExtLoaded) return;
  window.__subsExtLoaded = true;

  const MIN_DURATION = 60; // s
  const MIN_W = 300;
  const MIN_H = 150;

  const DEFAULT_STYLE = {
    size: 5.5, // % de la hauteur de la vidéo
    color: '#ffffff',
    background: false, // fond semi-transparent derrière le texte
    bgOpacity: 0.5,
    position: 8, // % depuis le bas
    render: 'overlay', // 'overlay' | 'native'
  };

  const state = {
    video: null, // vidéo principale de la frame
    cues: [], // [{start, end, text}] triées
    offset: 0, // secondes (positif = sous-titres plus tard)
    visible: true,
    meta: null, // { key, release, provider }
    srcAtLoad: null,
    style: { ...DEFAULT_STYLE },
    tabHasSubs: false, // une autre frame de l'onglet affiche des sous-titres (pour relayer les touches)
    lastRendered: null,
    raf: 0,
    nativeTrack: null,
    nativeForced: false, // overlay impossible (vidéo elle-même en plein écran)
  };

  const videos = new Set();

  // ---------------------------------------------------------------------------
  // Détection des vidéos
  // ---------------------------------------------------------------------------

  function isSignificant(v) {
    if (!v.isConnected) return false;
    const r = v.getBoundingClientRect();
    const longEnough = Number.isFinite(v.duration) ? v.duration > MIN_DURATION : v.duration === Infinity;
    return longEnough || (r.width >= MIN_W && r.height >= MIN_H);
  }

  function pickMainVideo() {
    const list = [...videos].filter(isSignificant);
    if (!list.length) return null;
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    // En lecture d'abord, puis la plus grande
    list.sort((a, b) => Number(a.paused) - Number(b.paused) || area(b) - area(a));
    return list[0];
  }

  const VIDEO_EVENTS = ['loadedmetadata', 'durationchange', 'play', 'playing', 'pause', 'seeked', 'seeking', 'ratechange', 'emptied', 'loadstart', 'resize', 'ended'];

  function attachVideo(v) {
    if (videos.has(v)) return;
    videos.add(v);
    for (const ev of VIDEO_EVENTS) v.addEventListener(ev, onVideoEvent, { passive: true });
    resizeObserver.observe(v);
    scheduleReport();
  }

  function detachVideo(v) {
    if (!videos.delete(v)) return;
    for (const ev of VIDEO_EVENTS) v.removeEventListener(ev, onVideoEvent);
    resizeObserver.unobserve(v);
    if (state.video === v) {
      state.video = null;
      ensureVideo();
    }
    scheduleReport();
  }

  function scan(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.tagName === 'VIDEO') attachVideo(root);
    root.querySelectorAll?.('video').forEach(attachVideo);
  }

  const mutationObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach(scan);
      m.removedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'VIDEO') detachVideo(n);
        else n.querySelectorAll?.('video').forEach(detachVideo);
      });
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    positionOverlay();
    scheduleReport();
  });

  function onVideoEvent(e) {
    const v = e.target;
    switch (e.type) {
      case 'play':
      case 'playing':
        if (state.cues.length && v !== state.video && isSignificant(v)) switchVideo(v);
        if (v === state.video) startLoop();
        if (v === pickMainVideo()) notify({ type: 'video-playing' });
        break;
      case 'loadstart':
      case 'emptied':
        // Changement de src (épisode suivant) : on retire les sous-titres de l'ancien contenu
        if (v === state.video && state.cues.length && state.srcAtLoad && v.currentSrc && v.currentSrc !== state.srcAtLoad) {
          clearSubtitles();
          notify({ type: 'video-changed' });
        }
        break;
      default:
        if (v === state.video) {
          renderNow();
          if (!v.paused) startLoop();
        }
    }
    scheduleReport();
  }

  // ---------------------------------------------------------------------------
  // Communication avec le service worker
  // ---------------------------------------------------------------------------

  function notify(msg) {
    try {
      chrome.runtime.sendMessage({ ...msg, from: 'content' }).catch(() => {});
    } catch {
      // Extension rechargée : ce script orphelin n'a plus de runtime. On arrête tout.
      teardown();
    }
  }

  let reportTimer = 0;
  let lastReport = '';
  function scheduleReport() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(report, 300);
  }

  function videoInfo() {
    const v = pickMainVideo();
    if (!v) return { hasVideo: false };
    const r = v.getBoundingClientRect();
    return {
      hasVideo: true,
      width: Math.round(r.width),
      height: Math.round(r.height),
      duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      playing: !v.paused,
      hasSubs: state.cues.length > 0,
      offset: state.offset,
      visible: state.visible,
      release: state.meta?.release || null,
      top: window === window.top,
    };
  }

  function report() {
    const info = videoInfo();
    const sig = JSON.stringify(info);
    if (sig === lastReport) return;
    lastReport = sig;
    notify({ type: 'video-status', info });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'load-cues':
        loadSubtitles(msg.cues, msg.offset || 0, msg.meta || null);
        sendResponse({ ok: !!state.video, info: videoInfo() });
        break;
      case 'shift-offset':
        setOffset(state.offset + msg.delta);
        sendResponse({ ok: true, offset: state.offset });
        break;
      case 'set-offset':
        setOffset(msg.offset);
        sendResponse({ ok: true, offset: state.offset });
        break;
      case 'toggle':
        toggleVisible();
        sendResponse({ ok: true, visible: state.visible });
        break;
      case 'clear':
        clearSubtitles();
        sendResponse({ ok: true });
        break;
      case 'get-state':
        sendResponse(videoInfo());
        break;
      case 'tab-has-subs':
        state.tabHasSubs = !!msg.value;
        break;
      case 'get-page-info': {
        // Seule la frame principale a un og:title pertinent
        const og = document.querySelector('meta[property="og:title"]')?.content || '';
        sendResponse({ ogTitle: og, title: document.title, url: location.href });
        break;
      }
      default:
        return false;
    }
    return false;
  });

  // ---------------------------------------------------------------------------
  // Sous-titres : chargement, décalage, visibilité
  // ---------------------------------------------------------------------------

  function ensureVideo() {
    if (state.video && state.video.isConnected) return state.video;
    const v = pickMainVideo();
    if (v) switchVideo(v);
    return state.video;
  }

  function switchVideo(v) {
    if (state.video === v) return;
    removeNativeTrack();
    state.video = v;
    state.srcAtLoad = v.currentSrc || v.src || null;
    if (state.cues.length) {
      mountOverlay();
      applyRenderMode();
      renderNow();
      if (!v.paused) startLoop();
    }
  }

  function loadSubtitles(cues, offset, meta) {
    state.cues = Array.isArray(cues) ? cues : [];
    state.offset = Math.round((offset || 0) * 10) / 10;
    state.meta = meta;
    state.visible = true;
    state.lastRendered = null;
    const v = ensureVideo();
    if (v) {
      state.srcAtLoad = v.currentSrc || v.src || null;
      mountOverlay();
      applyRenderMode();
      renderNow();
      if (!v.paused) startLoop();
    }
    scheduleReport();
  }

  function clearSubtitles() {
    state.cues = [];
    state.meta = null;
    state.lastRendered = null;
    removeNativeTrack();
    if (cueBox) cueBox.textContent = '';
    unmountOverlay();
    scheduleReport();
  }

  function setOffset(value) {
    state.offset = Math.round(value * 10) / 10; // pas de 0,1 s : on évite les 0,30000000004
    if (isNative()) fillNativeTrack();
    renderNow();
    showToast(`Décalage : ${formatOffset(state.offset)}`);
    notify({ type: 'offset-changed', offset: state.offset });
    scheduleReport();
  }

  function toggleVisible() {
    state.visible = !state.visible;
    if (state.nativeTrack && isNative()) state.nativeTrack.mode = state.visible ? 'showing' : 'hidden';
    // L'overlay reste monté (pour le toast) ; renderNow() n'affiche rien quand c'est masqué.
    state.lastRendered = null;
    if (cueBox) cueBox.textContent = '';
    renderNow();
    showToast(state.visible ? 'Sous-titres affichés' : 'Sous-titres masqués');
    scheduleReport();
  }

  function formatOffset(o) {
    const s = (o >= 0 ? '+' : '−') + Math.abs(o).toFixed(1).replace('.', ',');
    return `${s} s`;
  }

  // ---------------------------------------------------------------------------
  // Overlay (Shadow DOM fermé pour être isolé du CSS du site)
  // ---------------------------------------------------------------------------

  let host = null;
  let shadow = null;
  let cueBox = null;
  let toastBox = null;
  let toastTimer = 0;

  const SHADOW_CSS = `
    :host { all: initial; }
    .wrap { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
    .cues { position: absolute; left: 5%; right: 5%; text-align: center; font-family: Arial, Helvetica, sans-serif;
            line-height: 1.25; font-weight: 600; white-space: pre-line; }
    .line { display: inline; padding: 0.05em 0.3em; border-radius: 0.15em; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .toast { position: absolute; top: 6%; left: 50%; transform: translateX(-50%); padding: 0.35em 0.8em; border-radius: 0.4em;
             background: rgba(0,0,0,.75); color: #fff; font: 600 16px/1.3 Arial, sans-serif; opacity: 0; transition: opacity .2s; white-space: nowrap; }
    .toast.on { opacity: 1; }
  `;

  function createOverlay() {
    host = document.createElement('subsext-overlay');
    host.className = 'subsext-host';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    cueBox = document.createElement('div');
    cueBox.className = 'cues';
    toastBox = document.createElement('div');
    toastBox.className = 'toast';
    wrap.append(cueBox, toastBox);
    shadow.append(style, wrap);
    applyStyle();
  }

  /** Parent courant de l'overlay : l'élément plein écran s'il contient la vidéo, sinon <html>. */
  function overlayParent() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs && state.video && fs !== state.video && fs.contains(state.video)) return fs;
    return document.documentElement;
  }

  function mountOverlay() {
    if (isNative()) return;
    if (!host) createOverlay();
    const parent = overlayParent();
    if (host.parentNode !== parent) parent.appendChild(host);
    positionOverlay();
  }

  function unmountOverlay() {
    host?.remove();
  }

  function positionOverlay() {
    if (!host || !host.isConnected || !state.video) return;
    const r = state.video.getBoundingClientRect();
    // Position "fixed" en coordonnées du viewport : insensible au scroll de la page,
    // et fonctionne aussi dans l'élément plein écran (qui couvre le viewport).
    const set = (k, v) => host.style.setProperty(k, v, 'important');
    set('left', `${r.left}px`);
    set('top', `${r.top}px`);
    set('width', `${r.width}px`);
    set('height', `${r.height}px`);
    set('display', r.width && r.height ? 'block' : 'none');
    const px = Math.max(12, (r.height * state.style.size) / 100);
    cueBox.style.fontSize = `${px}px`;
    toastBox.style.fontSize = `${Math.max(13, px * 0.6)}px`;
  }

  function applyStyle() {
    if (!cueBox) return;
    const s = state.style;
    cueBox.style.bottom = `${s.position}%`;
    cueBox.style.color = s.color;
    // Contour noir (ombres multiples) : lisible sur fond clair comme foncé
    cueBox.style.textShadow =
      '0 0 2px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000';
    cueBox.dataset.bg = s.background ? '1' : '';
    state.lastRendered = null;
    positionOverlay();
    renderNow();
  }

  function showToast(text) {
    if (!state.video) return;
    if (!host) createOverlay();
    if (!host.isConnected) {
      // en mode natif l'overlay sert uniquement au toast
      overlayParent().appendChild(host);
      positionOverlay();
    }
    toastBox.textContent = text;
    toastBox.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastBox.classList.remove('on');
      if (isNative()) setTimeout(() => !toastBox.classList.contains('on') && unmountOverlay(), 250);
    }, 1500);
  }

  // Repositionnement : scroll (capture : n'importe quel conteneur), resize, plein écran
  addEventListener('scroll', () => positionOverlay(), { capture: true, passive: true });
  addEventListener('resize', () => positionOverlay(), { passive: true });
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, onFullscreenChange);
  }

  function onFullscreenChange() {
    if (!state.cues.length || !state.video) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    // Cas piège : c'est la <video> elle-même qui est en plein écran → aucun enfant n'est rendu par-dessus.
    // On bascule temporairement sur la piste native.
    const forced = fs === state.video;
    if (forced !== state.nativeForced) {
      state.nativeForced = forced;
      applyRenderMode();
    }
    if (!isNative()) mountOverlay();
    // Le layout plein écran n'est pas toujours prêt au moment de l'évènement
    requestAnimationFrame(() => {
      positionOverlay();
      renderNow();
    });
  }

  // ---------------------------------------------------------------------------
  // Synchronisation
  // ---------------------------------------------------------------------------

  /** Index de la dernière cue dont start <= t (recherche binaire). */
  function lastStartedIndex(t) {
    const c = state.cues;
    let lo = 0;
    let hi = c.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function activeCues(t) {
    const idx = lastStartedIndex(t);
    const out = [];
    // Les cues qui se chevauchent sont rares et proches : on remonte de quelques positions
    for (let i = idx; i >= 0 && i > idx - 8; i--) if (state.cues[i].end > t) out.unshift(state.cues[i]);
    return out;
  }

  let lastPosCheck = 0;
  function renderNow() {
    if (!state.video || !state.cues.length || isNative() || !cueBox) return;
    const now = performance.now();
    if (now - lastPosCheck > 250) {
      // filet de sécurité pour les déplacements non signalés (animations CSS, lecteurs exotiques)
      lastPosCheck = now;
      positionOverlay();
    }
    if (!state.visible) return;
    const t = state.video.currentTime - state.offset;
    const cues = activeCues(t);
    const sig = cues.map((c) => c.start).join('|') + (cueBox.dataset.bg ? 'bg' : '');
    if (sig === state.lastRendered) return;
    state.lastRendered = sig;
    cueBox.textContent = '';
    cues.forEach((c, i) => {
      if (i) cueBox.appendChild(document.createElement('br'));
      c.text.split('\n').forEach((line, j) => {
        if (j) cueBox.appendChild(document.createElement('br'));
        const span = document.createElement('span');
        span.className = 'line';
        if (cueBox.dataset.bg) span.style.background = `rgba(0,0,0,${state.style.bgOpacity})`;
        renderMarkup(line, span);
        cueBox.appendChild(span);
      });
    });
  }

  function startLoop() {
    if (state.raf || isNative()) return;
    const tick = () => {
      state.raf = 0;
      renderNow();
      const v = state.video;
      if (v && !v.paused && !v.ended && state.cues.length) state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  }

  /**
   * Construit le DOM à partir du format restreint produit par lib/subtitles.js
   * (texte échappé + <i>, <b>, <u>). Aucune autre balise n'est créée, jamais d'innerHTML.
   */
  function renderMarkup(text, parent) {
    const stack = [parent];
    const re = /<(\/?)([ibu])>|([^<]+)|</g;
    let m;
    while ((m = re.exec(text))) {
      const top = stack[stack.length - 1];
      if (m[2]) {
        if (m[1]) {
          if (stack.length > 1 && top.tagName.toLowerCase() === m[2]) stack.pop();
        } else {
          const el = document.createElement(m[2]);
          top.appendChild(el);
          stack.push(el);
        }
      } else {
        top.appendChild(document.createTextNode(decodeEntities(m[3] ?? m[0])));
      }
    }
  }

  function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>' })[e]);
  }

  // ---------------------------------------------------------------------------
  // Mode natif (addTextTrack + VTTCue) — secours pour les lecteurs récalcitrants
  // ---------------------------------------------------------------------------

  function isNative() {
    return state.style.render === 'native' || state.nativeForced;
  }

  function applyRenderMode() {
    if (!state.video || !state.cues.length) return;
    if (isNative()) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
      if (cueBox) cueBox.textContent = '';
      unmountOverlay();
      fillNativeTrack();
    } else {
      removeNativeTrack();
      mountOverlay();
      state.lastRendered = null;
      renderNow();
      if (!state.video.paused) startLoop();
    }
  }

  function fillNativeTrack() {
    const v = state.video;
    if (!v) return;
    if (!state.nativeTrack || state.nativeTrackVideo !== v) {
      // Une piste ajoutée ne peut pas être supprimée : on la réutilise pour cette vidéo.
      state.nativeTrack = v.addTextTrack('subtitles', 'Sous-titres (extension)', 'fr');
      state.nativeTrackVideo = v;
    }
    const tr = state.nativeTrack;
    tr.mode = 'hidden';
    for (const c of [...(tr.cues || [])]) tr.removeCue(c);
    for (const c of state.cues) {
      const start = Math.max(0, c.start + state.offset);
      const end = Math.max(start + 0.01, c.end + state.offset);
      const cue = new VTTCue(start, end, c.text); // le format restreint est du balisage WebVTT valide
      cue.line = -2;
      tr.addCue(cue);
    }
    tr.mode = state.visible ? 'showing' : 'hidden';
  }

  function removeNativeTrack() {
    const tr = state.nativeTrack;
    if (!tr) return;
    for (const c of [...(tr.cues || [])]) tr.removeCue(c);
    tr.mode = 'disabled';
  }

  // ---------------------------------------------------------------------------
  // Raccourcis clavier (style VLC) — capture, seulement nos touches
  // ---------------------------------------------------------------------------

  function isEditable(e) {
    const el = e.composedPath?.()[0] || e.target;
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !/^(button|checkbox|radio|range|submit|reset|color|file|image)$/i.test(el.type);
    return false;
  }

  addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k !== 'g' && k !== 'h' && k !== 'v') return;
      const local = state.cues.length > 0 && !!state.video;
      if (!local && !state.tabHasSubs) return; // aucun sous-titre : on ne touche à rien
      if (isEditable(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (k === 'v') {
        if (local) toggleVisible();
        else notify({ type: 'key', action: 'toggle' });
        return;
      }
      const delta = (k === 'g' ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
      if (local) setOffset(state.offset + delta);
      else notify({ type: 'key', action: 'shift', delta }); // la vidéo est dans une autre frame
    },
    true,
  );

  // ---------------------------------------------------------------------------
  // Réglages (chrome.storage.sync) — mis à jour en direct
  // ---------------------------------------------------------------------------

  function loadSettings() {
    chrome.storage.sync.get('style', ({ style }) => {
      state.style = { ...DEFAULT_STYLE, ...(style || {}) };
      applyStyle();
      applyRenderMode();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.style) {
      const prevRender = state.style.render;
      state.style = { ...DEFAULT_STYLE, ...(changes.style.newValue || {}) };
      applyStyle();
      if (prevRender !== state.style.render) applyRenderMode();
    }
  });

  // ---------------------------------------------------------------------------
  // Démarrage / arrêt
  // ---------------------------------------------------------------------------

  function teardown() {
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    cancelAnimationFrame(state.raf);
    unmountOverlay();
  }

  function start() {
    loadSettings();
    scan(document);
    mutationObserver.observe(document.documentElement || document, { childList: true, subtree: true });
    scheduleReport();
  }

  addEventListener('pagehide', () => notify({ type: 'video-status', info: { hasVideo: false } }));

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
