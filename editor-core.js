'use strict';

// Pure timeline/project helpers shared by the browser editor and Node tests.
// A cut always refers to a time range in one locally selected source file.
(function attachEditorCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CutlineEditorCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function editorCore() {
  const MAX_CUTS = 12;
  const MAX_SOURCE_SECONDS = 12 * 60 * 60;
  const MIN_CUT_SECONDS = 0.1;
  const SPEEDS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2]);
  const PROJECT_FORMAT = 'cutline-project';
  const PROJECT_VERSION = 1;
  const CONTROL_RULES = Object.freeze({
    fit: ['cover', 'contain'],
    speed: SPEEDS,
    zoomStart: [50, 250], zoomEnd: [50, 250], panX: [-100, 100], panY: [-100, 100],
    brightness: [60, 150], contrast: [60, 170], saturation: [0, 180], vignette: [0, 100],
    titleSize: [18, 48], textStart: [0, 3600], textEnd: [0, 3600],
    subtitleStart: [0, 3600], subtitleEnd: [0, 3600],
    sourceVolume: [0, 100], musicVolume: [0, 100],
    fadeIn: [0, 0.5, 1, 2], fadeOut: [0, 0.5, 1, 2],
    audioFadeIn: [0, 0.5, 1, 2], audioFadeOut: [0, 0.5, 1, 2],
    titlePosition: ['top', 'center', 'bottom'], titleAnimation: ['none', 'fade', 'pop', 'slide'],
    titleFont: ['bold', 'condensed', 'serif', 'mono'], titleCase: ['upper', 'original'],
    transition: ['cut', 'fade'], exportQuality: ['balanced', '540', '720'],
  });
  const CONTINUOUS = new Set(['zoomStart','zoomEnd','panX','panY','brightness','contrast','saturation','vignette','titleSize','textStart','textEnd','subtitleStart','subtitleEnd','sourceVolume','musicVolume']);
  const BOOLEAN_FIELDS = new Set(['zoomAnimate', 'textBackplate', 'flipX']);
  const COLOR_FIELDS = new Set(['titleColor', 'accentColor']);
  const TEXT_FIELDS = Object.freeze({ headline:80, subtitle:100 });
  const ENUM_FIELDS = Object.freeze({ ratio:['portrait','square','wide'], tone:['clean','punch','warm','mono','custom'], rotation:[0,90,180,270] });
  function round(value) { return Math.round(value * 1000) / 1000; }
  function cut(input, sourceDuration = MAX_SOURCE_SECONDS) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const { start, end, speed } = input;
    if (![start, end, speed, sourceDuration].every(Number.isFinite) || start < 0 || sourceDuration <= 0 || sourceDuration > MAX_SOURCE_SECONDS || end > sourceDuration + 0.05 || !SPEEDS.includes(speed)) return null;
    const safeStart = round(start), safeEnd = round(Math.min(end, sourceDuration));
    if (safeEnd - safeStart < MIN_CUT_SECONDS - 1e-9) return null;
    const label = typeof input.label === 'string' ? input.label.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80) : '';
    return { start:safeStart, end:safeEnd, speed, label };
  }
  function cuts(input, sourceDuration = MAX_SOURCE_SECONDS) {
    if (!Array.isArray(input) || input.length > MAX_CUTS || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > MAX_SOURCE_SECONDS) return null;
    const result = input.map(item => cut(item, sourceDuration));
    return result.some(item => !item) ? null : result;
  }
  function sourceDuration(cutList) { return cutList.reduce((sum, item) => sum + item.end - item.start, 0); }
  function outputDuration(cutList) { return cutList.reduce((sum, item) => sum + (item.end - item.start) / item.speed, 0); }
  function clock(cutList, index, sourceTime) {
    if (!cutList.length) return { elapsed:0, remaining:0, total:0, progress:0, cutElapsed:0, cutRemaining:0 };
    const selected = Math.max(0, Math.min(cutList.length - 1, Number.isInteger(index) ? index : 0));
    const current = cutList[selected];
    const localSource = Math.max(0, Math.min(current.end - current.start, (Number.isFinite(sourceTime) ? sourceTime : current.start) - current.start));
    const local = localSource / current.speed;
    const elapsed = outputDuration(cutList.slice(0, selected)) + local;
    const total = outputDuration(cutList);
    return { elapsed, remaining:Math.max(0, total-elapsed), total, progress:total ? Math.min(1,elapsed/total) : 0, cutElapsed:local, cutRemaining:Math.max(0, (current.end-current.start)/current.speed-local) };
  }
  function locate(cutList, time) {
    if (!cutList.length || !Number.isFinite(time)) return null;
    let remaining = Math.max(0, Math.min(time, outputDuration(cutList)));
    for (let index = 0; index < cutList.length; index++) {
      const item = cutList[index], length = (item.end - item.start) / item.speed;
      if (remaining < length || index === cutList.length - 1) return { index, sourceTime:Math.min(item.end, item.start + remaining * item.speed) };
      remaining -= length;
    }
    return null;
  }
  function split(item, point) {
    if (!item || !Number.isFinite(point)) return null;
    const first = cut({ ...item, end:point });
    const second = cut({ ...item, start:point });
    return first && second ? [first, second] : null;
  }
  function project(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.format !== PROJECT_FORMAT || input.version !== PROJECT_VERSION) return null;
    const source = input.source;
    if (!source || typeof source.name !== 'string' || !source.name || source.name.length > 255 || !Number.isSafeInteger(source.size) || source.size < 1 || !Number.isFinite(source.duration) || source.duration <= 0 || source.duration > MAX_SOURCE_SECONDS) return null;
    const timeline = cuts(input.cuts, source.duration);
    if (!timeline || !input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) return null;
    const s = input.settings, settings = {};
    for (const [key, values] of Object.entries(CONTROL_RULES)) {
      const value = s[key];
      if (CONTINUOUS.has(key)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < values[0] || value > values[1]) return null;
      } else if (!values.includes(value)) return null;
      settings[key] = value;
    }
    for (const key of BOOLEAN_FIELDS) { if (typeof s[key] !== 'boolean') return null; settings[key] = s[key]; }
    for (const key of COLOR_FIELDS) { if (typeof s[key] !== 'string' || !/^#[\da-f]{6}$/i.test(s[key])) return null; settings[key] = s[key]; }
    for (const [key, limit] of Object.entries(TEXT_FIELDS)) { if (typeof s[key] !== 'string' || s[key].length > limit) return null; settings[key] = s[key]; }
    for (const [key, values] of Object.entries(ENUM_FIELDS)) { if (!values.includes(s[key])) return null; settings[key] = s[key]; }
    if (!Number.isFinite(s.trimIn) || !Number.isFinite(s.trimOut) || s.trimIn < 0 || s.trimOut > source.duration + 0.05 || s.trimOut - s.trimIn < MIN_CUT_SECONDS - 1e-9) return null;
    settings.trimIn = round(s.trimIn); settings.trimOut = round(Math.min(s.trimOut, source.duration));
    const audioName = typeof input.audioName === 'string' ? input.audioName.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0,255) : '';
    return { format:PROJECT_FORMAT, version:PROJECT_VERSION, source:{ name:source.name.replace(/[\x00-\x1f\x7f]/g, ' '), size:source.size, duration:source.duration }, cuts:timeline, settings, audioName };
  }
  return Object.freeze({ MAX_CUTS, MAX_SOURCE_SECONDS, MIN_CUT_SECONDS, SPEEDS, cut, cuts, split, sourceDuration, outputDuration, clock, locate, project });
});
