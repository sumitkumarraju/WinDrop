// Full-screen ripple — a JavaScript port of Apple's SwiftUI "Ripple" Metal layer effect:
//
//   t            = max(0, time - distance / speed)
//   rippleAmount = amplitude * sin(frequency * t) * exp(-decay * t)
//   newPosition  = position + rippleAmount * normalize(position - origin)
//   color.rgb   += 0.3 * (rippleAmount / amplitude)
//
// The page is displaced with an SVG displacement filter where the browser supports it on HTML
// (Chromium / Edge on the PC), and every platform gets the light/dark wave plus a glowing
// wave front drawn on a canvas overlay. Defaults match RippleEffect: amplitude 12, frequency 15,
// decay 8, speed 1200, duration 3 s.
window.WDRipple = (() => {
  const DURATION = 3;
  const DEFAULTS = { amplitude: 12, frequency: 15, decay: 8, speed: 1200, glow: 1 };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const canDistort = /Chrome|Edg\//.test(navigator.userAgent) && !/Mobile|Android/.test(navigator.userAgent);
  const STEP = 3; // compute the wave on a coarse grid; it is smooth, so upscaling is invisible
  const ripples = [];
  let target = null;
  let overlay, octx, oimg;
  let feImage, mapCanvas, mctx, mimg;
  let raf = 0;
  let tint = [90, 170, 255];

  function init(el, opts = {}) {
    target = el;
    if (opts.tint) tint = opts.tint;
    overlay = document.createElement('canvas');
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh',
      pointerEvents: 'none', zIndex: '9000', display: 'none',
    });
    document.body.appendChild(overlay);
    octx = overlay.getContext('2d');

    if (canDistort) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
      svg.innerHTML =
        '<filter id="wd-ripple" x="0" y="0" width="1" height="1" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">' +
        '<feImage id="wd-ripple-map" x="0" y="0" preserveAspectRatio="none" result="map"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="map" scale="48" xChannelSelector="R" yChannelSelector="G"/>' +
        '</filter>';
      document.body.appendChild(svg);
      feImage = svg.querySelector('#wd-ripple-map');
      mapCanvas = document.createElement('canvas');
      mctx = mapCanvas.getContext('2d');
    }
  }

  // x, y are viewport coordinates (e.g. event.clientX / clientY or an element's centre).
  function play(x, y, opts = {}) {
    if (!overlay) init(document.body);
    ripples.push({ x, y, start: performance.now() / 1000, ...DEFAULTS, ...opts });
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function playFrom(el, opts) {
    const r = el.getBoundingClientRect();
    play(r.left + r.width / 2, r.top + r.height / 2, opts);
  }

  function stop() {
    raf = 0;
    overlay.style.display = 'none';
    if (target) target.style.filter = '';
  }

  function frame() {
    const now = performance.now() / 1000;
    for (let i = ripples.length - 1; i >= 0; i--) if (now - ripples[i].start > DURATION) ripples.splice(i, 1);
    if (!ripples.length) return stop();

    const W = Math.ceil(innerWidth / STEP);
    const H = Math.ceil(innerHeight / STEP);
    if (overlay.width !== W || overlay.height !== H) {
      overlay.width = W; overlay.height = H;
      oimg = octx.createImageData(W, H);
      if (mapCanvas) {
        mapCanvas.width = W; mapCanvas.height = H;
        mimg = mctx.createImageData(W, H);
      }
    }
    overlay.style.display = 'block';

    const reduced = reduceMotion.matches;
    const distort = canDistort && !reduced && target;
    const o = oimg.data;
    const m = distort ? mimg.data : null;
    const scale = 48; // must match feDisplacementMap scale: R = 0.5 + dx / scale

    for (let py = 0, idx = 0; py < H; py++) {
      const y = (py + 0.5) * STEP;
      for (let px = 0; px < W; px++, idx += 4) {
        const x = (px + 0.5) * STEP;
        let dx = 0, dy = 0, light = 0, glow = 0;
        for (const r of ripples) {
          const age = now - r.start;
          const ox = x - r.x, oy = y - r.y;
          const dist = Math.sqrt(ox * ox + oy * oy);
          const t = age - dist / r.speed;
          if (t <= 0) continue;
          const amount = reduced ? 0 : r.amplitude * Math.sin(r.frequency * t) * Math.exp(-r.decay * t);
          if (dist > 0) { dx += (amount * ox) / dist; dy += (amount * oy) / dist; }
          light += amount / r.amplitude;
          glow += r.glow * Math.exp(-t * t * 45) * Math.exp(-age * 1.1); // bright wave front, fading over time
        }
        const aLight = Math.max(light, 0) * 0.3;
        const aDark = Math.max(-light, 0) * 0.3;
        const aGlow = Math.min(glow, 1) * 0.55;
        const a = Math.min(aLight + aDark + aGlow, 0.9);
        if (a > 0.002) {
          o[idx] = (255 * aLight + tint[0] * aGlow) / a;
          o[idx + 1] = (255 * aLight + tint[1] * aGlow) / a;
          o[idx + 2] = (255 * aLight + tint[2] * aGlow) / a;
          o[idx + 3] = a * 255;
        } else {
          o[idx + 3] = 0;
        }
        if (m) {
          // feDisplacementMap samples at P + scale * (C - 0.5); Apple samples at P + rippleAmount * n.
          m[idx] = Math.max(0, Math.min(255, 127.5 + (dx / scale) * 255));
          m[idx + 1] = Math.max(0, Math.min(255, 127.5 + (dy / scale) * 255));
          m[idx + 2] = 0;
          m[idx + 3] = 255;
        }
      }
    }
    octx.putImageData(oimg, 0, 0);
    if (m) {
      mctx.putImageData(mimg, 0, 0);
      feImage.setAttribute('width', innerWidth);
      feImage.setAttribute('height', innerHeight);
      feImage.setAttribute('href', mapCanvas.toDataURL());
      target.style.filter = 'url(#wd-ripple)';
    }
    raf = requestAnimationFrame(frame);
  }

  return { init, play, playFrom };
})();
