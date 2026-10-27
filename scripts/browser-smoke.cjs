'use strict';
// Optional real-browser regression: requires puppeteer-core, Chromium and ffmpeg.
// See README.md for how to provide CHROME_PATH, FFMPEG_PATH and NODE_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { createServer } = require('../server');

const chrome = process.env.CHROME_PATH;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
if (!chrome) throw new Error('Set CHROME_PATH to a Chromium/Chrome executable.');
function run(args, options={}) {
  const result=spawnSync(ffmpeg,args,{maxBuffer:128*1024*1024,...options});
  if (result.error || result.status!==0) throw new Error(`ffmpeg failed: ${result.error || String(result.stderr)}`);
  return result.stdout;
}
function frequency(samples, start, freq, seconds=.22) {
  const rate=48000, begin=Math.floor(start*rate), count=Math.floor(seconds*rate), factor=2*Math.cos(2*Math.PI*freq/rate);
  assert.ok(samples.length>=begin+count, 'exported audio is too short');
  let previous=0, before=0;
  for (let i=begin;i<begin+count;i++) { const value=samples[i]+factor*previous-before; before=previous; previous=value; }
  return Math.sqrt(previous*previous+before*before-factor*previous*before)/count;
}
const youtube='https://www.youtube.com/watch?v=9hE5-98ZeCg';
const clips=[
  {label:'Red opening',startSeconds:.2,endSeconds:1.2,reason:'Mock red scene',overlay:'OPEN'},
  {label:'Blue finish',startSeconds:4.2,endSeconds:5.2,reason:'Mock blue scene',overlay:'FINISH'},
  {label:'Green middle',startSeconds:2.2,endSeconds:3.2,reason:'Mock green scene',overlay:'MIDDLE'},
];

async function main() {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cutline-browser-'));
  const source=path.join(temp,'scenes.webm'), music=path.join(temp,'music.wav');
  run(['-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','color=c=red:s=320x180:r=24:d=2',
    '-f','lavfi','-i','color=c=green:s=320x180:r=24:d=2',
    '-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=2',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2',
    '-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=2',
    '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2',
    '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]',
    '-map','[v]','-map','[a]','-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-b:v','400k','-c:a','libopus','-b:a','64k',source]);
  run(['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=2',music]);
  const password='browser-test-password-42';
  let clock=100000, aborted=0;
  const requests=[];
  const server=createServer({
    env:{CUTLINE_ACCESS_PASSWORD:password,CUTLINE_AI_ENABLED:'true',GEMINI_API_KEY:'mock-key'},
    now:()=>{clock+=6000; return clock;},
    fetchImpl:async (url,options) => {
      const body=JSON.parse(options.body); requests.push(body);
      if (JSON.stringify(body).includes('Slow test request')) {
        return new Promise((resolve,reject) => {
          const stop=() => { aborted++; const error=new Error('aborted'); error.name='AbortError'; reject(error); };
          if (options.signal.aborted) stop(); else options.signal.addEventListener('abort',stop,{once:true});
        });
      }
      const editRecipe={headline:'AI HOOK',colorPreset:'warm',zoomStart:120,zoomEnd:140,animateZoom:true,speed:1.25,unsupported:'ignore'};
      return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({answer:'Mock summary; verify all details.',clips,editRecipe})}]}}]}),{status:200,headers:{'Content-Type':'application/json'}});
    },
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage(), errors=[], dialogs=[];
    let rejectNextDialog=false;
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>{ dialogs.push(dialog.message()); if (rejectNextDialog) { rejectNextDialog=false; dialog.dismiss(); } else dialog.accept(); });
    await page.setViewport({width:1360,height:900}); await page.authenticate({username:'cutline',password});
    await page.goto(base,{waitUntil:'networkidle0'});
    const set=async(id,value,type='input') => page.evaluate(({id,value,type})=>{const el=document.getElementById(id); if(el.type==='checkbox')el.checked=value;else el.value=String(value); el.dispatchEvent(new Event(type,{bubbles:true}));},{id,value,type});
    await page.click('.sidebar [data-view="coach"]');
    await page.waitForFunction(()=>!document.querySelector('#coach-test').disabled);
    await set('chat-input',youtube);
    await page.evaluate(()=>[...document.querySelectorAll('.welcome-message button')].find(el=>el.textContent==='Find highlight moments').click());
    assert.match(await page.$eval('#chat-input',el=>el.value),/Find up to four.*[\s\S]*youtube\.com/);
    assert.equal(requests.length,0,'prompt shortcut contacted provider');
    await set('chat-input','');
    await set('coach-video-url',youtube);
    await page.click('#coach-test');
    await page.waitForFunction(()=>document.querySelector('#coach-test-status').textContent.includes('replied'));
    assert.equal(requests.length,1); assert.ok(!JSON.stringify(requests[0]).includes(youtube));
    assert.ok(!JSON.stringify(requests[0]).includes('file_data'));
    console.log('PASS: explicitly confirmed AI connection test excludes chat and video');

    await set('chat-input','Summarize the video and suggest moments.');
    await page.click('#coach-send');
    assert.equal(requests.length,1, 'provider contacted before consent');
    assert.match(await page.$eval('#coach-consent-intro',el=>el.textContent),/link in the attachment field/i);
    await page.click('#coach-consent'); await page.click('#confirm-coach');
    await page.waitForFunction(()=>[...document.querySelectorAll('.clip-suggestions button')].some(el=>el.textContent.includes('Build timeline')));
    assert.equal(requests[1].contents[0].parts[0].file_data.file_uri,youtube);
    await (await page.$('#video-file')).uploadFile(source);
    await page.waitForFunction(()=>document.querySelector('#editor-player').readyState>=2);
    await page.evaluate(()=>[...document.querySelectorAll('.clip-suggestions button')].find(el=>el.textContent.includes('Build timeline')).click());
    await page.waitForFunction(()=>document.querySelectorAll('.cut-row').length===3);
    assert.match(await page.$eval('#editor-suggestion-status',el=>el.textContent),/approximate AI moments/i);
    console.log('PASS: consented video follow-up and explicit AI-to-timeline handoff');

    // The proposed look is only applied after the user reviews it; a speed
    // suggestion updates just the selected cut and remains undoable.
    await page.click('.sidebar [data-view="coach"]');
    await page.waitForFunction(()=>[...document.querySelectorAll('.message-actions button')].some(el=>el.textContent.includes('Gemini edit recipe')));
    const beforeHeadline=await page.$eval('#overlay-input',el=>el.value);
    rejectNextDialog=true;
    await page.evaluate(()=>[...document.querySelectorAll('.message-actions button')].find(el=>el.textContent.includes('Gemini edit recipe')).click());
    assert.equal(await page.$eval('#overlay-input',el=>el.value),beforeHeadline);
    assert.match(await page.$eval('.cut-row:first-child .cut-select',el=>el.textContent),/· 1×/);
    await page.evaluate(()=>[...document.querySelectorAll('.message-actions button')].find(el=>el.textContent.includes('Gemini edit recipe')).click());
    assert.ok(dialogs.some(text=>text.includes('Gemini suggested') && text.includes('only the selected timeline cut')));
    assert.equal(await page.$eval('#overlay-input',el=>el.value),'AI HOOK');
    assert.match(await page.$eval('.cut-row:first-child .cut-select',el=>el.textContent),/1\.25×/);
    await page.click('#undo-cuts');
    assert.match(await page.$eval('.cut-row:first-child .cut-select',el=>el.textContent),/· 1×/);
    await page.click('.preset-button[data-preset="clean"]'); await set('overlay-input','');
    await set('zoom-start',100); await set('zoom-end',100); await set('zoom-animate',false,'change');
    console.log('PASS: Gemini edit recipe review, application and selected-cut speed undo');

    // Refine a suggestion only after explicit 3-FPS/range consent.
    await page.click('.sidebar [data-view="coach"]');
    await page.evaluate(()=>[...document.querySelectorAll('.clip-suggestions button')].find(el=>el.textContent==='Take a closer look').click());
    assert.equal(await page.$eval('#coach-focus',el=>el.checked),true);
    assert.equal(await page.$eval('#coach-focus-start',el=>el.value),'0:00');
    assert.equal(await page.$eval('#coach-focus-end',el=>el.value),'0:05');
    await set('coach-focus-end','2:00'); await page.click('#coach-send');
    assert.equal(requests.length,2,'invalid range reached provider');
    assert.equal(await page.$eval('#coach-consent-modal',el=>el.hidden),true);
    await set('coach-focus-end','0:05'); await page.$eval('#coach-send',el=>el.click());
    await page.waitForFunction(()=>!document.querySelector('#coach-consent-modal').hidden);
    assert.match(await page.$eval('#coach-consent-extras',el=>el.textContent),/0:00–0:05.*3 sampled frames/);
    assert.equal(requests.length,2,'focused video sent without consent');
    await page.click('#coach-consent'); await page.click('#confirm-coach');
    await page.waitForFunction(()=>document.querySelector('#chat-messages').textContent.includes('focused 3 FPS'));
    assert.deepEqual(requests[2].contents[0].parts[0].video_metadata,{start_offset:'0s',end_offset:'5s',fps:3});
    await set('coach-focus',false,'change');
    console.log('PASS: bounded focused-video refinement requires consent and forwards 3 FPS');
    await page.click('.sidebar [data-view="editor"]');

    await page.$eval('.cut-row:nth-child(3) [aria-label="Move cut earlier 3"]',el=>el.click());
    await set('playback-speed',1.25,'change'); await page.click('#update-cut');
    await page.$eval('.cut-row:nth-child(3) .cut-select',el=>el.click());
    await set('playback-speed',.5,'change'); await page.click('#update-cut');
    const rows=await page.$$eval('.cut-row',items=>items.map(item=>item.textContent));
    assert.match(rows[0],/Red opening/); assert.match(rows[1],/Green middle/); assert.match(rows[2],/Blue finish/);
    assert.match(await page.$eval('#timeline-duration',el=>el.textContent),/3\.8s/);
    await page.evaluate(async()=>{const video=document.querySelector('#editor-player');await new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=4.7;});});
    await page.click('#split-cut'); assert.equal((await page.$$('.cut-row')).length,4);
    await page.click('#undo-cuts'); assert.equal((await page.$$('.cut-row')).length,3);
    await page.click('#redo-cuts'); assert.equal((await page.$$('.cut-row')).length,4);
    await page.click('#undo-cuts');
    await page.$eval('.cut-row:nth-child(3) [aria-label="Duplicate cut 3"]',el=>el.click());
    assert.equal((await page.$$('.cut-row')).length,4);
    await page.$eval('.cut-row:nth-child(4) [aria-label="Remove cut 4"]',el=>el.click());
    assert.equal((await page.$$('.cut-row')).length,3);
    console.log('PASS: reorder, update speed, split, undo/redo, duplicate and remove');
    const seek=async time=>page.evaluate(async time=>{const video=document.querySelector('#editor-player');if(Math.abs(video.currentTime-time)>.002)await new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=time;});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},time);
    const center=()=>page.evaluate(()=>{const canvas=document.querySelector('#editor-preview-canvas');return [...canvas.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data].slice(0,3);});
    await page.$eval('.cut-row:nth-child(2) .cut-select',el=>el.click());
    await set('cut-transition','fade','change'); await seek(2.21); const dark=await center(); await seek(2.7); const lit=await center();
    assert.ok(lit[1]>dark[1]+40,`fade-through-black not visible: ${dark} → ${lit}`);
    await set('cut-transition','cut','change'); await set('overlay-input','MiXeD'); await set('title-color','#ff00ff');
    await set('title-font','serif','change'); await set('title-case','original','change');
    const readPixels=()=>page.evaluate(()=>{const c=document.querySelector('#editor-preview-canvas');return [...c.getContext('2d').getImageData(0,0,c.width,c.height).data];});
    const mixed=await readPixels(); await set('title-case','upper','change'); const uppercase=await readPixels();
    let changed=0; for(let i=0;i<mixed.length;i+=4) if(Math.abs(mixed[i]-uppercase[i])>30 || Math.abs(mixed[i+1]-uppercase[i+1])>30) changed++;
    assert.ok(changed>20,`text case did not change rendered text: ${changed} pixels`);
    await set('overlay-input',''); await set('subtitle-input','SUPPORTING LINE'); await set('accent-color','#ff00ff');
    await set('subtitle-start',.6); await set('subtitle-end',1.4);
    const magenta=values=>{let count=0;for(let i=0;i<values.length;i+=4)if(values[i]>170 && values[i+1]<100 && values[i+2]>170)count++;return count;};
    await page.$eval('.cut-row:nth-child(1) .cut-select',el=>el.click());
    await seek(.4); const before=magenta(await readPixels()); await seek(.95); const during=magenta(await readPixels());
    await page.$eval('.cut-row:nth-child(2) .cut-select',el=>el.click()); await seek(2.85); const after=magenta(await readPixels());
    assert.ok(during>before+20 && during>after+20,`supporting-line timing incorrect: ${before}, ${during}, ${after}`);
    console.log('PASS: fade-through-black, font/case rendering and independently timed supporting text');

    await set('overlay-input',''); await set('subtitle-input',''); await set('music-volume',30);
    await (await page.$('#music-file')).uploadFile(music);
    await page.evaluate(()=>{const original=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.type==='application/json')window.__projectBlob=blob;return original(blob);};});
    await page.click('#save-project');
    const projectText=await page.evaluate(()=>window.__projectBlob.text());
    const project=JSON.parse(projectText); assert.equal(project.cuts.length,3); assert.equal(project.audioName,'music.wav');
    assert.ok(projectText.length<10000); assert.doesNotMatch(projectText,/mock-key|data:video|base64/i);
    const projectPath=path.join(temp,'project.json'); await fs.writeFile(projectPath,projectText);
    await page.click('#remove-music'); await page.click('#clear-cuts'); assert.equal((await page.$$('.cut-row')).length,0);
    await (await page.$('#project-file')).uploadFile(projectPath);
    await page.waitForFunction(()=>document.querySelectorAll('.cut-row').length===3);
    assert.match(await page.$eval('#project-status',el=>el.textContent),/Re-add.*music\.wav/);
    const invalid=JSON.parse(projectText); invalid.cuts[0].end=99999;
    const invalidPath=path.join(temp,'invalid.json'); await fs.writeFile(invalidPath,JSON.stringify(invalid));
    await (await page.$('#project-file')).uploadFile(invalidPath);
    await page.waitForFunction(()=>document.querySelector('#project-status').textContent.includes('invalid'));
    assert.equal((await page.$$('.cut-row')).length,3);
    const renamedSource=path.join(temp,'renamed-source.webm'); await fs.copyFile(source,renamedSource);
    await (await page.$('#video-file')).uploadFile(renamedSource);
    await page.waitForFunction(()=>document.querySelector('#editor-file-label').textContent.includes('renamed-source.webm') && document.querySelector('#editor-player').readyState>=2);
    await (await page.$('#project-file')).uploadFile(projectPath);
    await page.waitForFunction(()=>document.querySelectorAll('.cut-row').length===3);
    assert.ok(dialogs.some(message=>message.includes('does not match the saved filename, size or duration')));
    console.log('PASS: validated project save/reopen, relinking warnings and invalid-file rejection');
    await (await page.$('#music-file')).uploadFile(music);
    await page.waitForFunction(()=>document.querySelector('#music-label').textContent==='music.wav');

    await page.click('#preview-timeline');
    await page.waitForFunction(()=>document.querySelector('#preview-timeline').textContent.includes('Stop'));
    await page.waitForFunction(()=>document.querySelector('#preview-timeline').textContent.includes('Preview'),{timeout:15000});
    await page.click('#editor-export');
    await page.waitForFunction(()=>!document.querySelector('#export-result').hidden || /discarded|could not/i.test(document.querySelector('#export-status').textContent),{timeout:30000});
    const captured=await page.evaluate(async()=>{const link=document.querySelector('#export-result a[download]');if(!link)return null;const bytes=new Uint8Array(await(await fetch(link.href)).arrayBuffer());let data='';for(let i=0;i<bytes.length;i+=32768)data+=String.fromCharCode(...bytes.subarray(i,i+32768));return {name:link.download,base64:btoa(data)};});
    assert.ok(captured,'browser did not produce an export');
    const output=path.join(temp,captured.name); await fs.writeFile(output,Buffer.from(captured.base64,'base64'));
    const frames=run(['-hide_banner','-loglevel','error','-i',output,'-an','-vf','tpad=stop_mode=clone:stop_duration=3,fps=10,scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-']);
    const pixel=time=>{const index=Math.floor(time*10)*3; assert.ok(frames.length>=index+3,'exported video is too short'); return [...frames.subarray(index,index+3)];};
    const first=pixel(.1), red=pixel(.55), green=pixel(1.65), blue=pixel(3.0);
    assert.ok(first[0]>first[1]*2 && first[0]>first[2]*2,`wrong initial frame: ${first}`);
    assert.ok(red[0]>red[1]*2 && red[0]>red[2]*2,`red cut missing: ${red}`);
    assert.ok(green[1]>green[0]*2 && green[1]>green[2]*2,`green cut missing: ${green}`);
    assert.ok(blue[2]>blue[0]*2 && blue[2]>blue[1]*2,`blue cut missing: ${blue}`);
    const pcm=run(['-hide_banner','-loglevel','error','-i',output,'-vn','-ac','1','-ar','48000','-f','s16le','-']);
    const samples=new Int16Array(pcm.buffer,pcm.byteOffset,Math.floor(pcm.length/2));
    for (const [time,expected] of [[.55,440],[1.65,660],[3.0,880]]) {
      const levels=[440,660,880].map(freq=>frequency(samples,time,freq));
      assert.ok(levels[[440,660,880].indexOf(expected)]>500 && levels[[440,660,880].indexOf(expected)]>Math.max(...levels.filter((_,index)=>[440,660,880][index]!==expected))*3,`incorrect audio at ${time}s: ${levels}`);
      assert.ok(frequency(samples,time,220)>200,`added audio missing at ${time}s`);
    }
    console.log(`PASS: actual rendered ${captured.name} has red→green→blue video, synchronized source audio and added music`);

    await page.click('#editor-export'); await page.waitForFunction(()=>!document.querySelector('#export-progress').hidden && !document.querySelector('#cancel-export').hidden);
    assert.equal(await page.$eval('#add-cut',el=>el.disabled),true);
    await page.click('#cancel-export');
    await page.waitForFunction(()=>/cancelled/i.test(document.querySelector('#export-status').textContent));
    assert.equal(await page.$eval('#add-cut',el=>el.disabled),false);
    console.log('PASS: export locking and cancellation');
    await page.click('#clear-cuts'); await set('trim-in',0); await set('trim-out',5.9); await set('playback-speed',.5,'change');
    await page.click('#add-cut');
    for (let i=0;i<5;i++) await page.$eval('.cut-row:first-child [aria-label="Duplicate cut 1"]',el=>el.click());
    assert.match(await page.$eval('#timeline-note',el=>el.textContent),/shorten the sequence/i);
    await page.click('#editor-export');
    await page.waitForFunction(()=>/Shorten the timeline/.test(document.querySelector('#export-status').textContent));
    assert.equal(await page.$eval('#add-cut',el=>el.disabled),false);
    console.log('PASS: excessive planned duration is rejected before recording');

    await page.click('.sidebar [data-view="coach"]'); await set('coach-video-url',''); await set('chat-input','Slow test request');
    await page.click('#coach-send'); await page.click('#coach-consent'); await page.click('#confirm-coach');
    await page.waitForFunction(()=>!document.querySelector('#coach-cancel').hidden);
    await page.waitForFunction(()=>document.querySelector('#coach-send').disabled);
    await page.click('#coach-cancel'); await page.waitForFunction(()=>document.querySelector('#coach-cancel').hidden);
    await new Promise(resolve=>setTimeout(resolve,100)); assert.equal(aborted,1);
    assert.match(await page.$eval('#chat-messages',el=>el.textContent),/Request canceled/i);
    console.log('PASS: AI request cancellation aborts the mock provider');

    await page.setViewport({width:320,height:844,isMobile:true,hasTouch:true});
    await page.evaluate(()=>document.querySelector('.mobile-nav [data-view="editor"]').click());
    const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
    assert.ok(dimensions.scroll<=dimensions.client+1,`mobile editor overflow: ${JSON.stringify(dimensions)}`);
    await page.evaluate(()=>document.querySelector('.mobile-nav [data-view="coach"]').click());
    await set('coach-focus',true,'change');
    const coachDimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,
      offenders:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1 || (el.clientWidth>0 && el.scrollWidth>el.clientWidth+1)).slice(0,30).map(el=>({tag:el.tagName,id:el.id,cls:String(el.className),left:Math.round(el.getBoundingClientRect().left),right:Math.round(el.getBoundingClientRect().right),scroll:el.scrollWidth,client:el.clientWidth,overflow:getComputedStyle(el).overflowX,text:el.textContent.slice(0,80)}))}));
    assert.ok(coachDimensions.scroll<=coachDimensions.client+1,`mobile Coach overflow: ${JSON.stringify(coachDimensions)}`);
    assert.equal(await page.$eval('#coach-focus-fields',el=>el.hidden),false);
    assert.deepEqual(errors,[]);
    console.log('PASS: narrow phone editor and focused-Coach layout without browser errors');
  } finally {
    await browser.close(); await new Promise(resolve=>server.close(resolve));
    if (process.env.KEEP_BROWSER_ARTIFACTS === '1') console.log(`Browser artifacts: ${temp}`);
    else await fs.rm(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
