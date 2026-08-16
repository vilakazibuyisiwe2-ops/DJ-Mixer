(() => {
  'use strict';

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextClass();
  const masterGain = ctx.createGain();
  const masterAnalyser = ctx.createAnalyser();
  masterAnalyser.fftSize = 256;
  masterGain.connect(masterAnalyser);
  masterAnalyser.connect(ctx.destination);

  // ---------------------------------------------------------------
  // Demo loop synthesis — no external audio files, everything here
  // is generated with oscillators/noise so the deck works instantly.
  // ---------------------------------------------------------------

  function createNoiseBuffer(duration) {
    const length = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function scheduleKick(destination, offlineCtx, time) {
    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.14);
    gain.gain.setValueAtTime(0.9, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    osc.connect(gain).connect(destination);
    osc.start(time);
    osc.stop(time + 0.2);
  }

  function scheduleHat(destination, offlineCtx, noiseBuffer, time, velocity) {
    const src = offlineCtx.createBufferSource();
    const filter = offlineCtx.createBiquadFilter();
    const gain = offlineCtx.createGain();
    src.buffer = noiseBuffer;
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    gain.gain.setValueAtTime(0.25 * velocity, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
    src.connect(filter).connect(gain).connect(destination);
    src.start(time);
    src.stop(time + 0.05);
  }

  function scheduleSnare(destination, offlineCtx, noiseBuffer, time) {
    const src = offlineCtx.createBufferSource();
    const filter = offlineCtx.createBiquadFilter();
    const gain = offlineCtx.createGain();
    src.buffer = noiseBuffer;
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 0.7;
    gain.gain.setValueAtTime(0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    src.connect(filter).connect(gain).connect(destination);
    src.start(time);
    src.stop(time + 0.15);
  }

  async function renderDemoLoop(variant) {
    const loopSeconds = 4;
    const offlineCtx = new OfflineAudioContext(2, ctx.sampleRate * loopSeconds, ctx.sampleRate);
    const bus = offlineCtx.createGain();
    bus.gain.value = 0.9;
    bus.connect(offlineCtx.destination);

    const noise = offlineCtx.createBuffer(1, offlineCtx.sampleRate * 0.1, offlineCtx.sampleRate);
    const noiseData = noise.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

    const eighth = 0.25; // seconds, 120bpm eighth note

    if (variant === 'a') {
      // Four-on-the-floor: kick every beat, steady closed hats, backbeat clap.
      for (let beat = 0; beat < 8; beat++) {
        scheduleKick(bus, offlineCtx, beat * eighth * 2);
      }
      for (let step = 0; step < 16; step++) {
        scheduleHat(bus, offlineCtx, noise, step * eighth, step % 2 === 0 ? 1 : 0.6);
      }
      scheduleSnare(bus, offlineCtx, noise, 1 * eighth * 2);
      scheduleSnare(bus, offlineCtx, noise, 3 * eighth * 2);
      scheduleSnare(bus, offlineCtx, noise, 5 * eighth * 2);
      scheduleSnare(bus, offlineCtx, noise, 7 * eighth * 2);
    } else {
      // Offbeat / syncopated: sparser kick, swung hats, snare on 2 and 4 only.
      [0, 2, 3.5, 6].forEach((beat) => scheduleKick(bus, offlineCtx, beat * eighth * 2));
      for (let step = 0; step < 16; step++) {
        const velocity = step % 4 === 2 ? 1 : 0.45;
        scheduleHat(bus, offlineCtx, noise, step * eighth, velocity);
      }
      scheduleSnare(bus, offlineCtx, noise, 1 * eighth * 2);
      scheduleSnare(bus, offlineCtx, noise, 5 * eighth * 2);
    }

    return offlineCtx.startRendering();
  }

  // ---------------------------------------------------------------
  // Deck (channel) model
  // ---------------------------------------------------------------

  function computePeaks(buffer, targetPoints) {
    const data = buffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(data.length / targetPoints));
    const peaks = [];
    for (let i = 0; i < targetPoints; i++) {
      const start = i * blockSize;
      let min = 1, max = -1;
      for (let j = 0; j < blockSize; j++) {
        const v = data[start + j];
        if (v === undefined) break;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks.push([min, max]);
    }
    return peaks;
  }

  function formatTime(seconds) {
    if (!isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  class Deck {
    constructor(id, accentVar) {
      this.id = id;
      this.accentVar = accentVar;
      this.buffer = null;
      this.peaks = [];
      this.playing = false;
      this.offset = 0;
      this.startTime = 0;
      this.source = null;

      this.trimGain = ctx.createGain();
      this.faderGain = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.xfadeGain = ctx.createGain();

      this.trimGain.connect(this.faderGain);
      this.faderGain.connect(this.analyser);
      this.analyser.connect(this.xfadeGain);
      this.xfadeGain.connect(masterGain);

      this.tempo = 1;
      this.trimGain.gain.value = 1;

      this.vuData = new Uint8Array(this.analyser.fftSize);

      this.els = {
        scope: document.getElementById(`scope-${id}`),
        scopeFrame: document.getElementById(`scope-${id}`).parentElement,
        time: document.getElementById(`time-${id}`),
        dur: document.getElementById(`dur-${id}`),
        trackName: document.getElementById(`track-name-${id}`),
        playBtn: document.getElementById(`play-${id}`),
        loadBtn: document.getElementById(`load-${id}`),
        fileInput: document.getElementById(`file-${id}`),
        fader: document.getElementById(`fader-${id}`),
        vu: document.getElementById(`vu-${id}`).querySelector('.vu-fill'),
        platter: document.getElementById(`platter-${id}`),
      };

      this.scopeCtx = this.els.scope.getContext('2d');

      this.faderGain.gain.value = parseFloat(this.els.fader.value);

      this._bindUI();
    }

    _bindUI() {
      this.els.fader.addEventListener('input', () => {
        this.faderGain.gain.value = parseFloat(this.els.fader.value);
      });

      this.els.playBtn.addEventListener('click', () => this.togglePlay());

      this.els.loadBtn.addEventListener('click', () => this.els.fileInput.click());

      this.els.fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this.loadFile(file);
      });

      this.els.scopeFrame.addEventListener('pointerdown', (e) => {
        const rect = this.els.scope.getBoundingClientRect();
        const fraction = (e.clientX - rect.left) / rect.width;
        this.seekTo(fraction);
      });
    }

    async setBuffer(buffer, name) {
      const wasPlaying = this.playing;
      if (wasPlaying) this.stop();

      this.buffer = buffer;
      this.peaks = computePeaks(buffer, 200);
      this.offset = 0;
      this.els.trackName.textContent = name;
      this.els.dur.textContent = formatTime(buffer.duration);
      this.drawScope(0);

      if (wasPlaying) this.play();
    }

    async loadFile(file) {
      const arrayBuffer = await file.arrayBuffer();
      try {
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        const name = file.name.replace(/\.[^/.]+$/, '');
        await this.setBuffer(decoded, name);
      } catch (err) {
        this.els.trackName.textContent = 'Could not load file';
      }
    }

    currentOffset() {
      if (!this.playing || !this.buffer) return this.offset;
      const elapsed = (ctx.currentTime - this.startTime) * this.tempo;
      return (this.offset + elapsed) % this.buffer.duration;
    }

    play() {
      if (!this.buffer || this.playing) return;
      if (ctx.state === 'suspended') ctx.resume();

      const source = ctx.createBufferSource();
      source.buffer = this.buffer;
      source.loop = true;
      source.playbackRate.value = this.tempo;
      source.connect(this.trimGain);
      source.start(0, this.offset % this.buffer.duration);

      this.source = source;
      this.startTime = ctx.currentTime;
      this.playing = true;

      this.els.playBtn.textContent = '⏸';
      this.els.playBtn.classList.add('is-playing');
      this.els.platter.classList.add('spinning');
    }

    stop() {
      if (!this.playing) return;
      this.offset = this.currentOffset();
      this.source.stop();
      this.source.disconnect();
      this.source = null;
      this.playing = false;

      this.els.playBtn.textContent = '▶';
      this.els.playBtn.classList.remove('is-playing');
      this.els.platter.classList.remove('spinning');
    }

    togglePlay() {
      if (this.playing) this.stop();
      else this.play();
    }

    seekTo(fraction) {
      if (!this.buffer) return;
      const clamped = Math.min(1, Math.max(0, fraction));
      const wasPlaying = this.playing;
      if (wasPlaying) this.stop();
      this.offset = clamped * this.buffer.duration;
      if (wasPlaying) this.play();
      this.drawScope(clamped);
    }

    setTempo(rate) {
      this.tempo = rate;
      if (this.source) {
        this.offset = this.currentOffset();
        this.startTime = ctx.currentTime;
        this.source.playbackRate.value = rate;
      }
    }

    drawScope(playheadFraction) {
      const canvas = this.els.scope;
      const g = this.scopeCtx;
      const w = canvas.width;
      const h = canvas.height;
      const mid = h / 2;
      const accent = getComputedStyle(canvas.closest('.channel')).getPropertyValue('--accent').trim();

      g.clearRect(0, 0, w, h);

      if (!this.peaks.length) return;

      const barWidth = w / this.peaks.length;
      const playheadX = playheadFraction * w;

      // Dim pass: full waveform in a muted tone.
      g.fillStyle = 'rgba(238, 230, 216, 0.18)';
      this.peaks.forEach(([min, max], i) => {
        const x = i * barWidth;
        const yTop = mid + min * mid * 0.9;
        const yBottom = mid + max * mid * 0.9;
        g.fillRect(x, yBottom, Math.max(1, barWidth - 1), yTop - yBottom);
      });

      // Bright pass: only the portion already played, clipped.
      g.save();
      g.beginPath();
      g.rect(0, 0, playheadX, h);
      g.clip();
      g.fillStyle = accent || '#6dffb0';
      this.peaks.forEach(([min, max], i) => {
        const x = i * barWidth;
        const yTop = mid + min * mid * 0.9;
        const yBottom = mid + max * mid * 0.9;
        g.fillRect(x, yBottom, Math.max(1, barWidth - 1), yTop - yBottom);
      });
      g.restore();

      // Playhead line with a soft glow.
      g.strokeStyle = accent || '#6dffb0';
      g.shadowColor = accent || '#6dffb0';
      g.shadowBlur = 6;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(playheadX, 0);
      g.lineTo(playheadX, h);
      g.stroke();
      g.shadowBlur = 0;
    }

    updateVU() {
      this.analyser.getByteTimeDomainData(this.vuData);
      let sumSquares = 0;
      for (let i = 0; i < this.vuData.length; i++) {
        const norm = (this.vuData[i] - 128) / 128;
        sumSquares += norm * norm;
      }
      const rms = Math.sqrt(sumSquares / this.vuData.length);
      const level = this.playing ? Math.min(1, rms * 2.6) : 0;
      this.els.vu.style.height = `${100 - level * 100}%`;
    }

    tick() {
      if (this.buffer) {
        const fraction = this.buffer.duration ? this.currentOffset() / this.buffer.duration : 0;
        this.drawScope(fraction);
        this.els.time.textContent = formatTime(this.currentOffset());
      }
      this.updateVU();
    }
  }

  // ---------------------------------------------------------------
  // Knob widget — drag vertically to change value, rotates visually.
  // ---------------------------------------------------------------

  function makeKnob(el, { min, max, value, onChange }) {
    let current = value;

    function angleFor(v) {
      const fraction = (v - min) / (max - min);
      return -135 + fraction * 270;
    }

    function render() {
      el.style.transform = `rotate(${angleFor(current)}deg)`;
      el.setAttribute('aria-valuenow', Math.round(current * 100));
    }

    function setValue(v, notify = true) {
      current = Math.min(max, Math.max(min, v));
      render();
      if (notify) onChange(current);
    }

    let dragging = false;
    let startY = 0;
    let startValue = value;

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      startValue = current;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const delta = startY - e.clientY;
      const range = max - min;
      setValue(startValue + (delta / 140) * range);
    });

    el.addEventListener('pointerup', () => { dragging = false; });
    el.addEventListener('pointercancel', () => { dragging = false; });

    el.addEventListener('keydown', (e) => {
      const step = (max - min) / 40;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setValue(current + step); e.preventDefault(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setValue(current - step); e.preventDefault(); }
    });

    render();
    return { setValue, get value() { return current; } };
  }

  // ---------------------------------------------------------------
  // Wire everything up
  // ---------------------------------------------------------------

  const deckA = new Deck('a');
  const deckB = new Deck('b');

  makeKnob(document.getElementById('knob-gain-a'), {
    min: 0, max: 1.5, value: 1,
    onChange: (v) => { deckA.trimGain.gain.value = v; },
  });
  makeKnob(document.getElementById('knob-gain-b'), {
    min: 0, max: 1.5, value: 1,
    onChange: (v) => { deckB.trimGain.gain.value = v; },
  });

  makeKnob(document.getElementById('knob-tempo-a'), {
    min: 0.7, max: 1.3, value: 1,
    onChange: (v) => deckA.setTempo(v),
  });
  makeKnob(document.getElementById('knob-tempo-b'), {
    min: 0.7, max: 1.3, value: 1,
    onChange: (v) => deckB.setTempo(v),
  });

  makeKnob(document.getElementById('knob-master'), {
    min: 0, max: 1.2, value: 0.9,
    onChange: (v) => { masterGain.gain.value = v; },
  });
  masterGain.gain.value = 0.9;

  const crossfader = document.getElementById('crossfader');
  function applyCrossfade() {
    const t = (parseFloat(crossfader.value) + 1) / 2; // 0..1
    deckA.xfadeGain.gain.value = Math.cos(t * Math.PI / 2);
    deckB.xfadeGain.gain.value = Math.sin(t * Math.PI / 2);
  }
  crossfader.addEventListener('input', applyCrossfade);
  applyCrossfade();

  const masterVuFill = document.getElementById('vu-master').querySelector('.vu-fill');
  const masterVuData = new Uint8Array(masterAnalyser.fftSize);
  function updateMasterVU() {
    masterAnalyser.getByteTimeDomainData(masterVuData);
    let sumSquares = 0;
    for (let i = 0; i < masterVuData.length; i++) {
      const norm = (masterVuData[i] - 128) / 128;
      sumSquares += norm * norm;
    }
    const rms = Math.sqrt(sumSquares / masterVuData.length);
    const level = Math.min(1, rms * 2.6);
    masterVuFill.style.width = `${100 - level * 100}%`;
  }

  function loop() {
    deckA.tick();
    deckB.tick();
    updateMasterVU();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Load the two procedurally generated demo loops so the deck works
  // the instant the page opens — no external files required.
  Promise.all([renderDemoLoop('a'), renderDemoLoop('b')]).then(([bufferA, bufferB]) => {
    deckA.setBuffer(bufferA, 'Demo Loop — Pulse');
    deckB.setBuffer(bufferB, 'Demo Loop — Offbeat');
  });
})();
