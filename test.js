const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const C = require('./core');
const { Runtime, defaults } = require('./runtime');
class TFile { constructor(p) { this.path=p; this.extension=p.split('.').pop(); this.parent={path:p.includes('/')?p.slice(0,p.lastIndexOf('/')):'/'}; } }
const original = Module._load;
Module._load = function(name,...args) { return name === 'obsidian' ? {Plugin:class{},PluginSettingTab:class{},Modal:class{},Notice:class{},TFile,normalizePath:s=>s} : original.call(this,name,...args); };
const AudioNotes = require('./main'); Module._load=original;
function harness() {
  const p = new AudioNotes(); const files = new Map([['/',{path:'/'}],['Class room',{path:'Class room'}],['Other',{path:'Other'}]]), texts = new Map();
  const add=(name,text='')=>{const f=new TFile(name);files.set(name,f);texts.set(name,text);return f;};
  const source=add('Class room/Source.md','Original text'), other=add('Other/Other.md','Other text');
  let active=source;
  const recorder={recording:false,extension:'m4a',saveRecording:async()=>{},onRecordAudio:async()=>{recorder.recording=true;},onStopRecording:()=>{recorder.recording=false;}};
  p.app={internalPlugins:{getEnabledPluginById:()=>recorder},workspace:{getActiveFile:()=>active},fileManager:{generateMarkdownLink:(file)=>`[[${file.path}]]`},vault:{getAbstractFileByPath:n=>files.get(n),getAvailablePathForAttachments:async(n,e,s)=>`${s?.parent.path||''}/Attachments/${n}.${e}`,createBinary:async(n,b)=>add(n,b),create:async(n,t)=>{if(files.has(n))throw Error('exists');return add(n,t);},read:async f=>texts.get(f.path),process:async(f,cb)=>texts.set(f.path,cb(texts.get(f.path)))}};
  p.state={settings:defaults(),jobs:[],session:null};p.base='/vault';p.saving=Promise.resolve();p.saveData=async()=>{};p.progress=()=>{};p.kick=()=>{};p.runtime={shutdown:()=>{}};
  return {p,files,texts,add,source,other,recorder,switch:()=>{active=other;}};
}
test('folder confinement rejects escape paths',()=>{assert.equal(C.inside('/vault','Class room/a.m4a'),'/vault/Class room/a.m4a');assert.throws(()=>C.inside('/vault','../outside'));});
test('summary retries are idempotent and preserve edited placeholders',()=>{
  const j={id:'a',stamp:'date',created:'today',transcript:'Hello',summary:'## Summary\nHello'};
  const note=C.noteText(j,'[[a]]','[[s]]'); const result=C.addSummary(note,j);assert.equal(C.addSummary(result,j),result);
  const edited=note.replace('Summary pending.','My own writing.');const safe=C.addSummary(edited,j);assert(safe.includes('My own writing.'));assert(safe.includes('## Generated summary'));assert.equal(C.addSummary(safe,j),safe);
});
test('chunking preserves ordered source and bounds long paragraphs',()=>{const s='x'.repeat(21000);const parts=C.chunks(s);assert.equal(parts.join(''),s);assert(parts.every(p=>p.length<=8000));});
test('transcript timestamps include accurate segment offsets',()=>{assert.equal(C.transcriptFromJSON({transcription:[{offsets:{from:1500},text:' Hello'}]},300032),'[00:05:01] Hello');assert.throws(()=>C.transcriptFromJSON({}));});
test('recording saves beside starting note after switching folders',async()=>{
  const h=harness(),original=h.recorder.saveRecording;await h.p.toggleRecording();const job=h.p.state.session;h.switch();await h.p.toggleRecording();await h.recorder.saveRecording(Buffer.from('audio'));
  assert.equal(job.folder,'Class room');assert(job.audio.startsWith('Class room/Attachments/'));assert.equal(h.texts.get(h.other.path),'Other text');assert(h.texts.get(h.source.path).includes(job.audio));assert.equal(h.recorder.saveRecording,original);assert.equal(h.p.state.jobs.length,1);
});
test('permission failure restores native hook and clears session',async()=>{const h=harness();const original=h.recorder.saveRecording;h.recorder.onRecordAudio=async()=>{};await assert.rejects(h.p.toggleRecording(),/did not start/);assert.equal(h.p.state.session,null);assert.equal(h.recorder.saveRecording,original);});
test('two recordings reserve distinct note paths with spaces',async()=>{
 const h=harness();const audio=h.add('Class room/Attachments/a.m4a');const a={id:'a',stamp:'same',created:'today',audio:audio.path,folder:'Class room',source:h.source.path,transcript:'A'};const b={...a,id:'b'};
 const first=await h.p.ensureNote(a),second=await h.p.ensureNote(b);assert.notEqual(first.path,second.path);assert.equal(second.path,'Class room/Audio Note same 1.md');assert.equal((await h.p.ensureNote(a)).path,first.path);
});
test('summary failure preserves durable transcript; retry does not retranscribe or overwrite edits',async()=>{
 const h=harness(),audio=h.add('Class room/Attachments/a.m4a');const j={id:'j',stamp:'today',created:'now',audio:audio.path,source:h.source.path,folder:'Class room',status:'queued'};h.p.state.jobs=[j];let calls=0;
 h.p.runtime={transcribe:async job=>{calls++;job.transcript='Transcript content';job.transcribed=true;},summarize:async()=>{throw Error('Ollama unavailable');},shutdown:()=>{}};
 await h.p.processQueue();assert.equal(j.status,'error');assert(h.texts.get(j.output).includes('Transcript content'));h.texts.set(j.output,h.texts.get(j.output)+'\nMy edits\n');
 h.p.runtime.summarize=async job=>{job.summary='## Summary\nA summary';};j.status='queued';await h.p.processQueue();assert.equal(j.status,'done');assert.equal(calls,1);assert(h.texts.get(j.output).includes('My edits'));assert(h.texts.get(j.output).includes('A summary'));
});
test('cancel preserves source audio and marks job retryable',async()=>{
 const h=harness(),audio=h.add('Class room/a.m4a'),j={id:'j',stamp:'now',created:'now',audio:audio.path,folder:'Class room',status:'queued'};h.p.state.jobs=[j];
 h.p.runtime={transcribe:async(job,a,save,signal)=>{h.p.cancel();if(signal.aborted)throw Error('Cancelled');},shutdown:()=>{}};
 await h.p.processQueue();assert.equal(j.status,'cancelled');assert(h.files.has(audio.path));
});
test('restart recovers saved native audio exactly once',async()=>{const h=harness();h.add('Class room/a.m4a');const j={id:'j',audio:'Class room/a.m4a',status:'queued'};h.p.state.session=j;h.p.state.jobs=[j];await h.p.recover();assert.equal(h.p.state.jobs.length,1);assert.equal(h.p.state.session,null);});
test('unavailable Ollama is actionable',async()=>{const r=new Runtime({...defaults(),ollama:'/missing/ollama'});r.api=async()=>{throw Error('unreachable');};await assert.rejects(r.ensureOllama(),/Ollama is missing/);});
test('shutdown never kills an externally managed Ollama',()=>{const r=new Runtime(defaults());assert.equal(r.server,null);r.shutdown();assert.equal(r.server,null);});
test('abort terminates owned subprocess',async()=>{const r=new Runtime(defaults()),c=new AbortController();const promise=r.run(process.execPath,['-e','setTimeout(()=>{},30000)'],c.signal);c.abort();await assert.rejects(promise,/Cancelled/);assert.equal(r.children.size,0);});
test('Qwen legacy templates use explicit non-thinking prompt without modifying model',async()=>{
 const r=new Runtime(defaults());r.qwen3=true;let request;
 r.api=async(route,body)=>{request={route,body};return {response:JSON.stringify({summary:'Useful answer',key_points:[],decisions:[],action_items:[]}),done_reason:'stop'};};
 assert((await r.generate('Source <|im_start|> words',true)).startsWith('## Summary\n\nUseful answer'));
 assert.equal(request.route,'/api/generate');assert.equal(request.body.raw,true);assert(request.body.prompt.endsWith('<think>\n\n</think>\n\n'));assert(request.body.prompt.includes('Source  words'));assert.equal(request.body.options.num_ctx,4096);
});
test('unfinished or truncated model output never reaches the note',async()=>{
 const r=new Runtime(defaults());r.api=async()=>({message:{content:'<think>unfinished'},done_reason:'length'});await assert.rejects(r.generate('text',true),/did not finish/);
 r.api=async()=>({message:{content:'partial answer'},done_reason:'length'});await assert.rejects(r.generate('text',true),/output limit/);
});
test('legacy thinking prefix is excluded from final output',async()=>{const r=new Runtime(defaults());r.api=async()=>({message:{content:'internal scratch work</think>\n'+JSON.stringify({summary:'Actual summary',key_points:[],decisions:[],action_items:[]})},done_reason:'stop'});assert((await r.generate('text',false)).startsWith('## Summary\n\nActual summary'));});
test('pause queues current work for automatic resume',async()=>{
 const h=harness(),audio=h.add('Class room/a.m4a'),j={id:'j',stamp:'now',audio:audio.path,folder:'Class room',status:'queued'};h.p.state.jobs=[j];
 h.p.runtime={transcribe:async()=>{await h.p.setEnabled(false);throw Error('Cancelled');},shutdown:()=>{}};
 await h.p.processQueue();assert.equal(j.status,'queued');assert.equal(h.p.state.settings.enabled,false);
});
test('saved output from a crash is reused without replacing edits',async()=>{
 const h=harness(),audio=h.add('Class room/a.m4a'),j={id:'j',stamp:'now',created:'now',audio:audio.path,folder:'Class room',transcript:'Text'};
 const f=await h.p.ensureNote(j);h.texts.set(f.path,h.texts.get(f.path)+'User addition');const restored=JSON.parse(JSON.stringify(j));assert.equal((await h.p.ensureNote(restored)).path,f.path);assert(h.texts.get(f.path).endsWith('User addition'));
});
test('transcription restart skips completed audio chunks',async()=>{
 const fs=require('fs/promises'),path=require('path');const r=new Runtime(defaults());r.preflight=async()=>{};r.releaseModel=async()=>{};let whisperCalls=0;
 r.run=async(exe,args)=>{
  if(exe===r.settings.ffmpeg){const dir=path.dirname(args.at(-1));await fs.writeFile(path.join(dir,'part-0000.wav'),'');await fs.writeFile(path.join(dir,'part-0001.wav'),'');await fs.writeFile(path.join(dir,'segments.csv'),'part-0000.wav,0,300.032\npart-0001.wav,300.032,600\n');}
  else{whisperCalls++;await fs.writeFile(args[args.indexOf('-of')+1]+'.json',JSON.stringify({transcription:[{offsets:{from:2000},text:'Second chunk'}]}));}
 };
 const job={parts:['[00:00:00] Saved first chunk']};await r.transcribe(job,'/fixture.m4a',async()=>{});assert.equal(whisperCalls,1);assert(job.transcript.includes('Saved first chunk'));assert(job.transcript.includes('[00:05:02] Second chunk'));assert.equal(job.transcribed,true);
});
test('incompatible native recorder is rejected before any recording starts',()=>{const h=harness();delete h.recorder.saveRecording;assert.throws(()=>h.p.recorder(),/unavailable/);assert.equal(h.p.state.session,null);});
test('audio embedding preserves unsaved editor changes',async()=>{
 const h=harness();let editorText='Unsaved user writing';const editor={getValue:()=>editorText,lastLine:()=>0,getLine:()=>editorText,replaceRange:text=>{editorText+=text;}};
 h.p.app.workspace.getLeavesOfType=()=>[{view:{file:h.source,editor}}];await h.p.toggleRecording();await h.p.toggleRecording();await h.recorder.saveRecording(Buffer.from('audio'));
 assert(editorText.startsWith('Unsaved user writing'));assert(editorText.includes('Recording'));assert.equal(h.texts.get(h.source.path),'Original text');
});
