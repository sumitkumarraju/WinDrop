// Shared helpers for the WinDrop pages: icons (Lucide paths), file kinds, formatting, toasts.
window.WD = (() => {
  const FILE = '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>';
  const PATHS = {
    logo: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
    laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
    phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    download: '<path d="M12 15V3M7 10l5 5 5-5M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    power: '<path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    retry: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5"/>',
    file: FILE,
    doc: FILE + '<path d="M16 13H8M16 17H8M10 9H8"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    video: '<path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.94a.5.5 0 0 0-.76-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  };
  const icon = (name, cls = '') =>
    `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || FILE}</svg>`;

  const KINDS = {
    image: /\.(jpe?g|png|gif|heic|heif|webp|bmp|tiff?|svg|dng|raw)$/i,
    video: /\.(mov|mp4|m4v|mkv|avi|webm|3gp|wmv)$/i,
    music: /\.(mp3|m4a|aac|wav|flac|ogg|aiff?)$/i,
    archive: /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|dmg|apk|ipa|cab)$/i,
    doc: /\.(pdf|docx?|xlsx?|pptx?|txt|rtf|csv|md|pages|numbers|key|odt)$/i,
  };
  const kindOf = name => Object.keys(KINDS).find(k => KINDS[k].test(name)) || 'file';
  const fileIcon = name => `<span class="ficon k-${kindOf(name)}">${icon(kindOf(name))}</span>`;

  function size(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i];
  }
  const speed = bps => size(bps) + '/s';
  function eta(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return `${Math.ceil(sec)} s left`;
    if (sec < 3600) return `${Math.ceil(sec / 60)} min left`;
    return `${Math.floor(sec / 3600)} h ${Math.ceil((sec % 3600) / 60)} min left`;
  }
  const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  function toast(msg, tone = '') {
    const t = document.getElementById('toast');
    t.className = 'toast on ' + tone;
    t.innerHTML = icon(tone === 'ok' ? 'check' : tone === 'bad' ? 'alert' : 'logo') + `<span>${esc(msg)}</span>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 3400);
  }

  return { icon, fileIcon, kindOf, size, speed, eta, time, esc, toast, $: id => document.getElementById(id) };
})();
