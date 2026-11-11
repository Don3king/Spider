// ==UserScript==
// @name         PimpBunny 视频下载器
// @namespace    pimpbunny-video-downloader
// @version      1.7.0
// @description  在 pimpbunny 视频详情页解析真实播放地址，显示清晰度与文件大小，一键下载/复制直链。先把 get_file 链接解析成免 cookie 的 st*.pimpbunny.com 终链，再用 GM_download 或 blob 下载。
// @author       Don
// @match        *://pimpbunny.com/videos/*
// @match        *://pimpbunny.com/*/videos/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      pimpbunny.com
// @connect      *.pimpbunny.com
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 基础工具 ----------

  function decodeHtml(s) {
    if (!s) return s;
    const ta = document.createElement('textarea');
    ta.innerHTML = s;
    return ta.value;
  }

  function toAbsolute(value, base) {
    try {
      return new URL(value, base).href;
    } catch (e) {
      return value;
    }
  }

  function videoTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    const raw = (og && og.getAttribute('content')) || document.title || 'pimpbunny-video';
    return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function sanitizePart(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  function videoCategories() {
    const uls = document.querySelectorAll('ul[class*="pages-view-video-categories"]');
    for (const ul of uls) {
      const span = ul.querySelector('li > span');
      if (span && /categories/i.test(span.textContent || '')) {
        const cats = [];
        for (const a of ul.querySelectorAll('li > a')) {
          const t = (a.textContent || '').trim();
          if (t) cats.push(t);
        }
        return cats;
      }
    }
    return [];
  }

  function scriptText() {
    const parts = [];
    for (const s of document.querySelectorAll('script')) {
      if (s.textContent) parts.push(s.textContent);
    }
    return parts.join('\n');
  }

  function parseHeaders(str) {
    const h = {};
    if (!str) return h;
    for (const line of str.split(/[\r\n]+/)) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        h[k] = k in h ? h[k] + ', ' + v : v;
      }
    }
    return h;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    const mb = bytes / 1024 / 1024;
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    return mb.toFixed(1) + ' MB';
  }

  // ---------- KVS license 解密（BigInt 保证精度） ----------

  function kvsGetLicenseToken(licenseCode) {
    licenseCode = licenseCode.replace(/\$/g, '');
    const licenseValues = Array.from(licenseCode, (c) => parseInt(c, 10));
    const mod0 = licenseCode.replace(/0/g, '1');
    const center = Math.floor(mod0.length / 2);
    const front = BigInt(mod0.slice(0, center + 1));
    const back = BigInt(mod0.slice(center));
    const diff = front > back ? front - back : back - front;
    const mod = (4n * diff).toString().slice(0, center + 1);

    const token = [];
    Array.from(mod).forEach((c, index) => {
      const current = parseInt(c, 10);
      for (let offset = 0; offset < 4; offset++) {
        token.push(((licenseValues[index + offset] || 0) + current) % 10);
      }
    });
    return token;
  }

  function kvsGetRealUrl(videoUrl, licenseCode) {
    if (!videoUrl.startsWith('function/0/')) return videoUrl;
    const rest = videoUrl.slice('function/0/'.length);
    let url;
    try {
      url = new URL(rest);
    } catch (e) {
      return videoUrl;
    }
    const token = kvsGetLicenseToken(licenseCode);
    const parts = url.pathname.split('/');
    if (parts.length < 4) return videoUrl;

    const hashLength = 32;
    const seg = parts[3] || '';
    if (seg.length < hashLength) return videoUrl;
    const hash = seg.slice(0, hashLength);
    const segRest = seg.slice(hashLength);

    const indices = Array.from({ length: hashLength }, (_, i) => i);
    let accum = 0;
    for (let src = hashLength - 1; src >= 0; src--) {
      accum += token[src] || 0;
      const dest = (src + accum) % hashLength;
      [indices[src], indices[dest]] = [indices[dest], indices[src]];
    }
    parts[3] = indices.map((i) => hash[i]).join('') + segRest;
    url.pathname = parts.join('/');
    return url.href;
  }

  // ---------- flashvars 解析 ----------

  function extractFlashvars(text) {
    let m = text.match(/\bflashvars\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) {
      const re = /\b(?:var|let|const)\s+[\w$]+\s*=\s*(\{[\s\S]*?\})\s*;/g;
      let mm;
      while ((mm = re.exec(text)) !== null) {
        if (/\bvideo_url\s*:/.test(mm[1])) {
          m = mm;
          break;
        }
      }
    }
    if (!m) return {};
    const obj = m[1];
    const fields = {};
    for (const f of obj.matchAll(/\b(\w+)\s*:\s*'((?:\\.|[^'\\])*)'/g)) fields[f[1]] = f[2];
    for (const f of obj.matchAll(/\b(\w+)\s*:\s*"((?:\\.|[^"\\])*)"/g)) fields[f[1]] = f[2];
    return fields;
  }

  function pickMediaUrls(fields, base) {
    const candidates = [];
    for (const [name, value] of Object.entries(fields)) {
      if (!/^video_(?:alt_)?url\d*$/.test(name) || !value) continue;
      let v = decodeHtml(value.replace(/\\\//g, '/'));
      if (v.startsWith('function/0/')) {
        if (!fields.license_code) continue;
        v = kvsGetRealUrl(v, fields.license_code);
      }
      if (!/^(https?:\/\/|\/\/|\/)/.test(v)) continue;
      const abs = toAbsolute(v, base);
      const label = fields[name + '_text'] || '';
      const qm = (label + ' ' + v).match(/(\d{3,4})p/);
      const quality = qm ? parseInt(qm[1], 10) : 0;
      candidates.push({ url: abs, quality, label: label || (quality ? quality + 'p' : 'default'), stUrl: null, size: null });
    }
    const seen = new Set();
    const uniq = [];
    for (const c of candidates) {
      if (!seen.has(c.url)) {
        seen.add(c.url);
        uniq.push(c);
      }
    }
    uniq.sort((a, b) => b.quality - a.quality);
    return uniq;
  }

  function fallbackUrls() {
    const urls = [];
    for (const s of document.querySelectorAll('video source, video')) {
      const v = s.getAttribute('src') || s.currentSrc;
      if (v && /^(https?:\/\/|\/\/)/.test(v)) urls.push({ url: toAbsolute(v, location.href), quality: 0, label: '当前播放', stUrl: null, size: null });
    }
    return urls;
  }

  // ---------- 网络 ----------

  function gmRequest(detail) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest unavailable'));
        return;
      }
      GM_xmlhttpRequest(Object.assign({
        anonymous: false,
        timeout: 30000,
        onload: resolve,
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      }, detail));
    });
  }

  async function resolveFinalUrl(getFileUrl) {
    const resp = await gmRequest({ method: 'GET', url: getFileUrl, redirect: 'manual' });
    const headers = parseHeaders(resp.responseHeaders);
    let target = headers['location'];
    if (!target && resp.finalUrl && resp.finalUrl !== getFileUrl) target = resp.finalUrl;
    if (target) return toAbsolute(target, getFileUrl);
    if (resp.status >= 200 && resp.status < 300) return resp.finalUrl || getFileUrl;
    throw new Error('HTTP ' + resp.status);
  }

  async function headSize(url) {
    try {
      const resp = await gmRequest({ method: 'HEAD', url: url, redirect: 'follow' });
      const cl = parseHeaders(resp.responseHeaders)['content-length'];
      return cl ? parseInt(cl, 10) : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- 下载 ----------

  function downloadViaGM(url, name) {
    return new Promise((resolve) => {
      if (typeof GM_download !== 'function') {
        resolve({ ok: false, msg: 'GM_download 未授权' });
        return;
      }
      let settled = false;
      const settle = (r) => { if (!settled) { settled = true; resolve(r); } };

      try {
        GM_download({
          url: url,
          name: name,
          saveAs: false,
          onload: () => settle({ ok: true, msg: '下载完成' }),
          onerror: (e) => settle({ ok: false, msg: 'onerror:' + ((e && (e.error || e.message)) || JSON.stringify(e)) }),
          ontimeout: () => settle({ ok: false, msg: 'ontimeout' }),
        });
      } catch (e) {
        settle({ ok: false, msg: '异常:' + String(e) });
        return;
      }

      // 兜底：部分版本不触发回调、也不抛错，2 秒后若仍无回调则视为已提交
      setTimeout(() => settle({ ok: true, msg: '已提交(无回调)' }), 2000);
    });
  }

  // ---------- UI ----------

  function buildPanel(urls) {
    const title = videoTitle();
    const cats = videoCategories().map(sanitizePart).join('_');
    const catPart = cats ? cats + '_' : '';
    const fileName = (label) => `${title}_${catPart}pimpbunny_${label}.mp4`;

    const root = document.createElement('div');
    root.id = 'pb-dl-panel';
    root.innerHTML = `
      <style>
        #pb-dl-panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          font: 13px/1.4 -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif; }
        #pb-dl-panel .pb-toggle { background: #e5484d; color: #fff; border: none; border-radius: 24px;
          padding: 10px 16px; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.35); font-size: 14px; }
        #pb-dl-panel .pb-menu { display: none; margin-bottom: 10px; background: #1a1a1f; color: #eee;
          border-radius: 10px; padding: 8px; min-width: 320px; max-height: 60vh; overflow: auto;
          box-shadow: 0 8px 28px rgba(0,0,0,.5); }
        #pb-dl-panel.open .pb-menu { display: block; }
        #pb-dl-panel .pb-title { padding: 6px 8px; font-weight: 600; color: #fff; word-break: break-all; }
        #pb-dl-panel .pb-item { display: flex; justify-content: space-between; align-items: center;
          gap: 8px; padding: 8px; border-radius: 6px; }
        #pb-dl-panel .pb-item:hover { background: #2a2a33; }
        #pb-dl-panel .pb-q { font-weight: 600; color: #fff; }
        #pb-dl-panel .pb-size { color: #9fb3ff; font-weight: 400; }
        #pb-dl-panel .pb-btns { display: flex; gap: 6px; }
        #pb-dl-panel .pb-btns button { border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer;
          font-size: 12px; color: #fff; background: #3b3b46; }
        #pb-dl-panel .pb-btns button.pb-dl { background: #e5484d; }
        #pb-dl-panel .pb-btns button:disabled { opacity: .5; cursor: default; }
      </style>
      <div class="pb-menu">
        <div class="pb-title">「${title}」</div>
      </div>
      <button class="pb-toggle">⬇ 下载视频</button>
    `;
    document.body.appendChild(root);
    const menu = root.querySelector('.pb-menu');

    function addItem(u) {
      const item = document.createElement('div');
      item.className = 'pb-item';
      item.innerHTML = `
        <span class="pb-q">${u.label} <span class="pb-size"></span></span>
        <span class="pb-btns">
          <button class="pb-dl">下载</button>
          <button class="pb-copy">复制链接</button>
        </span>`;
      const sizeEl = item.querySelector('.pb-size');
      const dlBtn = item.querySelector('.pb-dl');
      const copyBtn = item.querySelector('.pb-copy');
      menu.appendChild(item);

      // 异步解析 st 终链 + 大小，填充显示
      (async () => {
        try {
          if (!u.stUrl) u.stUrl = await resolveFinalUrl(u.url);
          if (u.size == null) u.size = await headSize(u.stUrl);
          sizeEl.textContent = u.size != null ? ' · ' + formatSize(u.size) : '';
        } catch (e) {
          sizeEl.textContent = '';
        }
      })();

      async function ensureSt() {
        if (u.stUrl) return u.stUrl;
        u.stUrl = await resolveFinalUrl(u.url);
        return u.stUrl;
      }

      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = copyBtn.disabled = true;
        const old = dlBtn.textContent;
        dlBtn.textContent = '解析中…';
        try {
          const stUrl = await ensureSt();
          const name = fileName(u.label);
          const r = await downloadViaGM(stUrl, name);
          dlBtn.textContent = r.ok ? '已触发下载' : r.msg;
        } catch (e) {
          dlBtn.textContent = '失败，刷新重试';
        } finally {
          dlBtn.disabled = copyBtn.disabled = false;
          setTimeout(() => { dlBtn.textContent = old; }, 2500);
        }
      });

      copyBtn.addEventListener('click', async () => {
        copyBtn.disabled = dlBtn.disabled = true;
        const old = copyBtn.textContent;
        copyBtn.textContent = '解析中…';
        try {
          const stUrl = await ensureSt();
          copyText(stUrl);
          copyBtn.textContent = '已复制';
        } catch (e) {
          copyBtn.textContent = '失败，刷新重试';
        } finally {
          copyBtn.disabled = dlBtn.disabled = false;
          setTimeout(() => { copyBtn.textContent = old; }, 1500);
        }
      });
    }

    for (const u of urls) addItem(u);

    root.querySelector('.pb-toggle').addEventListener('click', () => {
      root.classList.toggle('open');
    });
  }

  // ---------- 主流程 ----------

  function isDetailPage() {
    const m = location.pathname.match(/\/videos\/([a-z0-9][a-z0-9-]*)\/?$/);
    return !!m && !/^\d+$/.test(m[1]);
  }

  function main() {
    if (!isDetailPage()) return;

    const fields = extractFlashvars(scriptText());
    let urls = pickMediaUrls(fields, location.href);
    if (!urls.length) {
      urls = fallbackUrls();
    }
    if (!urls.length) return;

    buildPanel(urls);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
