'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../editor-core');

function settings() {
  return { fit:'cover',speed:1,zoomStart:100,zoomEnd:150,panX:0,panY:0,brightness:100,contrast:100,saturation:100,vignette:0,titleSize:30,textStart:0,textEnd:0,subtitleStart:0,subtitleEnd:0,sourceVolume:100,musicVolume:24,fadeIn:0,fadeOut:0,audioFadeIn:0,audioFadeOut:0,titlePosition:'bottom',titleAnimation:'none',titleFont:'bold',titleCase:'upper',transition:'cut',exportQuality:'balanced',zoomAnimate:false,textBackplate:true,flipX:false,titleColor:'#ffffff',accentColor:'#c8f276',headline:'Big play',subtitle:'Context',ratio:'portrait',tone:'clean',rotation:0,trimIn:0,trimOut:5 };
}
function project() { return {format:'cutline-project',version:1,source:{name:'source.mp4',size:12345,duration:10},cuts:[{start:0,end:2,speed:1,label:'Opening'},{start:7,end:9,speed:0.5,label:'Play'}],settings:settings(),audioName:'music.wav'}; }

test('timeline validates bounded source ranges and safe speeds', () => {
  assert.deepEqual(editor.cut({start:1,end:3,speed:0.5,label:' big play '},10),{start:1,end:3,speed:0.5,label:'big play'});
  for (const item of [{start:-1,end:3,speed:1},{start:1,end:1,speed:1},{start:1,end:11,speed:1},{start:1,end:3,speed:5},{start:'1',end:3,speed:1},{start:Infinity,end:3,speed:1}]) assert.equal(editor.cut(item,10),null);
  assert.equal(editor.cuts(Array(13).fill({start:0,end:1,speed:1}),10),null);
  assert.equal(editor.cuts([],NaN),null);
  assert.equal(editor.cuts([],0),null);
});

test('timeline clocks and seeks reflect reordering and per-cut speed', () => {
  const parts = [{start:8,end:10,speed:0.5},{start:1,end:4,speed:1.5}];
  assert.equal(editor.sourceDuration(parts),5); assert.equal(editor.outputDuration(parts),6);
  assert.deepEqual(editor.clock(parts,1,2.5),{elapsed:5,remaining:1,total:6,progress:5/6,cutElapsed:1,cutRemaining:1});
  assert.deepEqual(editor.locate(parts,5),{index:1,sourceTime:2.5});
  assert.deepEqual(editor.locate(parts,4),{index:1,sourceTime:1});
  assert.deepEqual(editor.locate(parts,99),{index:1,sourceTime:4});
  assert.equal(editor.locate([],0),null);
});

test('splitting respects boundary lengths and preserves speed', () => {
  assert.deepEqual(editor.split({start:2,end:5,speed:0.75,label:'Play'},3),[{start:2,end:3,speed:0.75,label:'Play'},{start:3,end:5,speed:0.75,label:'Play'}]);
  assert.equal(editor.split({start:2,end:5,speed:1},2.02),null);
  assert.equal(editor.split({start:2,end:5,speed:1},5),null);
});

test('project files validate source, timeline and all settings without importing unknown fields', () => {
  const good=project(); good.extra='ignored'; good.settings.injected='ignored';
  const parsed=editor.project(good); assert.equal(parsed.cuts.length,2); assert.equal(parsed.settings.headline,'Big play');
  assert.equal(parsed.extra,undefined); assert.equal(parsed.settings.injected,undefined);
  for (const alter of [
    p=>p.version=2, p=>p.source.size=0, p=>p.source.duration=Infinity, p=>p.cuts[1].end=11,
    p=>p.cuts[0].speed=100, p=>p.settings.titleColor='javascript:alert(1)', p=>p.settings.zoomStart=999,
    p=>p.settings.trimOut=11, p=>p.settings.headline='x'.repeat(81), p=>p.settings.transition='crossfade',
  ]) { const value=project(); alter(value); assert.equal(editor.project(value),null); }
});
